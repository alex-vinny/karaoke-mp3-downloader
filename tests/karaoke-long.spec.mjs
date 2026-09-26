// Long videos (Phase 8): a video of an hour or more, end to end — the time it takes,
// the memory the browser uses while it runs, and the file it leaves behind. Opt-in,
// because it downloads a gigabyte or so:
//   KMD_LONG=1 npx playwright test tests/karaoke-long.spec.mjs
// KMD_LONG_VIDEO=<id> picks the video. Otherwise a YouTube search for KMD_LONG_QUERY
// (default: a karaoke mix) is made and the shortest result of at least KMD_LONG_MIN
// minutes (default 60) is used — the point is the length, not the content.
import { test, expect, chromium } from '@playwright/test';
import { parseFile } from 'music-metadata';
import { exec } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeMp4 } from './mp4-probe.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ext = path.join(root, 'extension');
const tmp = path.join(root, 'tests', '.tmp');
const downloads = path.join(tmp, 'downloads-long');
const LANG = process.env.KMD_LANG || 'pt-BR';
const profile = path.join(tmp, 'profile-' + LANG); // the main spec's profile: fewer bot checks
const localeDir = LANG.replace('-', '_') === 'en_US' ? 'en' : LANG.replace('-', '_');
const messages = JSON.parse(fs.readFileSync(path.join(ext, '_locales', localeDir, 'messages.json'), 'utf8'));
const msg = (key) => messages[key].message;
const MIN_MINUTES = Number(process.env.KMD_LONG_MIN || 60);

test.skip(!process.env.KMD_LONG, 'opt-in: KMD_LONG=1 (downloads a gigabyte or so)');

