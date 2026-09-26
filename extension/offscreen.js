// offscreen.js — the extension page that turns the captured tracks into the file.
// The UI script ships the tracks in chunks WHILE the capture runs; nothing is
// held whole in memory, so a two-hour video is no different from a song:
//   * each chunk is kept as a Blob part (Chrome moves big blobs out of the page,
//     to disk if it must), and
//   * fed to mp4mux.js, which writes the sample tables as it goes and, at the
//     end, assembles an ordinary MP4 (index first, correct duration) out of the
//     blob parts — for the H.264 + AAC tracks the hook makes YouTube serve.
// ffmpeg.wasm (upstream's path) stays for the rest: another codec (libx264
// re-encode), an exact cut, the MP3. It reads the blobs through a WORKERFS mount,
// so even then the input is not copied into its memory; its output still is.

const { FFmpeg } = FFmpegWASM;

let ff = null;
let ffLoading = null;
const ffLog = []; // ring buffer of recent ffmpeg log lines for error reporting
let job = null;   // the capture being received, see newJob()

function newJob(meta) {
  return {
    seq: 0,
    title: meta.title || '', artist: meta.artist || '',
    raw: { video: [], audio: [] },   // Blob parts of each track's bytes, as received
    bytes: { video: 0, audio: 0 },
    mime: { video: '', audio: '' },
    mux: new Fmp4Muxer(),
    muxError: null,                  // once set, only ffmpeg can finish this job
  };
}

async function getFF() {
  if (ff) return ff;
  if (ffLoading) return ffLoading;
  ffLoading = (async () => {
    const inst = new FFmpeg();
    inst.on('progress', ({ progress }) => {
      try { chrome.runtime.sendMessage({ t: 'ytdl-progress', value: Math.max(0, Math.min(1, progress)) }); } catch (e) {}
    });
    inst.on('log', ({ message }) => {
      ffLog.push(message);
      if (ffLog.length > 40) ffLog.shift();
    });
    const base = chrome.runtime.getURL('vendor/ffmpeg/');
    await inst.load({ coreURL: base + 'ffmpeg-core.js', wasmURL: base + 'ffmpeg-core.wasm' });
    ff = inst;
    return inst;
  })();
  return ffLoading;
}

function b64decode(s) {
  if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(s);
  const bin = atob(s);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

function extFor(mime) {
  if (/webm/i.test(mime)) return 'webm';
  if (/mp4/i.test(mime)) return 'mp4';
  return 'bin';
}

// Title/artist tags so players show the song's name, not the file name: ID3v2.3 in
// the MP3 (car radios, phones), ©nam/©ART atoms in the MP4 (Windows, VLC, phones).
function metaTags(j, format) {
  const tags = [];
  if (j.title) tags.push('-metadata', 'title=' + j.title);
  if (j.artist) tags.push('-metadata', 'artist=' + j.artist);
  if (tags.length && format === 'mp3') tags.push('-id3v2_version', '3');
  return tags;
}

// Hand the finished file to the background, which saves it through chrome.downloads.
async function save(blob, filename, ext) {
  const name = filename.replace(/\.(mp4|webm|mp3)$/i, '') + ext;
  const url = URL.createObjectURL(blob);
  const res = await chrome.runtime.sendMessage({ t: 'ytdl-save', url, filename: name });
  // The download holds the blob once it has started; the URL itself can go later.
  // Generous, because a multi-gigabyte file takes a while to be written to disk.
  setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) {} }, 10 * 60 * 1000);
  return res && res.ok
    ? { ok: true, filename: res.filename || name, id: res.id }
    : { ok: false, error: (res && res.error) || 'save failed' };
}

