// background.js — service worker. Owns the offscreen document lifecycle, performs
// the final chrome.downloads save, opens the saved file's folder on request and
// checks GitHub once a day for a newer release. ffmpeg.wasm cannot run here (a
// service worker has no DOM/Worker/document that ffmpeg needs), so all muxing
// happens in the offscreen document; the worker only orchestrates.
importScripts('filename.js', 'version.js');

const RELEASES_LATEST = 'https://api.github.com/repos/alex-vinny/karaoke-mp3-downloader/releases/latest';
const UPDATE_ALARM = 'update-check';

// Last-resort file name: keep the sub-folder and the extension, rebuild the base
// with the shared sanitiser, so a download is never lost because of the title.
function plainFilename(name) {
  const slash = name.lastIndexOf('/');
  const dir = slash >= 0 ? name.slice(0, slash + 1) : '';
  const file = name.slice(slash + 1);
  const dot = file.lastIndexOf('.');
  const ext = dot > 0 ? file.slice(dot) : '';
  const base = dot > 0 ? file.slice(0, dot) : file;
  return dir + safeFilename(base) + ext;
}

let creating = null; // de-dupe concurrent createDocument calls

async function ensureOffscreen() {
  const has = await chrome.offscreen.hasDocument();
  if (has) return;
  if (creating) { await creating; return; }
  creating = chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['WORKERS', 'BLOBS'],
    justification: 'Run ffmpeg.wasm to convert the captured audio track into an MP3.',
  });
  try { await creating; } finally { creating = null; }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.t !== 'string') return;

  // Messages the background is responsible for. Everything else (begin/chunk/
  // finalize) is handled by the offscreen document and ignored here.
  if (msg.t === 'ytdl-ensure') {
    ensureOffscreen().then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true; // async
  }

  if (msg.t === 'ytdl-save') {
    // Offscreen finished muxing and handed us a blob URL to save.
    const save = (filename) =>
      chrome.downloads.download({ url: msg.url, filename, saveAs: false });
    save(msg.filename)
      .then((id) => sendResponse({ ok: true, id, filename: msg.filename }))
      .catch(() => {
        // Chrome rejects some titles outright and says only "Invalid filename".
        // Save the finished file under a plain name instead of throwing it away.
        const alt = plainFilename(msg.filename || 'audio.mp3');
        save(alt)
          .then((id) => sendResponse({ ok: true, id, filename: alt }))
          .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
      });
    return true; // async
  }

  if (msg.t === 'ytdl-show') {
    // "Open folder" in the toast: Explorer with the saved MP3 selected.
    try { chrome.downloads.show(Number(msg.id)); sendResponse({ ok: true }); }
    catch (e) { sendResponse({ ok: false, error: String(e) }); }
    return; // sync
  }
});

// ---- update notice ---------------------------------------------------------
// Once a day, compare the latest GitHub Release tag with the installed version and
// leave the answer in storage; the content script shows it. The Release is what the
// installer downloads, so a newer tag always means something Dad can install.
async function checkForUpdate() {
  try {
    const res = await fetch(RELEASES_LATEST, { headers: { Accept: 'application/vnd.github+json' } });
    const stamp = { updateCheckedAt: Date.now() };
    if (!res.ok) { await chrome.storage.local.set(stamp); return; } // 404 = no release yet
    const data = await res.json();
    const remote = String(data.tag_name || '').replace(/^v/i, '');
    const local = chrome.runtime.getManifest().version;
    await chrome.storage.local.set({ ...stamp, updateAvailable: isNewerVersion(remote, local) ? remote : null });
  } catch (e) {
    console.warn('[Karaoke MP3] update check failed:', e);
  }
}

async function scheduleUpdateCheck() {
  const existing = await chrome.alarms.get(UPDATE_ALARM);
  if (!existing) chrome.alarms.create(UPDATE_ALARM, { delayInMinutes: 1, periodInMinutes: 24 * 60 });
}

chrome.runtime.onInstalled.addListener(() => { scheduleUpdateCheck(); });
chrome.runtime.onStartup.addListener(() => { scheduleUpdateCheck(); });
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === UPDATE_ALARM) checkForUpdate(); });
