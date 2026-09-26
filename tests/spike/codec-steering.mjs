// Phase 6 spike (see specs/PLAN.md §4): can we steer YouTube into serving H.264
// video (and AAC audio) simply by telling it the browser cannot decode VP9/AV1
// (and Opus)? That is the h264ify technique; the extension already uses it for
// AV1. If it works, a video download is a stream copy (seconds) instead of a
// single-thread libx264 re-encode (tens of minutes).
//
// Runs WITHOUT the extension: an init script patches the codec probes and logs
// which MIME types the player then feeds into its SourceBuffers.
//
//   node tests/spike/codec-steering.mjs [none|novp9|noopus] [videoId ...]
//
//   none    baseline — expect vp09/av01 + opus
//   novp9   block AV1 + VP9 + VP8 — expect avc1 + opus
//   noopus  block AV1 + VP9 + VP8 + Opus — expect avc1 + mp4a.40.2
import { chromium } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MODE = process.argv[2] || 'noopus';
const BLOCK = {
  none: null,
  novp9: 'av01|av1\\b|vp09|vp9|vp8',
  noopus: 'av01|av1\\b|vp09|vp9|vp8|opus',
}[MODE];
if (BLOCK === undefined) { console.error('mode must be none | novp9 | noopus'); process.exit(2); }
const ids = process.argv.slice(3).length ? process.argv.slice(3) : ['jNQXAC9IVRw'];
const profile = path.join(root, 'tests', '.tmp', 'profile-spike');

const context = await chromium.launchPersistentContext(profile, {
  channel: 'chromium',
  headless: false,
  viewport: { width: 1280, height: 800 },
  args: [
    '--disable-blink-features=AutomationControlled',
    '--autoplay-policy=no-user-gesture-required',
    '--lang=pt-BR',
  ],
});
await context.addInitScript((block) => {
  window.__kmd = { mimes: [], probes: [], mc: [] };
  const re = block ? new RegExp(block, 'i') : null;
  const blocked = (s) => !!(re && typeof s === 'string' && re.test(s));
  try {
    const orig = MediaSource.isTypeSupported.bind(MediaSource);
    MediaSource.isTypeSupported = (t) => { const r = blocked(t) ? false : orig(t); window.__kmd.probes.push(t + ' -> ' + r); return r; };
  } catch (e) {}
  try {
    const proto = HTMLMediaElement.prototype; const orig = proto.canPlayType;
    proto.canPlayType = function (t) { return blocked(t) ? '' : orig.call(this, t); };
  } catch (e) {}
  try {
    const orig = MediaSource.prototype.addSourceBuffer;
    MediaSource.prototype.addSourceBuffer = function (t) { window.__kmd.mimes.push(t); return orig.call(this, t); };
  } catch (e) {}
  try {
    // only observed, not patched: does the player also ask MediaCapabilities?
    const mc = navigator.mediaCapabilities; const orig = mc.decodingInfo.bind(mc);
    mc.decodingInfo = (cfg) => { try { window.__kmd.mc.push(JSON.stringify(cfg && (cfg.video || cfg.audio))); } catch (e) {} return orig(cfg); };
  } catch (e) {}
}, BLOCK);

const results = [];
try {
  const page = context.pages()[0] ?? (await context.newPage());
  for (const id of ids) {
    const url = 'https://www.youtube.com/watch?v=' + id;
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    const consent = page.getByRole('button', { name: /accept all|aceitar tudo|i agree|concordo|reject all|rejeitar tudo/i }).first();
    try { await consent.click({ timeout: 4_000 }); } catch {}
    await page.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 2, null, { timeout: 30_000 }).catch(() => {});
    await page.evaluate(() => document.querySelector('video')?.play().catch(() => {}));
    await page.waitForTimeout(6_000);

    const snapshot = (label) => page.evaluate((label) => {
      const p = document.getElementById('movie_player');
      const v = document.querySelector('video');
      let stats = null;
      try { stats = p && p.getStatsForNerds && p.getStatsForNerds(); } catch (e) {}
      return {
        label,
        title: p && p.getVideoData ? p.getVideoData().title : document.title,
        qualities: p && p.getAvailableQualityLevels ? p.getAvailableQualityLevels() : null,
        quality: p && p.getPlaybackQuality ? p.getPlaybackQuality() : null,
        size: v ? v.videoWidth + 'x' + v.videoHeight : null,
        codecs: stats && stats.codecs,
        mimes: [...new Set(window.__kmd.mimes)],
        probes: window.__kmd.probes.length,
        mediaCapabilities: [...new Set(window.__kmd.mc)].slice(0, 12),
      };
    }, label);

    const first = await snapshot('auto quality');
    // what the extension will ask for: 720p, then a real seek so both tracks re-fetch
    await page.evaluate(() => {
      const p = document.getElementById('movie_player');
      try { p.setPlaybackQualityRange('hd720', 'hd720'); p.setPlaybackQuality('hd720'); } catch (e) {}
      try { p.seekTo(Math.min(20, Math.max(2, p.getDuration() - 5)), true); } catch (e) {}
    });
    await page.waitForTimeout(5_000);
    const after = await snapshot('after hd720 + seek');
    results.push({ mode: MODE, id, url, first, after });
    console.log(JSON.stringify(results[results.length - 1], null, 2));
  }
} finally {
  await context.close();
}