// `p` is the job description the UI sends with ytdl-finalize (format, filename,
// mimes, trims, whether to re-encode).
async function finalize(p) {
  const j = job;
  job = null;
  if (!j) throw new Error('no capture in progress');
  const trimmed = p.outDuration > 0.05 || p.videoSeek > 0.02 || p.audioSeek > 0.02 || p.audioDelay > 0.02;
  const copyWanted = p.format !== 'mp3' && !p.transcode && !trimmed;
  // A file much shorter than the video is a broken file, whoever wrote it: better an
  // error the user can retry than a "Done" over a quarter of the show.
  const expected = Number(p.expectedSeconds) || 0;
  const tooShort = (seconds) => expected > 0 && seconds != null && seconds < expected * 0.9 - 2;
  if (copyWanted && j.mux && !j.muxError) {
    try {
      const st = j.mux.stats();
      if (/^avc[13]$/.test(st.video.codec) && st.audio.codec === 'mp4a' && st.video.samples && st.audio.samples) {
        const seconds = Math.min(st.video.seconds, st.audio.seconds);
        if (tooShort(seconds)) throw new Error('muxed only ' + Math.round(seconds) + ' s of ' + Math.round(expected) + ' s: ' + JSON.stringify(st));
        const blob = j.mux.finish({ title: j.title, artist: j.artist });
        console.log('[Karaoke downloader] muxed in JS:', JSON.stringify(st), blob.size + ' bytes');
        j.raw = null;
        const res = await save(blob, p.filename, '.mp4');
        return Object.assign(res, { how: 'js', seconds, stats: st });
      }
      j.muxError = new Error('unexpected codecs ' + st.video.codec + ' / ' + st.audio.codec);
    } catch (e) { j.muxError = e; }
  }
  const why = j.muxError ? String((j.muxError && j.muxError.message) || j.muxError) : 'not a plain copy';
  if (j.muxError) console.warn('[Karaoke downloader] JS mux not used, ffmpeg instead:', why);
  let res;
  try { res = await ffmpegFinalize(j, p, tooShort); }
  catch (e) { throw new Error(String((e && e.message) || e) + ' [muxer: ' + why + ']'); }
  return Object.assign(res, { muxError: why });
}

