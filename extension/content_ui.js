// content_ui.js — isolated world. Draws the one "Download video" button in the
// YouTube player, drives the MAIN-world capture hook over window.postMessage and
// relays the captured pieces, as they arrive, to the offscreen page that writes
// the file (mp4mux.js, ffmpeg.wasm for the fallbacks).
// While the hook captures, a curtain covers the player (see "curtain" below).
// Upstream's menu (quality, MP3, subtitles, format toggle) is kept below as
// openMenu() but is no longer reachable from the UI; the MP3 path still works.
(function () {
  const BTN_ID = 'ytdl-btn';
  const VERSION = chrome.runtime.getManifest().version;
  // All visible text comes from _locales; Chrome picks the browser's UI language.
  const t = (key, subs) => chrome.i18n.getMessage(key, subs == null ? undefined : [].concat(subs).map(String)) || key;
  let busy = false;             // a capture is running: ignore clicks, keep the button disabled
  let cancelledByAd = false;    // the ad watcher stopped the current capture
  // Clips up to this length get an exact (re-encoded) cut; longer ones are copied
  // instantly and start at the keyframe before the requested point. Re-encoding costs
  // roughly the clip's own length at 1080p, so ~1 minute is a comfortable ceiling.
  const EXACT_CUT_MAX_SEC = 60;
  let reqSeq = 1;
  const pending = new Map();

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data || ev.data.__ytdl_from_hook !== true) return;
    const p = pending.get(ev.data.reqId);
    if (p) p(ev.data);
  });
  function callHook(cmd, extra) {
    return new Promise((resolve) => {
      const reqId = reqSeq++;
      pending.set(reqId, resolve);
      window.postMessage(Object.assign({ __ytdl_to_hook: true, cmd, reqId }, extra || {}), '*');
    });
  }
  // download drives streaming progress, the captured pieces (`segment`) + a final result
  function download(params, onProgress, onSegment) {
    return new Promise((resolve, reject) => {
      const reqId = reqSeq++;
      const handler = (ev) => {
        if (ev.source !== window || !ev.data || ev.data.__ytdl_from_hook !== true || ev.data.reqId !== reqId) return;
        const d = ev.data;
        if (d.segment) { onSegment(d); return; }
        if (d.progress != null && !d.done) { onProgress(d); return; }
        window.removeEventListener('message', handler);
        if (d.ok && d.done) resolve(d); else reject(new Error(d.error || 'capture failed'));
      };
      window.addEventListener('message', handler);
      window.postMessage(Object.assign({ __ytdl_to_hook: true, cmd: 'download', reqId }, params), '*');
    });
  }

  // ---- time helpers --------------------------------------------------------
  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h + ':' + pad(m) + ':' + pad(s);
  }
  function parseTime(str) {
    const parts = String(str).trim().split(':').map((p) => Number(p));
    if (!parts.length || parts.some((n) => Number.isNaN(n))) return null;
    let s = 0; for (const p of parts) s = s * 60 + p;
    return s;
  }

  // ---- dom helpers (no innerHTML — the page enforces Trusted Types) ---------
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function triangleSvg() {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('fill', '#fff');
    path.setAttribute('d', 'M5 8 H19 L12 17 Z'); // centered downward triangle
    svg.appendChild(path);
    return svg;
  }

  // ---- button --------------------------------------------------------------
  function makeButton() {
    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.className = 'ytdl-btn';
    btn.title = t('extName');
    btn.textContent = t('button');
    btn.setAttribute('data-testid', 'karaoke-download');
    btn.addEventListener('click', onClick);
    // a double click on the player toggles fullscreen; keep ours to ourselves
    btn.addEventListener('dblclick', (e) => e.stopPropagation());
    return btn;
  }
  function itemLabel(item, main, ext) {
    const b = el('b', null, main);
    item.appendChild(b);
    if (ext) { item.appendChild(document.createTextNode(' ')); item.appendChild(el('span', 'ytdl-ext', ext)); }
  }
  function ensureButton() {
    if (!/\/watch/.test(location.pathname)) return;
    watchAds();
    const existing = document.getElementById(BTN_ID);
    if (existing) { refreshButtonState(existing); return; }
    // top-right corner of the player itself (position: relative), not the control bar
    const player = document.getElementById('movie_player');
    if (!player) return;
    const btn = makeButton();
    player.appendChild(btn);
    refreshButtonState(btn);
  }

  // ---- ads -----------------------------------------------------------------
  // YouTube marks the player with `ad-showing` while an ad plays. An ad's bytes go
  // through the same SourceBuffers as the song, so a capture running through one
  // would come out corrupted: the button is disabled during ads, and an ad that
  // starts mid-capture cancels it with a clear message.
  const adPlaying = () => { const p = document.getElementById('movie_player'); return !!(p && p.classList.contains('ad-showing')); };
  function refreshButtonState(btn) {
    btn = btn || document.getElementById(BTN_ID);
    if (btn) btn.disabled = busy || adPlaying();
  }
  let adObserverTarget = null;
  function watchAds() {
    const p = document.getElementById('movie_player');
    if (!p || p === adObserverTarget) return;
    adObserverTarget = p;
    new MutationObserver(() => {
      if (busy && adPlaying() && !cancelledByAd) {
        cancelledByAd = true;
        callHook('cancel');
      }
      refreshButtonState();
    }).observe(p, { attributes: true, attributeFilter: ['class'] });
  }

  let menuEl = null;
  function closeMenu() { if (menuEl) { menuEl.remove(); menuEl = null; document.removeEventListener('click', onDocClick, true); } }
  function onDocClick(e) { if (menuEl && !menuEl.contains(e.target) && e.target.id !== BTN_ID) closeMenu(); }

  function head(text) { const d = document.createElement('div'); d.className = 'ytdl-menu-head'; d.textContent = text; return d; }

  // One click = the whole video as a 720p .mp4. No menu. 720p is enough to read the
  // lyrics and half the size of 1080p. The hook makes the player serve H.264 + AAC,
  // so the offscreen side stream-copies the tracks instead of re-encoding them.
  async function onClick(e) {
    e.stopPropagation();
    if (busy || adPlaying()) return;
    const info = await callHook('info');
    const duration = Math.floor(info.duration || 0);
    if (!duration) { fail('E1', 'duration unknown'); return; }
    startDownload({ format: 'mp4', height: 720, start: 0, end: duration, plainName: true }, info);
  }

  // Upstream's menu. Kept for reference and for merges; nothing calls it.
  async function openMenu(e) {
    e.stopPropagation();
    if (menuEl) { closeMenu(); return; }
    const info = await callHook('info');
    const duration = Math.floor(info.duration || 0);
    const heights = (info.heights || []).filter((h) => h === 1080 || h === 720);
    if (!heights.includes(1080)) heights.unshift(1080);
    if (!heights.includes(720)) heights.push(720);
    const uniq = [...new Set(heights)].sort((a, b) => b - a);
    const { transcode = false } = await chrome.storage.local.get('transcode');

    menuEl = document.createElement('div');
    menuEl.className = 'ytdl-menu';

    menuEl.appendChild(head('Triangle Downloader'));

    // --- fragment selection ---
    const frag = document.createElement('div');
    frag.className = 'ytdl-frag';
    const inStart = document.createElement('input');
    const inEnd = document.createElement('input');
    inStart.className = inEnd.className = 'ytdl-time';
    inStart.value = fmtTime(0);
    inEnd.value = fmtTime(duration);
    [inStart, inEnd].forEach((i) => i.addEventListener('click', (ev) => ev.stopPropagation()));
    const dash = document.createElement('span'); dash.className = 'ytdl-frag-dash'; dash.textContent = '—';
    frag.appendChild(inStart); frag.appendChild(dash); frag.appendChild(inEnd);
    menuEl.appendChild(frag);

    function fragment() {
      let start = parseTime(inStart.value);
      let end = parseTime(inEnd.value);
      if (start == null) start = 0;
      if (end == null || end <= 0) end = duration;
      start = Math.max(0, Math.min(start, duration));
      end = Math.max(start + 1, Math.min(end, duration));
      return { start, end };
    }

    // --- video ---
    menuEl.appendChild(head('Video'));
    uniq.forEach((h) => {
      const item = el('div', 'ytdl-menu-item');
      itemLabel(item, h + 'p', 'mp4');
      item.addEventListener('click', () => {
        const f = fragment(); closeMenu();
        startDownload({ format: 'mp4', height: h, start: f.start, end: f.end }, info);
      });
      menuEl.appendChild(item);
    });

    // --- audio ---
    menuEl.appendChild(head('Audio'));
    const mp3 = el('div', 'ytdl-menu-item');
    itemLabel(mp3, 'MP3', 'audio');
    mp3.addEventListener('click', () => {
      const f = fragment(); closeMenu();
      startDownload({ format: 'mp3', height: null, start: f.start, end: f.end }, info);
    });
    menuEl.appendChild(mp3);

    // --- subtitles (whole video; fragment does not apply) ---
    menuEl.appendChild(head('Subtitles'));
    const subs = el('div', 'ytdl-menu-item');
    itemLabel(subs, '.txt', 'ru / available');
    subs.addEventListener('click', () => { closeMenu(); downloadSubtitles(info); });
    menuEl.appendChild(subs);

    // --- video format toggle ---
    menuEl.appendChild(head('Video format'));
    const formats = [
      { key: false, title: 'Fast', sub: 'VP9 in mp4, no re-encoding' },
      { key: true, title: 'H.264 (compatible)', sub: 're-encoding, slow' },
    ];
    let current = !!transcode;
    const rows = [];
    formats.forEach((f) => {
      const row = el('div', 'ytdl-menu-radio' + (current === f.key ? ' sel' : ''));
      row.appendChild(el('span', 'ytdl-dot'));
      const txt = el('span', 'ytdl-radio-txt');
      txt.appendChild(el('b', null, f.title));
      txt.appendChild(el('i', null, f.sub));
      row.appendChild(txt);
      row.addEventListener('click', (ev) => {
        ev.stopPropagation();
        current = f.key;
        chrome.storage.local.set({ transcode: f.key });
        rows.forEach((r, i) => r.classList.toggle('sel', formats[i].key === current));
      });
      rows.push(row);
      menuEl.appendChild(row);
    });

    document.body.appendChild(menuEl);
    const b = document.getElementById(BTN_ID).getBoundingClientRect();
    menuEl.style.right = Math.max(8, window.innerWidth - b.right) + 'px';
    menuEl.style.bottom = (window.innerHeight - b.top + 8) + 'px';
    setTimeout(() => document.addEventListener('click', onDocClick, true), 0);
  }

  // ---- progress toast ------------------------------------------------------
  function toast() {
    let box = document.getElementById('ytdl-toast');
    if (!box) {
      box = el('div'); box.id = 'ytdl-toast';
      const bar = el('div', 'ytdl-toast-bar'); bar.appendChild(el('i'));
      box.appendChild(bar);
      box.appendChild(el('span', 'ytdl-toast-txt'));
      const action = el('button', 'ytdl-toast-btn');
      action.setAttribute('data-testid', 'karaoke-open-folder');
      box.appendChild(action);
      document.body.appendChild(box);
    }
    const actionBtn = box.querySelector('.ytdl-toast-btn');
    return {
      set(txt, pct) {
        box.querySelector('.ytdl-toast-txt').textContent = txt;
        box.querySelector('.ytdl-toast-bar i').style.width = Math.round((pct || 0) * 100) + '%';
        box.classList.add('show');
      },
      // one button under the text (e.g. "Open folder"); pass null to remove it
      action(label, onClick) {
        actionBtn.textContent = label || '';
        actionBtn.onclick = onClick || null;
        box.classList.toggle('has-action', !!label);
      },
      hide(delay) { setTimeout(() => { box.classList.remove('show'); box.classList.remove('has-action'); }, delay || 0); },
    };
  }

  // ---- curtain -------------------------------------------------------------
  // The capture hops the player's position forward so that YouTube fetches the next
  // pieces (content_hook.js): for ~10 s the scrubber runs and the picture jumps, which
  // looked to Dad like the video playing on its own. So the player is covered while it
  // happens: the frame he was looking at, dimmed, with the progress in big type. It
  // lives inside #movie_player, so it also shows in fullscreen (the toast, fixed to the
  // page, does not), and it swallows clicks and the player's keyboard shortcuts — a
  // seek or a play mid-capture would corrupt the capture. The video itself is already
  // paused and muted by the hook; it comes back where it was, playing if it was playing.
  let curtainEl = null;
  const CURTAIN_EVENTS = ['click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'contextmenu', 'wheel'];
  function swallow(e) { e.stopPropagation(); if (e.type === 'contextmenu' || e.type === 'dblclick') e.preventDefault(); }
  // Plain keys are the player's shortcuts (space, k, j/l, arrows, f, m…). Typing in a
  // field and Ctrl/Alt/Win combos are left alone.
  function swallowKey(e) {
    const tg = e.target;
    if (tg && (tg.tagName === 'INPUT' || tg.tagName === 'TEXTAREA' || tg.isContentEditable)) return;
    if (!e.ctrlKey && !e.altKey && !e.metaKey) e.stopPropagation();
  }
  function showCurtain() {
    hideCurtain();
    const player = document.getElementById('movie_player');
    if (!player) return;
    const box = el('div'); box.id = 'ytdl-curtain';
    box.setAttribute('data-testid', 'karaoke-curtain');
    // freeze the current frame (drawing an MSE-fed <video> onto a canvas is allowed)
    try {
      const v = player.querySelector('video');
      if (v && v.videoWidth && v.videoHeight) {
        const c = document.createElement('canvas');
        c.width = v.videoWidth; c.height = v.videoHeight;
        c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
        box.appendChild(c);
      }
    } catch (e) { /* no frame: the dark background will do */ }
    const card = el('div', 'ytdl-curtain-card');
    card.appendChild(el('div', 'ytdl-curtain-txt'));
    const bar = el('div', 'ytdl-curtain-bar'); bar.appendChild(el('i')); card.appendChild(bar);
    card.appendChild(el('div', 'ytdl-curtain-sub', t('keepTabOpen')));
    box.appendChild(card);
    CURTAIN_EVENTS.forEach((type) => box.addEventListener(type, swallow));
    ['keydown', 'keyup', 'keypress'].forEach((type) => window.addEventListener(type, swallowKey, true));
    player.appendChild(box);
    curtainEl = box;
  }
  function setCurtain(txt, pct) {
    if (!curtainEl) return;
    curtainEl.querySelector('.ytdl-curtain-txt').textContent = txt;
    curtainEl.querySelector('.ytdl-curtain-bar i').style.width = Math.round((pct || 0) * 100) + '%';
  }
  function hideCurtain() {
    ['keydown', 'keyup', 'keypress'].forEach((type) => window.removeEventListener(type, swallowKey, true));
    if (curtainEl) { curtainEl.remove(); curtainEl = null; }
  }
  // The hook puts the player back where it was as the capture ends; give that seek a
  // moment to land (bounded) so the last hop never shows when the curtain lifts.
  function pictureBack(maxMs) {
    return new Promise((resolve) => {
      const v = document.querySelector('#movie_player video');
      const t0 = Date.now();
      const tick = () => {
        const waited = Date.now() - t0;
        if (!v || waited >= maxMs || (waited >= 150 && !v.seeking)) return resolve();
        setTimeout(tick, 50);
      };
      tick();
    });
  }

  // Short code + version on screen (easy to read out over the phone), full error
  // in the console. E1 capture, E2 convert/save, E4 an ad interrupted the capture.
  function fail(code, err) {
    const tt = toast();
    tt.action(null);
    tt.set(code === 'E4' ? t('adDetected') : t('error', [code, VERSION]), 1);
    tt.hide(10000);
    console.error('[Karaoke downloader ' + VERSION + '] ' + code + ':', err);
  }

  // Chrome refuses a download whose filename holds characters it deems illegal, and
  // reports only "Invalid filename". Besides the obvious reserved punctuation that
  // includes invisible formatting characters — the zero-width joiner inside an emoji
  // like the detective, bidi marks, byte-order marks — plus leading/trailing dots.
  function safeName(s) {
    const cleaned = String(s || '')
      .replace(/[\\/:*?"<>|]+/g, ' ')
      .replace(/[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFE00-\uFE0F\uFEFF]/g, '')
      .replace(/\s+/g, ' ')
      .replace(/^[.\s]+|[.\s]+$/g, '')
      .slice(0, 100)
      .trim();
    return cleaned || 'video';
  }
  function fragSuffix(start, end, duration) {
    if (start <= 0 && end >= duration - 0.5) return '';
    return ' (' + fmtTime(start).replace(/:/g, '.') + '-' + fmtTime(end).replace(/:/g, '.') + ')';
  }

  async function downloadSubtitles(info) {
    const t = toast();
    t.set('Opening transcript…', 0.3);
    try {
      const res = await callHook('subtitles');
      if (!res || !res.ok) throw new Error((res && res.error) || 'no subtitles');
      const filename = safeName(info.title) + ' [' + (res.lang || 'txt') + '].txt';
      // small text → a data URL is enough; BOM keeps Cyrillic correct on Windows
      const url = 'data:text/plain;charset=utf-8,' + encodeURIComponent('﻿' + res.text);
      const save = await chrome.runtime.sendMessage({ t: 'ytdl-save', url, filename });
      if (!save || !save.ok) throw new Error((save && save.error) || 'could not save');
      t.set('Done: ' + (save.filename || filename), 1);
      t.hide(4000);
    } catch (err) {
      t.set('Error: ' + (err.message || err), 1);
      t.hide(6000);
      console.error('[Triangle]', err);
    }
  }

  async function startDownload(opts, info) {
    const { format, height, start, end, plainName } = opts;
    const duration = Math.floor(info.duration || 0);
    const isMp3 = format === 'mp3';
    const tt = toast();
    busy = true; cancelledByAd = false;
    refreshButtonState();
    tt.action(null);
    tt.hide(0);
    // One display for the whole job: the curtain, with the capture and then the
    // preparation of the file in big type. The toast only reports the result — its
    // bar in the corner used to repeat the curtain's percentage.
    showCurtain();
    setCurtain(t('downloading', [0]), 0.02);

    const { transcode = false } = await chrome.storage.local.get('transcode');
    const relay = makeRelay();

    // ffmpeg's own progress — the fallbacks only; a re-encode can take many minutes
    const onProg = (msg) => {
      if (msg && msg.t === 'ytdl-progress') setCurtain(t('converting') + ' ' + Math.round(msg.value * 100) + '%', msg.value);
    };
    chrome.runtime.onMessage.addListener(onProg);
    try {
      await relay.begin({ title: info.title || '', artist: info.author || '' });
      let result;
      try {
        result = await download({ height, format, start, end, hold: true }, (d) => {
          setCurtain(t('downloading', [Math.round(d.progress * 100)]), d.progress);
        }, relay.push);
      } catch (err) {
        throw Object.assign(err, { code: relay.error ? 'E2' : (cancelledByAd ? 'E4' : 'E1') });
      }
      // The capture is over; the pieces still in flight reach the muxer now (usually
      // none: they were shipped while it ran). The curtain stays up meanwhile.
      setCurtain(t('preparing', [0]), 0);
      await relay.drain((pct) => setCurtain(t('preparing', [Math.round(pct * 100)]), pct));

      const ext = isMp3 ? '.mp3' : '.mp4';
      // Sub-folder of Downloads (chrome.downloads accepts a relative path) + the one
      // shared sanitiser (filename.js); the folder name is localised like everything else.
      const filename = t('songsFolder') + '/' + safeFilename(info.title) + (isMp3 || plainName ? '' : ' [' + height + 'p]') +
        fragSuffix(start, end, duration) + ext;

      // Capture starts at a segment boundary at or before `start`, so trimming must be
      // RELATIVE to the captured file — ffmpeg's -ss counts from the file's own start,
      // not from the video's absolute timeline.
      const capturedFrom = typeof result.capturedFrom === 'number' ? result.capturedFrom : start;
      const capV = typeof result.capturedFromVideo === 'number' ? result.capturedFromVideo : capturedFrom;
      const capA = typeof result.capturedFromAudio === 'number' ? result.capturedFromAudio : capturedFrom;
      const trimStart = Math.max(0, start - capturedFrom);
      const trimDuration = Math.max(0, end - start);
      const isFragment = start > 0 || end < duration - 0.5;

      // A copied stream can only start on a keyframe, so an exact start needs
      // re-encoding. That costs roughly the clip's own length, so we only do it
      // automatically for short clips; longer ones stay instant and start at the
      // keyframe just before the requested point.
      const needsExactCut = isFragment && trimStart > 0.3;
      const shortEnough = trimDuration > 0 && trimDuration <= EXACT_CUT_MAX_SEC;
      const exactCut = !isMp3 && needsExactCut && shortEnough;
      // The hook steers YouTube to H.264. Should a video still arrive in another codec,
      // fall back to upstream's libx264 re-encode so the file plays everywhere — slow
      // (tens of minutes), but it should be rare and the toast shows the progress.
      const videoMime = (result.video && result.video.mime) || '';
      const h264 = /avc1|avc3/i.test(videoMime);
      if (!isMp3 && !h264) console.warn('[Karaoke downloader ' + VERSION + '] video is not H.264 (' + videoMime + '), re-encoding');
      const doTranscode = isMp3 ? true : (!!transcode || exactCut || !h264);
      const alignedStart = !isMp3 && needsExactCut && !doTranscode;

      // The two captured tracks do NOT begin at the same instant — YouTube's audio
      // segment covering the requested point can start ~10s before the video keyframe.
      // Muxing them as-is makes ffmpeg zero each input on its own, which slides the
      // sound against the picture, so each track gets its own trim to a common instant.
      // A copy has to keep the video's first keyframe; re-encoding can cut anywhere.
      const base = isMp3 ? Math.max(start, capA)
        : (doTranscode ? Math.max(start, capV, capA) : capV);
      const videoSeek = Math.max(0, base - capV);
      const audioSeek = Math.max(0, base - capA);
      const audioDelay = Math.max(0, capA - base); // audio truly starts later → keep the gap
      const outDuration = isFragment ? Math.max(0, end - base) : 0;

      // What was captured, for the console (the offscreen page's own log is out of reach)
      console.log('[Karaoke downloader ' + VERSION + '] captured:', JSON.stringify({ video: result.video, audio: result.audio, from: result.capturedFrom }));
      const res = await relay.finalize({
        format, filename,
        videoMime: result.video && result.video.mime,
        audioMime: result.audio && result.audio.mime,
        transcode: doTranscode, quickEncode: exactCut && !transcode,
        videoSeek, audioSeek, audioDelay, outDuration,
        expectedSeconds: isFragment ? Math.max(0, end - start) : duration,
      });
      console.log('[Karaoke downloader ' + VERSION + '] saved:', JSON.stringify(res));

      if (!res || !res.ok) throw Object.assign(new Error(res && res.error || 'mux failed'), { code: 'E2' });
      const savedAs = res.filename || filename;
      // Saved. Lift the curtain once the hook's seek back has landed, let the video
      // play again, and only then the toast reports the result.
      await pictureBack(800);
      hideCurtain();
      await callHook('resume');
      const box = document.getElementById('ytdl-toast');
      if (box) box.setAttribute('data-filename', savedAs); // what the extension asked Chrome to save
      tt.set(t('done'), 1);
      if (res.id != null) tt.action(t('openFolder'), () => { chrome.runtime.sendMessage({ t: 'ytdl-show', id: res.id }); });
      tt.hide(20000);
    } catch (err) {
      relay.abort();
      fail((err && err.code) || (cancelledByAd ? 'E4' : 'E2'), err);
    } finally {
      hideCurtain();
      callHook('resume');
      busy = false;
      refreshButtonState();
      chrome.runtime.onMessage.removeListener(onProg);
    }
  }

  // ---- transfer to the offscreen page -------------------------------------
  function b64encode(u8) {
    if (typeof u8.toBase64 === 'function') return u8.toBase64(); // native (recent Chrome), far faster
    let s = '';
    const STEP = 0x8000;
    for (let i = 0; i < u8.length; i += STEP) {
      s += String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + STEP, u8.length)));
    }
    return btoa(s);
  }

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // The ffmpeg side lives in an offscreen document that the service worker creates on
  // demand. Only that document answers begin/chunk/finalize, so sending before it is
  // listening rejects with a bare "message port closed". Wait for it to answer a ping
  // first — and give a failed send one more try, since the worker may have been asleep.
  async function offscreenReady(timeoutMs = 8000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try {
        const r = await chrome.runtime.sendMessage({ t: 'ytdl-ping' });
        if (r && r.ok) return true;
      } catch (e) { /* not listening yet */ }
      await wait(200);
    }
    return false;
  }

  async function sendToOffscreen(msg, retries = 1) {
    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const r = await chrome.runtime.sendMessage(msg);
        if (r) return r;                     // includes negative answers — those are real
        lastErr = new Error('no answer from the ffmpeg worker');
      } catch (e) { lastErr = e; }
      if (attempt < retries) {
        try { await chrome.runtime.sendMessage({ t: 'ytdl-ensure' }); } catch (e) {}
        await wait(300);
      }
    }
    throw lastErr || new Error('the ffmpeg worker is not responding');
  }

  // The hook hands over each captured piece as it arrives and the relay ships it on
  // at once — base64 in 4 MB messages, the only road from a content script to an
  // extension page — so nothing accumulates here either. Should the muxer fall
  // behind, the hook is told to stop pulling new pieces (`pressure`) until the
  // queue is short again. The transfer overlaps the capture; `drain` only waits for
  // what is still in flight when the capture ends.
  const CHUNK = 4 * 1024 * 1024;
  const QUEUE_HIGH = 48 * 1024 * 1024, QUEUE_LOW = 12 * 1024 * 1024;
  function makeRelay() {
    const queue = [];   // { kind, mime, bytes: ArrayBuffer }
    let queued = 0, total = 0, sent = 0, seq = 0; // seq lets the receiver drop a repeated chunk
    let pumping = null, ready = false, paused = false, closed = false, onDrain = null;
    const relay = { error: null };
    const e2 = (msg) => Object.assign(new Error(msg), { code: 'E2' });

    async function pump() {
      while (queue.length && !relay.error && !closed) {
        const item = queue.shift();
        queued -= item.bytes.byteLength;
        if (paused && queued < QUEUE_LOW) { paused = false; callHook('pressure', { high: false }); }
        const view = new Uint8Array(item.bytes);
        // a reset marker (the player aborted an append) travels as an empty chunk
        const pieces = item.reset ? [null] : [];
        for (let off = 0; off < view.length; off += CHUNK) pieces.push(view.subarray(off, Math.min(off + CHUNK, view.length)));
        for (const slice of pieces) {
          if (relay.error) break;
          let r = null;
          const msg = { t: 'ytdl-chunk', track: item.kind, mime: item.mime, seq, b64: slice ? b64encode(slice) : '', reset: !slice };
          try { r = await sendToOffscreen(msg); }
          catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
          if (!r || !r.ok) { relay.error = e2('data transfer interrupted (' + item.kind + ')' + (r && r.error ? ': ' + r.error : '')); break; }
          seq++;
          if (slice) sent += slice.length;
          if (onDrain) onDrain(total ? sent / total : 1);
        }
      }
      pumping = null;
      if (relay.error && !closed) callHook('cancel'); // stop the capture: its pieces have nowhere to go
    }
    relay.begin = async (meta) => {
      await chrome.runtime.sendMessage({ t: 'ytdl-ensure' });
      if (!await offscreenReady()) throw e2('the muxer page did not start');
      const r = await sendToOffscreen(Object.assign({ t: 'ytdl-begin' }, meta));
      if (!r || !r.ok) throw e2('the muxer page refused the job');
      ready = true;
      if (queue.length && !pumping) pumping = pump();
    };
    relay.push = (d) => {
      if (closed || relay.error) return;
      queue.push({ kind: d.kind, mime: d.mime, bytes: d.bytes, reset: !!d.reset });
      queued += d.bytes.byteLength; total += d.bytes.byteLength;
      if (!paused && queued > QUEUE_HIGH) { paused = true; callHook('pressure', { high: true }); }
      if (ready && !pumping) pumping = pump();
    };
    relay.drain = async (progress) => {
      onDrain = progress;
      while (pumping) await pumping;
      onDrain = null;
      if (relay.error) throw relay.error;
      if (paused) { paused = false; callHook('pressure', { high: false }); }
      progress(1);
    };
    relay.finalize = (job) => {
      closed = true;
      // No retry: a repeated finalize would re-run the muxer on already-freed data.
      return sendToOffscreen(Object.assign({ t: 'ytdl-finalize' }, job), 0);
    };
    relay.abort = () => {
      closed = true; queue.length = 0;
      try { chrome.runtime.sendMessage({ t: 'ytdl-abort' }).catch(() => {}); } catch (e) {}
    };
    return relay;
  }

  const mo = new MutationObserver(() => ensureButton());
  mo.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('yt-navigate-finish', ensureButton);
  ensureButton();

  // ---- update notice -------------------------------------------------------
  // The background compares the latest GitHub Release with this version once a
  // day and leaves the answer in storage; show it once per page load, on /watch.
  chrome.storage.local.get('updateAvailable').then(({ updateAvailable }) => {
    if (!updateAvailable || !/\/watch/.test(location.pathname)) return;
    const tt = toast();
    tt.set(t('updateAvailable'), 0);
    tt.hide(12000);
  }).catch(() => {});
})();
