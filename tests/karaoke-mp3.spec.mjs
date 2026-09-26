// Main end-to-end scenario: the modified extension, loaded unpacked into
// Playwright's Chromium, downloads the test video as a tagged MP3 with one click.
// Runs locally only (YouTube blocks datacenter IPs). Language of the browser UI —
// and therefore of the extension — comes from KMD_LANG (default pt-BR); the
// expected strings are read from the extension's own _locales, so the same spec
// checks both languages: `KMD_LANG=en-US npx playwright test`.
import { test, expect, chromium } from '@playwright/test';
import { parseFile } from 'music-metadata';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ext = path.join(root, 'extension');
const tmp = path.join(root, 'tests', '.tmp');
const downloads = path.join(tmp, 'downloads');
const LANG = process.env.KMD_LANG || 'pt-BR';
const profile = path.join(tmp, 'profile-' + LANG);   // reused between runs: fewer bot checks
const VIDEO = 'https://www.youtube.com/watch?v=jNQXAC9IVRw'; // "Me at the zoo", 19 s
const VIDEO_TITLE = 'Me at the zoo';

const messages = JSON.parse(fs.readFileSync(path.join(ext, '_locales', LANG.replace('-', '_') === 'en_US' ? 'en' : LANG.replace('-', '_'), 'messages.json'), 'utf8'));
const msg = (key) => messages[key].message;

test(`one click saves "${VIDEO_TITLE}" as a tagged MP3 (${LANG})`, async ({}, testInfo) => {
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
    const suggested = [];
    page.on('download', (d) => suggested.push(d.suggestedFilename()));

    await page.goto(VIDEO, { waitUntil: 'domcontentloaded' });
    await dismissConsent(page);

    // 1. the button, in the right language
    const btn = page.getByTestId('karaoke-mp3-download');
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
    await btn.click();
    const toastText = page.locator('#ytdl-toast .ytdl-toast-txt');
    await expect(toastText).toBeVisible({ timeout: 15_000 });
    await expect(btn).toBeDisabled();
    const seen = [];
    await expect
      .poll(async () => {
        const txt = (await toastText.textContent()) ?? '';
        if (seen[seen.length - 1] !== txt) seen.push(txt);
        return txt;
      }, { message: 'toast reaches done or an error', timeout: 3 * 60_000, intervals: [1000] })
      .toMatch(new RegExp('^(' + [msg('done'), msg('adDetected'), msg('error').split(' (')[0]].map(escapeRe).join('|') + ')'));
    await page.screenshot({ path: testInfo.outputPath('02-toast.png') });
    console.log('toast history:', JSON.stringify(seen, null, 2));
    expect(seen[seen.length - 1], 'success toast').toBe(msg('done'));
    expect(seen.some((s) => s.includes(msg('keepTabOpen'))), '"keep tab open" shown while running').toBe(true);

    // 3. what the extension asked Chrome to save, and the "Open folder" action
    const requested = await page.locator('#ytdl-toast').getAttribute('data-filename');
    expect(requested).toBe(`${msg('songsFolder')}/${VIDEO_TITLE}.mp3`);
    const openFolder = page.getByTestId('karaoke-mp3-open-folder');
    await expect(openFolder).toBeVisible();
    await expect(openFolder).toHaveText(msg('openFolder'));
    await expect(btn).toBeEnabled();

    // 4. the file itself, via the extension's service worker (technique B)
    const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 10_000 }));
    let items = [];
    await expect
      .poll(async () => {
        items = await sw.evaluate(() => chrome.downloads.search({}));
        return items.map((i) => i.state).join(',');
      }, { message: 'chrome.downloads shows a completed item', timeout: 30_000 })
      .toContain('complete');
    const done = items.find((i) => i.state === 'complete');
    expect(fs.existsSync(done.filename), `file exists: ${done.filename}`).toBe(true);
    const meta = await parseFile(done.filename);
    const summary = {
      lang: LANG, requested, suggestedByPlaywright: suggested, savedAs: done.filename, bytes: fs.statSync(done.filename).size,
      container: meta.format.container, codec: meta.format.codec, duration: meta.format.duration,
      title: meta.common.title ?? null, artist: meta.common.artist ?? null, toasts: seen,
    };
    console.log('result:', JSON.stringify(summary, null, 2));
    fs.writeFileSync(testInfo.outputPath('result.json'), JSON.stringify(summary, null, 2));
    expect(meta.format.container).toBe('MPEG');
    expect(meta.format.duration).toBeGreaterThan(17);
    expect(meta.format.duration).toBeLessThan(21);
    expect(meta.common.title, 'ID3 title tag').toBe(VIDEO_TITLE);
  } finally {
    await context.close();
  }
});

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

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