async function ffmpegFinalize(j, p, tooShort) {
  const inst = await getFF();
  const isMp3 = p.format === 'mp3';
  const format = p.format || 'mp4';
  if (!j.bytes.audio) throw new Error('empty audio data');
  if (!isMp3 && !j.bytes.video) throw new Error('empty video data');
  const aFile = 'a.' + extFor(p.audioMime || j.mime.audio);
  const vFile = 'v.' + extFor(p.videoMime || j.mime.video);
  // The tracks as files ffmpeg reads on demand from the blobs (WORKERFS); should the
  // core lack that file system, fall back to copying them in, as upstream did.
  const blobs = [{ name: aFile, data: new Blob(j.raw.audio) }];
  if (!isMp3) blobs.push({ name: vFile, data: new Blob(j.raw.video) });
  j.raw = null;
  let dir = '/in/';
  try { await inst.createDir('/in'); } catch (e) { /* exists */ }
  try { await inst.unmount('/in'); } catch (e) { /* not mounted */ }
  let mounted = false;
  try { mounted = !!(await inst.mount('WORKERFS', { blobs }, '/in')); } catch (e) { mounted = false; }
  if (!mounted) {
    dir = '';
    for (const b of blobs) await inst.writeFile(b.name, new Uint8Array(await b.data.arrayBuffer()));
  }
  const aName = dir + aFile, vName = isMp3 ? null : dir + vFile;

  // Trims arrive PER TRACK and are relative to each captured file's own beginning
  // (ffmpeg's -ss counts from the file's start, not from the video's timeline). They
  // are computed so both tracks begin at the same instant of the source: the captured
  // audio usually starts seconds before the video keyframe, and muxing two files that
  // begin at different instants makes ffmpeg zero each input separately, sliding the
  // sound against the picture.
  const videoSeek = Math.max(0, Number(p.videoSeek) || 0);
  const audioSeek = Math.max(0, Number(p.audioSeek) || 0);
  const audioDelay = Math.max(0, Number(p.audioDelay) || 0);
  const outDuration = Math.max(0, Number(p.outDuration) || 0);
  const limit = outDuration > 0.05 ? ['-t', outDuration.toFixed(3)] : [];
  const inV = (trim) => (vName
    ? [...(trim && videoSeek > 0.02 ? ['-ss', videoSeek.toFixed(3)] : []), '-i', vName]
    : []);
  const inA = (trim) => [
    ...(trim && audioDelay > 0.02 ? ['-itsoffset', audioDelay.toFixed(3)] : []),
    ...(trim && audioSeek > 0.02 ? ['-ss', audioSeek.toFixed(3)] : []),
    '-i', aName,
  ];
  // Stream copy can only cut on keyframes, so a trimmed copy starts at the keyframe
  // BEFORE the requested point. MP4 can hide that lead-in with an edit list, but the
  // skipped frames stay inside the file and players that take the duration from the
  // media track then show a frozen tail at the end. So the copy path always normalizes
  // timestamps (lead-in becomes ordinary content) and exact cuts are produced by
  // re-encoding instead — see the "exact cut" decision in content_ui.js.
  // No `+faststart`: it rewrites the whole output a second time inside ffmpeg's
  // memory, and the files play locally.
  const ZERO = ['-avoid_negative_ts', 'make_zero'];
  const tags = metaTags(j, format);

  const runs = [];
  if (isMp3) {
    runs.push({
      name: 'mp3', out: 'out.mp3', type: 'audio/mpeg', ext: '.mp3',
      args: [...inA(true), ...limit, '-vn', '-c:a', 'libmp3lame', '-b:a', '192k', ...tags, 'out.mp3'],
    });
  } else if (p.transcode) {
    // Re-encode to H.264 + AAC. An automatic exact cut of a short clip favours speed
    // (ultrafast is ~2× quicker at 1080p); the user-selected compatibility mode keeps
    // the better-compressing preset.
    const preset = p.quickEncode ? 'ultrafast' : 'veryfast';
    runs.push({
      name: 'h264', out: 'out.mp4', type: 'video/mp4', ext: '.mp4',
      args: [...inV(true), ...inA(true), '-map', '0:v:0', '-map', '1:a:0', ...limit,
        '-c:v', 'libx264', '-preset', preset, '-crf', '20', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '160k', ...tags, 'out.mp4'],
    });
  } else {
    // Stream copy into mp4 (upstream's fast path; today only reached when the JS
    // muxer declined). Should the audio be Opus, copy the video and encode only the
    // audio to AAC so the file plays everywhere; the plain copy stays as a fallback.
    if (!/mp4a|aac/i.test(p.audioMime || j.mime.audio)) {
      runs.push({
        name: 'mp4-copy-video-aac', out: 'out.mp4', type: 'video/mp4', ext: '.mp4',
        args: [...inV(true), ...inA(true), '-map', '0:v:0', '-map', '1:a:0', ...limit,
          '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', ...ZERO, ...tags, 'out.mp4'],
      });
    }
    runs.push({
      name: 'mp4-copy', out: 'out.mp4', type: 'video/mp4', ext: '.mp4',
      args: [...inV(true), ...inA(true), '-map', '0:v:0', '-map', '1:a:0', ...limit,
        '-c', 'copy', '-strict', '-2', ...ZERO, ...tags, 'out.mp4'],
    });
    if (limit.length) {
      // If trimming upsets the copy path, keep the whole captured range rather than fail
      // (it covers the fragment, just aligned to segment boundaries).
      runs.push({
        name: 'mp4-copy-untrimmed', out: 'out.mp4', type: 'video/mp4', ext: '.mp4',
        args: [...inV(true), ...inA(true), '-map', '0:v:0', '-map', '1:a:0',
          '-c', 'copy', '-strict', '-2', '-avoid_negative_ts', 'make_zero', ...tags, 'out.mp4'],
      });
    }
    // Last resort if mp4 refuses these codecs.
    runs.push({
      name: 'webm-copy', out: 'out.webm', type: 'video/webm', ext: '.webm',
      args: [...inV(true), ...inA(true), '-map', '0:v:0', '-map', '1:a:0', ...limit,
        '-c', 'copy', ...ZERO, ...tags, 'out.webm'],
    });
  }

  let data = null, chosen = null;
  const failures = [];
  try {
    for (const run of runs) {
      ffLog.length = 0;
      let ret = -1;
      try { ret = await inst.exec(run.args); } catch (e) { ret = -1; ffLog.push(String((e && e.message) || e)); }
      if (ret === 0) {
        try {
          const out = await inst.readFile(run.out);
          // a non-empty result only — a "successful" run can still yield an empty file
          if (out && out.length > 1024) { data = out; chosen = run; break; }
          failures.push(run.name + ': empty result');
        } catch (e) { failures.push(run.name + ': output file missing'); }
      } else {
        failures.push(run.name + ' (code ' + ret + '): ' + ffLog.slice(-3).join(' | '));
      }
      try { await inst.deleteFile(run.out); } catch (e) {}
    }
  } finally {
    // free the input and the output inside ffmpeg
    if (mounted) { try { await inst.unmount('/in'); } catch (e) {} }
    else { for (const b of blobs) { try { await inst.deleteFile(b.name); } catch (e) {} } }
    if (chosen) { try { await inst.deleteFile(chosen.out); } catch (e) {} }
  }
  if (!chosen) throw new Error(failures.join('  ||  ') || 'ffmpeg produced no file');
  const seconds = Fmp4Muxer.durationOf(data);
  if (tooShort && tooShort(seconds)) throw new Error('ffmpeg (' + chosen.name + ') wrote only ' + Math.round(seconds) + ' s of ' + Math.round(Number(p.expectedSeconds)) + ' s');
  const res = await save(new Blob([data.buffer], { type: chosen.type }), p.filename, chosen.ext);
  return Object.assign(res, { how: 'ffmpeg:' + chosen.name, seconds });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.t !== 'string') return;

  // Readiness probe: the sender waits for this before streaming anything, because the
  // service worker resolves createDocument() and only this listener proves the document
  // is actually able to receive.
  if (msg.t === 'ytdl-ping') { sendResponse({ ok: true }); return; }

  if (msg.t === 'ytdl-begin') {
    job = newJob(msg);
    sendResponse({ ok: true });
    return; // sync
  }
  if (msg.t === 'ytdl-abort') {
    job = null; // drops the blobs
    sendResponse({ ok: true });
    return;
  }
  if (msg.t === 'ytdl-chunk') {
    try {
      if (!job) { sendResponse({ ok: false, error: 'no capture in progress' }); return; }
      // Chunks are numbered so a retried one can be recognised. Re-applying a chunk
      // whose answer was lost in transit would silently double the data and corrupt
      // the file, and a gap means the document was recreated mid-transfer — better to
      // fail loudly than to write a broken video.
      const seq = Number(msg.seq);
      if (Number.isFinite(seq)) {
        if (seq < job.seq) { sendResponse({ ok: true, duplicate: true }); return; }
        if (seq > job.seq) { sendResponse({ ok: false, error: 'missing data chunk' }); return; }
      }
      const track = msg.track === 'video' ? 'video' : 'audio';
      if (msg.reset) {
        // the player aborted an append: whatever partial box the muxer holds is void
        if (job.mux) job.mux.resync(track);
        job.seq++;
        sendResponse({ ok: true });
        return;
      }
      const u8 = b64decode(msg.b64);
      if (msg.mime && !job.mime[track]) job.mime[track] = msg.mime;
      job.raw[track].push(new Blob([u8]));
      job.bytes[track] += u8.length;
      if (!job.muxError) {
        if (!/mp4/i.test(job.mime[track] || 'mp4')) job.muxError = new Error(track + ' is not fragmented MP4 (' + job.mime[track] + ')');
        else { try { job.mux.feed(track, u8); } catch (e) { job.muxError = e; } }
        if (job.muxError) job.mux = null;
      }
      job.seq++;
      sendResponse({ ok: true });
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
    return; // sync
  }
  if (msg.t === 'ytdl-finalize') {
    finalize(msg)
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true; // async
  }
  // other message types belong to the background; ignore.
});