test(`a video of ${MIN_MINUTES}+ minutes is saved whole (${LANG})`, async ({}, testInfo) => {
  test.setTimeout(3 * 60 * 60_000);
  fs.mkdirSync(downloads, { recursive: true });
  for (const f of fs.readdirSync(downloads)) fs.rmSync(path.join(downloads, f), { recursive: true, force: true });

  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: false,
    viewport: { width: 1280, height: 800 },
    args: [
      `--disable-extensions-except=${ext}`,
      `--load-extension=${ext}`,
      '--disable-blink-features=AutomationControlled',
      '--autoplay-policy=no-user-gesture-required',
      `--lang=${LANG}`,
    ],
  });
  // This browser has no ad blocker, so do what uBlock's YouTube filters do: prune the
  // ad slots out of the player responses before the page sees them (an ad cancels the
  // capture, by design). Test-only; Dad's laptop runs uBO Lite in "Complete" mode.
  await context.addInitScript(() => {
    const KEYS = ['adPlacements', 'adSlots', 'playerAds', 'adBreakHeartbeatParams'];
    const prune = (o) => {
      if (o && typeof o === 'object') { for (const k of KEYS) if (k in o) delete o[k]; if (o.playerResponse) prune(o.playerResponse); }
      return o;
    };
    const parse = JSON.parse;
    JSON.parse = function (...a) { return prune(parse.apply(this, a)); };
    const json = Response.prototype.json;
    Response.prototype.json = function (...a) { return json.apply(this, a).then(prune); };
    let ipr;
    Object.defineProperty(window, 'ytInitialPlayerResponse', { configurable: true, get: () => ipr, set: (v) => { ipr = prune(v); } });
  });
  const memory = memorySampler();
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    page.on('console', (m) => { if (m.text().startsWith('[Karaoke downloader')) console.log('page:', m.text()); });
    const cdp = await context.newCDPSession(page);
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, eventsEnabled: true });

    let id = process.env.KMD_LONG_VIDEO;
    // Creative Commons results first: they seldom carry the mid-roll ads that cancel a
    // capture in this browser, which has no ad blocker (Dad's laptop has uBO Lite).
    const queries = process.env.KMD_LONG_QUERY ? [[process.env.KMD_LONG_QUERY, false]]
      : [['karaoke', true], ['full concert', true], ['lecture', true], ['1 hour karaoke', false], ['karaoke party 2 hours', false]];
    for (let i = 0; !id && i < queries.length; i++) id = await findLongVideo(page, queries[i][0], MIN_MINUTES, queries[i][1]);
    if (!id) throw new Error('no result of ' + MIN_MINUTES + '+ minutes for any of: ' + queries.join(' / '));
    console.log('video:', id);
    await page.goto('https://www.youtube.com/watch?v=' + id, { waitUntil: 'domcontentloaded' });
    await dismissConsent(page);
    const sw = await extensionWorker(context);
    await sw.evaluate(() => chrome.downloads.erase({}));

    const btn = page.getByTestId('karaoke-download');
    await expect(btn).toBeVisible({ timeout: 60_000 });
    await expect(btn).toBeEnabled({ timeout: 60_000 }); // an ad may be running on a fresh video
    await page.waitForFunction(() => (document.querySelector('video')?.duration ?? 0) > 0, null, { timeout: 60_000 });
    const info = await page.evaluate(() => ({
      title: document.title.replace(/ - YouTube$/, ''),
      duration: document.querySelector('video')?.duration ?? 0,
    }));
    console.log('title:', info.title, 'duration:', Math.round(info.duration), 's');
    expect(info.duration).toBeGreaterThan(MIN_MINUTES * 60 - 1);

    // the curtain's texts, from inside the page, with a timestamp
    await page.evaluate(() => {
      const log = (window.__kmd = { toasts: [], curtain: [], t0: performance.now() });
      const last = { toast: null, curtain: null };
      new MutationObserver(() => {
        const at = (performance.now() - log.t0) / 1000;
        const t = document.querySelector('#ytdl-toast .ytdl-toast-txt')?.textContent || null;
        if (t && t !== last.toast) { last.toast = t; log.toasts.push({ at, text: t }); }
        const c = document.querySelector('#ytdl-curtain .ytdl-curtain-txt')?.textContent || null;
        if (c && c !== last.curtain) { last.curtain = c; log.curtain.push({ at, text: c }); }
      }).observe(document.documentElement, { subtree: true, childList: true, characterData: true });
    });
    memory.start();
    const toastText = page.locator('#ytdl-toast .ytdl-toast-txt');
    let t0, log, clickToDone;
    for (let attempt = 1; ; attempt++) {
    await page.evaluate(() => { window.__kmd.toasts = []; window.__kmd.curtain = []; window.__kmd.t0 = performance.now(); });
    t0 = Date.now();
    await btn.click();
    const progress = setInterval(async () => {
      try {
        const c = await page.locator('#ytdl-curtain .ytdl-curtain-txt').textContent({ timeout: 1000 });
        console.log(`[${Math.round((Date.now() - t0) / 1000)} s] ${c}  |  ${memory.last()}`);
      } catch { /* curtain gone */ }
    }, 30_000);
    try {
      await expect
        .poll(() => toastText.textContent(), { message: 'toast reaches done or an error', timeout: 170 * 60_000, intervals: [1000] })
        .toMatch(new RegExp('^(' + [msg('done'), msg('adDetected'), msg('error').split(' (')[0]].map(escapeRe).join('|') + ')'));
    } finally {
      clearInterval(progress);
    }
    clickToDone = (Date.now() - t0) / 1000;
    log = await page.evaluate(() => window.__kmd);
    console.log('toasts:', JSON.stringify(log.toasts));
    const texts = log.toasts.map((e) => e.text);
    // An ad in the middle of a long video cancels the capture, as designed. Let the ad
    // play out and try again, a few times (YouTube rarely repeats the same break).
    if (texts[texts.length - 1] === msg('adDetected') && attempt < 4) {
      console.log('attempt ' + attempt + ': an ad interrupted the capture at ' + Math.round(clickToDone) + ' s; waiting for it to end, then again');
      await expect(btn).toBeEnabled({ timeout: 5 * 60_000 });
      await page.waitForTimeout(5_000);
      continue;
    }
    expect(texts, 'the toast reports success').toEqual([msg('done')]);
    break;
    }
    const preparingAt = log.curtain.find((e) => e.text.startsWith(msg('preparing').split('$1')[0]))?.at ?? null;

    // the file: chrome.downloads (technique B), then the probes; writing gigabytes takes a while
    let items = [];
    await expect
      .poll(async () => {
        items = await sw.evaluate(() => chrome.downloads.search({ orderBy: ['-startTime'] }));
        return items.map((i) => i.state).join(',');
      }, { message: 'chrome.downloads shows a completed item', timeout: 15 * 60_000, intervals: [2000] })
      .toContain('complete');
    memory.stop();
    const done = items[0];
    expect(fs.existsSync(done.filename), `file exists: ${done.filename}`).toBe(true);
    const bytes = fs.statSync(done.filename).size;
    const boxes = probeMp4(done.filename);
    const meta = await parseFile(done.filename);
    const play = await probePlayback(context, done.filename);
    const summary = {
      lang: LANG, video: id, title: info.title, sourceSeconds: info.duration, savedAs: done.filename, bytes,
      mb: Math.round(bytes / 1048576), seconds: { clickToDone, preparingAt, downloadComplete: (Date.now() - t0) / 1000 },
      memory: memory.summary(), boxes, container: meta.format.container, duration: meta.format.duration,
      titleTag: meta.common.title ?? null, artistTag: meta.common.artist ?? null, playback: play, curtain: log.curtain.slice(-5),
    };
    console.log('result:', JSON.stringify(summary, null, 2));
    fs.writeFileSync(testInfo.outputPath('result.json'), JSON.stringify(summary, null, 2));

    expect(boxes.video, 'video codec').toBe('avc1');
    expect(boxes.audio, 'audio codec').toBe('mp4a');
    expect(boxes.height, 'height').toBe(720);
    expect(Math.abs(meta.format.duration - info.duration), 'duration matches the source (± 5 s)').toBeLessThan(5);
    expect(play.error, 'no media error').toBeNull();
    expect(Math.abs(play.duration - info.duration), 'Chromium sees the whole duration').toBeLessThan(5);
    expect(play.seekedTo, 'seek to the middle landed').toBeGreaterThan(play.duration / 2 - 1);
    expect(play.advanced, 'plays on after the seek').toBe(true);
    expect(play.nearEnd.advanced, 'plays near the end too').toBe(true);
  } finally {
    memory.stop();
    await context.close();
  }
});

