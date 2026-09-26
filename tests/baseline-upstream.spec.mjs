// Phase 0 spike: prove the UNMODIFIED upstream extension saves an MP3 inside
// Playwright's Chromium, and learn how to observe the download it triggers:
// technique A = CDP Browser.setDownloadBehavior (keeps the extension's file name),
// technique B = chrome.downloads.search() evaluated in the extension's service worker.
import { test, expect, chromium } from '@playwright/test';
import { parseFile } from 'music-metadata';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ext = path.join(root, 'extension');
const tmp = path.join(root, 'tests', '.tmp');
const profile = path.join(tmp, 'profile');      // reused between runs: fewer bot checks
const downloads = path.join(tmp, 'downloads');
const VIDEO = 'https://www.youtube.com/watch?v=jNQXAC9IVRw'; // "Me at the zoo", 19 s

test('upstream Triangle-Downloader saves an MP3 of the test video', async ({}, testInfo) => {
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
    ],
  });
  try {
    const page = context.pages()[0] ?? (await context.newPage());

    // Technique A: let the browser write files under our folder with their real names.
    const cdp = await context.newCDPSession(page);
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, eventsEnabled: true });
    const cdpEvents = [];
    cdp.on('Browser.downloadWillBegin', (e) => cdpEvents.push({ type: 'begin', ...e }));
    cdp.on('Browser.downloadProgress', (e) => { if (e.state !== 'inProgress') cdpEvents.push({ type: e.state, guid: e.guid }); });

    await page.goto(VIDEO, { waitUntil: 'domcontentloaded' });
    await dismissConsent(page);

    const btn = page.locator('#ytdl-btn');
    await expect(btn, 'upstream button in the player controls').toBeVisible({ timeout: 60_000 });
    await ensurePlaying(page);
    await page.screenshot({ path: testInfo.outputPath('01-button.png') });

    await btn.click();
    const mp3Item = page.locator('.ytdl-menu .ytdl-menu-item', { has: page.locator('b', { hasText: /^MP3$/ }) });
    await expect(mp3Item).toBeVisible({ timeout: 10_000 });
    await page.screenshot({ path: testInfo.outputPath('02-menu.png') });
    await mp3Item.click();

    const toast = page.locator('#ytdl-toast .ytdl-toast-txt');
    await expect(toast).toBeVisible({ timeout: 15_000 });
    const seen = [];
    await expect
      .poll(async () => {
        const txt = (await toast.textContent()) ?? '';
        if (seen[seen.length - 1] !== txt) seen.push(txt);
        return txt;
      }, { message: 'toast reaches Готово (done) or Ошибка (error)', timeout: 3 * 60_000, intervals: [1000] })
      .toMatch(/^(Готово|Ошибка)/);
    const finalToast = seen[seen.length - 1];
    await page.screenshot({ path: testInfo.outputPath('03-toast.png') });
    console.log('toast history:', JSON.stringify(seen, null, 2));
    expect(finalToast, 'extension reported success').toMatch(/^Готово/);

    // Technique B: what chrome.downloads recorded, straight from the service worker.
    const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 10_000 }));
    let items = [];
    await expect
      .poll(async () => {
        items = await sw.evaluate(() => chrome.downloads.search({}));
        return items.map((i) => i.state).join(',');
      }, { message: 'chrome.downloads shows a completed item', timeout: 30_000 })
      .toContain('complete');
    const brief = items.map(({ id, filename, state, bytesReceived, mime, error }) => ({ id, filename, state, bytesReceived, mime, error }));
    console.log('chrome.downloads:', JSON.stringify(brief, null, 2));
    console.log('cdp events:', JSON.stringify(cdpEvents, null, 2));

    const done = items.find((i) => i.state === 'complete');
    const filePath = done.filename;
    expect(fs.existsSync(filePath), `file exists: ${filePath}`).toBe(true);
    expect(path.dirname(filePath).toLowerCase(), 'saved under the CDP download path (technique A)').toBe(downloads.toLowerCase());
    expect(path.extname(filePath).toLowerCase()).toBe('.mp3');
    const meta = await parseFile(filePath);
    const summary = {
      file: filePath, bytes: fs.statSync(filePath).size,
      container: meta.format.container, codec: meta.format.codec, duration: meta.format.duration,
      title: meta.common.title ?? null, finalToast, cdpEvents, downloads: brief,
    };
    console.log('mp3:', JSON.stringify(summary, null, 2));
    fs.writeFileSync(testInfo.outputPath('result.json'), JSON.stringify(summary, null, 2));
    expect(meta.format.duration).toBeGreaterThan(17);
    expect(meta.format.duration).toBeLessThan(21);
  } finally {
    await context.close();
  }
});

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
