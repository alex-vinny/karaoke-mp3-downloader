// End-to-end scenarios: the modified extension, loaded unpacked into Playwright's
// Chromium, saves a YouTube video as a tagged 720p .mp4 (H.264 + AAC) with one click.
// Runs locally only (YouTube blocks datacenter IPs). Language of the browser UI —
// and therefore of the extension — comes from KMD_LANG (default pt-BR); the expected
// strings are read from the extension's own _locales, so the same spec checks both
// languages: `KMD_LANG=en-US npx playwright test`.
//
//   1. "Me at the zoo" (19 s, 240p): the UI, the toasts, the file and its tags — fast.
//   2. "Caminandes 3: Llamigos" (2:30, 720p, CC-BY Blender): the real 720p path, timed.
import { test, expect, chromium } from '@playwright/test';
import { parseFile } from 'music-metadata';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeFilename } from '../extension/filename.js';
import { probeMp4 } from './mp4-probe.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ext = path.join(root, 'extension');
const tmp = path.join(root, 'tests', '.tmp');
const downloads = path.join(tmp, 'downloads');
const LANG = process.env.KMD_LANG || 'pt-BR';
const profile = path.join(tmp, 'profile-' + LANG);   // reused between runs: fewer bot checks

const localeDir = LANG.replace('-', '_') === 'en_US' ? 'en' : LANG.replace('-', '_');
const messages = JSON.parse(fs.readFileSync(path.join(ext, '_locales', localeDir, 'messages.json'), 'utf8'));
const msg = (key) => messages[key].message;

const ZOO = { id: 'jNQXAC9IVRw', title: 'Me at the zoo', duration: [17, 21], size: [320, 240] };
const LLAMAS = { id: 'SkVqJ1SGeL0', title: 'Caminandes 3: Llamigos', duration: [140, 160], size: [1280, 720] };

test(`one click saves "${ZOO.title}" as a tagged H.264/AAC .mp4 (${LANG})`, async ({}, testInfo) => {
  await scenario(ZOO, testInfo);
});

test(`a real 720p video: "${LLAMAS.title}" (${LANG})`, async ({}, testInfo) => {
  test.setTimeout(10 * 60_000);
  await scenario(LLAMAS, testInfo);
});