// The shortest result of at least `minMinutes` for a YouTube search, read from
// ytInitialData (the results page's own JSON) rather than from its ever-changing DOM.
async function findLongVideo(page, query, minMinutes, creativeCommons) {
  // sp: YouTube's search filters. EgIYAg%3D%3D = "Duration: over 20 minutes" (EgIYAw is
  // 4–20 minutes); EgQYAjAB = the same plus "Features: Creative Commons".
  const sp = creativeCommons ? 'EgQYAjAB' : 'EgIYAg%3D%3D';
  await page.goto('https://www.youtube.com/results?search_query=' + encodeURIComponent(query) + '&sp=' + sp, { waitUntil: 'domcontentloaded' });
  await dismissConsent(page);
  await page.waitForFunction(() => !!window.ytInitialData, null, { timeout: 30_000 });
  await page.waitForSelector('ytd-video-renderer, yt-lockup-view-model', { timeout: 30_000 }).catch(() => {});
  const found = await page.evaluate(() => {
    const out = new Map();
    const dur = (s) => (typeof s === 'string' && /^\d{1,2}:\d{2}(:\d{2})?$/.test(s.trim()) ? s.trim() : null);
    // 1) the page's JSON: the classic videoRenderer, or the newer lockupViewModel
    (function walk(o, depth) {
      if (!o || typeof o !== 'object' || depth > 60) return;
      if (o.videoRenderer && o.videoRenderer.videoId) {
        const r = o.videoRenderer;
        out.set(r.videoId, { id: r.videoId, len: r.lengthText?.simpleText ?? '', title: r.title?.runs?.[0]?.text ?? '' });
      } else if (o.lockupViewModel && o.lockupViewModel.contentId) {
        const r = o.lockupViewModel;
        let len = '';
        JSON.stringify(r.contentImage ?? null, (k, v) => { if (!len && dur(v)) len = v.trim(); return v; });
        out.set(r.contentId, { id: r.contentId, len, title: r.metadata?.lockupMetadataViewModel?.title?.content ?? '' });
      }
      for (const k in o) walk(o[k], depth + 1);
    })(window.ytInitialData, 0);
    // 2) the DOM: a duration badge inside a card that links to a video
    for (const el of document.querySelectorAll('span, div')) {
      if (el.children.length) continue;
      const d = dur(el.textContent);
      if (!d) continue;
      const card = el.closest('ytd-video-renderer, yt-lockup-view-model, ytd-rich-item-renderer, ytd-compact-video-renderer');
      const a = card && card.querySelector('a[href*="/watch?v="]');
      const id = a && new URL(a.href).searchParams.get('v');
      if (!id) continue;
      const title = (card.querySelector('#video-title, .yt-lockup-metadata-view-model__title')?.textContent || '').trim();
      if (!out.has(id)) out.set(id, { id, len: d, title });
      else if (!out.get(id).len) out.get(id).len = d;
    }
    return [...out.values()];
  });
  const seconds = (s) => (s ? s.split(':').map(Number).reduce((a, n) => a * 60 + n, 0) : 0);
  const long = found.filter((v) => seconds(v.len) >= minMinutes * 60).sort((a, b) => seconds(a.len) - seconds(b.len));
  console.log('"' + query + '"' + (creativeCommons ? ' (CC)' : '') + ': results', found.length, 'candidates:', JSON.stringify(long.slice(0, 5)));
  return long.length ? long[0].id : null;
}

// Working set of the test browser's processes (Playwright's chromium.exe lives under
// ms-playwright, which tells it apart from the user's own Chrome), sampled every 15 s.
function memorySampler() {
  const samples = [];
  let timer = null, busy = false;
  const ps = 'Get-CimInstance Win32_Process -Filter "Name = \'chrome.exe\'" | Where-Object { $_.ExecutablePath -like \'*ms-playwright*\' } | ForEach-Object { $t = if ($_.CommandLine -match \'--type=(\\w+)\') { $Matches[1] } else { \'browser\' }; if ($_.CommandLine -match \'--extension-process\') { $t = \'extension\' }; \'{0}:{1}\' -f $t, [math]::Round($_.WorkingSetSize / 1MB) }';
  const sample = () => {
    if (busy) return;
    busy = true;
    exec(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, { windowsHide: true }, (err, stdout) => {
      busy = false;
      if (err) return;
      const procs = stdout.trim().split(/\r?\n/).filter(Boolean).map((l) => { const [type, mb] = l.split(':'); return { type, mb: Number(mb) }; });
      const total = procs.reduce((a, p) => a + p.mb, 0);
      const top = procs.sort((a, b) => b.mb - a.mb).slice(0, 3);
      samples.push({ at: Date.now(), total, top });
    });
  };
  return {
    start() { sample(); timer = setInterval(sample, 15_000); },
    stop() { if (timer) clearInterval(timer); timer = null; },
    last() { const s = samples[samples.length - 1]; return s ? `RAM ${s.total} MB (${s.top.map((p) => p.type + ' ' + p.mb).join(', ')})` : 'RAM ?'; },
    summary() {
      if (!samples.length) return null;
      const peak = samples.reduce((a, s) => (s.total > a.total ? s : a));
      return { samples: samples.length, peakTotalMb: peak.total, peakTop: peak.top, first: samples[0], last: samples[samples.length - 1] };
    },
  };
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

async function probePlayback(context, file) {
  const page = await context.newPage();
  try {
    await page.goto('file:///' + file.replace(/\\/g, '/'));
    return await page.evaluate(async () => {
      const v = document.querySelector('video');
      if (!v) return { error: 'no <video> on the media page' };
      const wait = (ev, ms) => new Promise((r) => {
        const t = setTimeout(() => r(false), ms);
        v.addEventListener(ev, () => { clearTimeout(t); r(true); }, { once: true });
      });
      const playsFrom = async (t) => {
        v.currentTime = t;
        await wait('seeked', 20000);
        const seekedTo = v.currentTime;
        await v.play().catch(() => {});
        const t0 = v.currentTime;
        await new Promise((r) => setTimeout(r, 2000));
        const advanced = v.currentTime > t0 + 0.5;
        v.pause();
        return { seekedTo, advanced };
      };
      if (v.readyState < 1) await wait('loadedmetadata', 30000);
      v.muted = true;
      const out = { duration: v.duration, width: v.videoWidth, height: v.videoHeight, error: v.error ? v.error.message : null };
      Object.assign(out, await playsFrom(v.duration / 2));
      out.nearEnd = await playsFrom(Math.max(0, v.duration - 30));
      out.error = v.error ? v.error.message : out.error;
      return out;
    });
  } finally {
    await page.close();
  }
}

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