async function scenario(video, testInfo) {
  const url = 'https://www.youtube.com/watch?v=' + video.id;
  fs.mkdirSync(downloads, { recursive: true });
  for (const f of fs.readdirSync(downloads)) fs.rmSync(path.join(downloads, f), { recursive: true, force: true });

  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: false,
    viewport: { width: 1280, height: 800 },
    recordVideo: { dir: testInfo.outputPath('video') },
    args: [
      `--disable-extensions-except=${ext}`,
      `--load-extension=${ext}`,
      '--disable-blink-features=AutomationControlled',
      '--autoplay-policy=no-user-gesture-required',
      `--lang=${LANG}`,
    ],
  });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    const cdp = await context.newCDPSession(page);
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, eventsEnabled: true });

    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await dismissConsent(page);
    // the profile is reused between runs: forget earlier downloads so step 4 sees only this one
    const sw = await extensionWorker(context);
    await sw.evaluate(() => chrome.downloads.erase({}));

    // 1. the button, in the right language
    const btn = page.getByTestId('karaoke-download');
    await expect(btn).toBeVisible({ timeout: 60_000 });
    await expect(btn).toHaveText(msg('button'));
    await expect(btn).toBeEnabled();
    await ensurePlaying(page);
    // the control bar auto-hides; pin it for the screenshot (evidence for the README)
    await btn.hover();
    await page.evaluate(() => document.getElementById('movie_player')?.classList.remove('ytp-autohide'));
    await page.waitForTimeout(300);
    await page.locator('#movie_player').screenshot({ path: testInfo.outputPath('01-button.png') });

    // 2. one click; a second click while busy is ignored (button disabled)
    const t0 = Date.now();
    const times = {};
    await btn.click();
    const toastText = page.locator('#ytdl-toast .ytdl-toast-txt');
    await expect(toastText).toBeVisible({ timeout: 15_000 });
    await expect(btn).toBeDisabled();
    const seen = [];
    const toastBox = page.locator('#ytdl-toast');
    const shots = { downloading: false, converting: false };
    await expect
      .poll(async () => {
        const txt = (await toastText.textContent()) ?? '';
        if (seen[seen.length - 1] !== txt) seen.push(txt);
        // evidence for the README: the toast while downloading and while saving
        for (const phase of ['downloading', 'converting']) {
          if (!shots[phase] && txt.startsWith(msg(phase).split('$1')[0].split('…')[0])) {
            shots[phase] = true;
            times[phase + 'At'] = (Date.now() - t0) / 1000;
            await toastBox.screenshot({ path: testInfo.outputPath(`02-toast-${phase}.png`) }).catch(() => {});
          }
        }
        return txt;
      }, { message: 'toast reaches done or an error', timeout: 8 * 60_000, intervals: [500] })
      .toMatch(new RegExp('^(' + [msg('done'), msg('adDetected'), msg('error').split(' (')[0]].map(escapeRe).join('|') + ')'));
    times.doneAt = (Date.now() - t0) / 1000;
    await page.waitForTimeout(300);
    await toastBox.screenshot({ path: testInfo.outputPath('03-toast-done.png') });
    await page.screenshot({ path: testInfo.outputPath('04-page-done.png') });
    console.log('toast history:', JSON.stringify(seen, null, 2));
    expect(seen[seen.length - 1], 'success toast').toBe(msg('done'));
    expect(seen.some((s) => s.includes(msg('keepTabOpen'))), '"keep tab open" shown while running').toBe(true);

    // 3. what the extension asked Chrome to save, and the "Open folder" action
    const requested = await toastBox.getAttribute('data-filename');
    expect(requested).toBe(`${msg('songsFolder')}/${safeFilename(video.title)}.mp4`);
    const openFolder = page.getByTestId('karaoke-open-folder');
    await expect(openFolder).toBeVisible();
    await expect(openFolder).toHaveText(msg('openFolder'));
    await expect(btn).toBeEnabled();

    // 4. the file itself, via the extension's service worker (technique B)
    let items = [];
    await expect
      .poll(async () => {
        items = await sw.evaluate(() => chrome.downloads.search({ orderBy: ['-startTime'] }));
        return items.map((i) => i.state).join(',');
      }, { message: 'chrome.downloads shows a completed item', timeout: 30_000 })
      .toContain('complete');
    expect(items.length, 'exactly one download in this run').toBe(1);
    const done = items[0];
    expect(fs.existsSync(done.filename), `file exists: ${done.filename}`).toBe(true);
    const boxes = probeMp4(done.filename);
    const meta = await parseFile(done.filename);
    const summary = {
      lang: LANG, video: video.id, requested, savedAs: done.filename, bytes: fs.statSync(done.filename).size,
      seconds: times, boxes, container: meta.format.container, codec: meta.format.codec, duration: meta.format.duration,
      title: meta.common.title ?? null, artist: meta.common.artist ?? null, toasts: seen,
    };
    console.log('result:', JSON.stringify(summary, null, 2));
    fs.writeFileSync(testInfo.outputPath('result.json'), JSON.stringify(summary, null, 2));
    // H.264 + AAC in an MP4 that plays everywhere (no re-encode: the hook steered YouTube)
    expect(boxes.video, 'video codec').toBe('avc1');
    expect(boxes.audio, 'audio codec').toBe('mp4a');
    expect([boxes.width, boxes.height], 'video size').toEqual(video.size);
    expect(meta.format.container).toMatch(/mp4|isom|m4a|mp42/i);
    expect(meta.format.duration).toBeGreaterThan(video.duration[0]);
    expect(meta.format.duration).toBeLessThan(video.duration[1]);
    expect(meta.common.title, 'title tag').toBe(video.title);
  } finally {
    await context.close();
  }
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// The extension's background worker (YouTube registers its own service worker too).
async function extensionWorker(context) {
  const isOurs = (w) => w.url().startsWith('chrome-extension://');
  const found = context.serviceWorkers().find(isOurs);
  if (found) return found;
  return context.waitForEvent('serviceworker', { predicate: isOurs, timeout: 15_000 });
}

async function dismissConsent(page) {
  const btn = page.getByRole('button', { name: /accept all|aceitar tudo|i agree|concordo|reject all|rejeitar tudo/i }).first();
  try { await btn.click({ timeout: 5_000 }); } catch { /* no consent dialog */ }
}

async function ensurePlaying(page) {
  await page.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 2, null, { timeout: 30_000 }).catch(() => {});
  const paused = () => page.evaluate(() => document.querySelector('video')?.paused ?? true);
  if (await paused()) {
    await page.evaluate(() => document.querySelector('video')?.play().catch(() => {}));
    await page.waitForTimeout(1_000);
    if (await paused()) await page.locator('.ytp-play-button').click({ timeout: 5_000 }).catch(() => {});
  }
}
