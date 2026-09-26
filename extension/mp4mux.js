// mp4mux.js — turns the two fragmented-MP4 tracks the YouTube player feeds its
// SourceBuffers (H.264 video, AAC audio; init segment + moof/mdat fragments) into
// one ordinary MP4 file, without ffmpeg and without ever holding the whole video
// in memory: sample data goes straight into Blob parts as it arrives (Chrome keeps
// big blobs on disk), only the sample tables stay in JS (a few MB for hours of
// video). The file has its index (moov) FIRST and a correct duration, so every
// player seeks it properly. Used by offscreen.js; unit-tested in Node.
//
// Scope: exactly what the capture hook delivers — one init segment per track,
// fragments with one traf each, moof-relative data offsets (what MSE requires),
// H.264 with B-frames (signed composition offsets → unsigned ctts + edit list, as
// ffmpeg does). Anything else throws, and the caller falls back to ffmpeg.
(function (root) {
  'use strict';

  // ---- reading -------------------------------------------------------------
  const rd16 = (b, o) => (b[o] << 8) | b[o + 1];
  const rd24 = (b, o) => (b[o] << 16) | (b[o + 1] << 8) | b[o + 2];
  const rd32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  const rdS32 = (b, o) => (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];
  const rd64 = (b, o) => rd32(b, o) * 4294967296 + rd32(b, o + 4);
  const type4 = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

  // The boxes laid out in [start, end): { type, start, body, end }.
  function boxes(b, start, end) {
    const out = [];
    let off = start;
    while (off + 8 <= end) {
      let size = rd32(b, off), hdr = 8;
      const type = type4(b, off + 4);
      if (size === 1) { size = rd64(b, off + 8); hdr = 16; }
      else if (size === 0) size = end - off;
      if (size < hdr || off + size > end) throw new Error('malformed box ' + type);
      out.push({ type, start: off, body: off + hdr, end: off + size });
      off += size;
    }
    return out;
  }
  const child = (b, box, type) => boxes(b, box.body, box.end).find((x) => x.type === type) || null;
  function descend(b, box, types) {
    let cur = box;
    for (const t of types) { cur = child(b, cur, t); if (!cur) return null; }
    return cur;
  }
  const raw = (b, box) => b.slice(box.start, box.end);

  // ---- writing -------------------------------------------------------------
  function concatBytes(parts) {
    let n = 0; for (const p of parts) n += p.length;
    const out = new Uint8Array(n);
    let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
  function be32(v) { return new Uint8Array([(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]); }
  function be64(v) { return concatBytes([be32(Math.floor(v / 4294967296)), be32(v >>> 0)]); }
  function be16(v) { return new Uint8Array([(v >>> 8) & 255, v & 255]); }
  function ascii(s) { const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 255; return u; }
  const utf8 = (s) => new TextEncoder().encode(s);
  function box(type, ...parts) {
    const body = concatBytes(parts);
    return concatBytes([be32(8 + body.length), ascii(type), body]);
  }
  function fullbox(type, version, flags, ...parts) {
    return box(type, new Uint8Array([version, (flags >>> 16) & 255, (flags >>> 8) & 255, flags & 255]), ...parts);
  }
  // A table of 32-bit values, written in one go (hundreds of thousands of entries).
  function table32(values) {
    const out = new Uint8Array(values.length * 4);
    for (let i = 0, o = 0; i < values.length; i++, o += 4) {
      const v = values[i];
      out[o] = (v >>> 24) & 255; out[o + 1] = (v >>> 16) & 255; out[o + 2] = (v >>> 8) & 255; out[o + 3] = v & 255;
    }
    return out;
  }
  const UNITY_MATRIX = concatBytes([be32(0x10000), be32(0), be32(0), be32(0), be32(0x10000), be32(0), be32(0), be32(0), be32(0x40000000)]);
  const MOVIE_TIMESCALE = 1000;
  const NON_SYNC = 0x10000; // sample_is_non_sync_sample, in sample flags
  const MAX_BOX = 256 * 1024 * 1024; // a segment's mdat is a few MB; bigger is not MP4 at all (WebM, garbage)
  // Top-level boxes a torn stream can be picked up at again (never mdat: its samples
  // belong to a moof that is gone).
  const RESYNC_AT = new Set(['moof', 'styp', 'ftyp', 'sidx', 'moov', 'emsg', 'prft']);

  // ---- one track -----------------------------------------------------------
  class Track {
    constructor(kind) {
      this.kind = kind;
      this.id = null;          // track_ID inside the source init
      this.handler = null;     // 'vide' | 'soun'
      this.codec = null;       // 'avc1', 'mp4a', ...
      this.timescale = 0;      // the track's clock: the first init's; firstDts/lastBaseDts/nextDts count in it
      this.periodTs = 0;       // the clock of the current period (a re-init may bring another encoder's)
      this.secondsAcc = 0;     // media seconds stored so far
      this.language = 0x55C4;  // 'und'
      this.width = 0; this.height = 0; this.volume = 0;
      this.hdlr = null; this.mhd = null; // raw boxes copied from the first init
      this.entries = [];       // stsd sample entries seen so far (a re-init may bring a new one)
      this.sdi = 1;            // sample_description_index the chunks point at from now on
      this.trex = { duration: 0, size: 0, flags: 0 };
      this.dtsOffset = 0;      // added to every tfdt: bridges a clock that started over after a re-init
      this.afterInit = false;  // the next fragment is the first after an init segment
      this.inits = 0; this.fragments = 0; this.dropped = 0; this.gaps = 0; this.resets = 0;
      this.resyncs = 0; this.orphans = 0; this.skippedBytes = 0; // recoveries from a torn stream
      this.pending = null;     // bytes of an incomplete box, waiting for the rest
      this.frag = null;        // a parsed moof waiting for its mdat
      this.lastBaseDts = null; // for dropping a fragment appended twice
      this.nextDts = null;     // decode time where the next fragment should begin
      this.firstDts = null;
      this.durations = []; this.sizes = []; this.cts = []; this.sync = [];
      this.chunks = [];        // { offset (within the mdat payload), count }
      this.hasCts = false;
      this.bytes = 0;
    }
    get samples() { return this.sizes.length; }
    get seconds() { return this.secondsAcc; }
  }

  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const lcm = (a, b) => (a / gcd(a, b)) * b;

  // ---- the muxer -----------------------------------------------------------
  class Fmp4Muxer {
    constructor() {
      this.tracks = { video: new Track('video'), audio: new Track('audio') };
      this.parts = [];         // Blob parts of the mdat payload, in arrival order
      this.payloadBytes = 0;
    }

    // Bytes of one track's stream, in order, cut anywhere (the player appends
    // arbitrary fragments; a box may span several calls).
    feed(kind, u8) {
      const t = this.tracks[kind];
      if (!t) throw new Error('unknown track ' + kind);
      const b = t.pending ? concatBytes([t.pending, u8]) : u8;
      let off = 0;
      while (b.length - off >= 8) {
        let size = rd32(b, off), hdr = 8;
        const type = type4(b, off + 4);
        let bad = null;
        if (!/^[\x20-\x7e]{4}$/.test(type)) bad = 'not an MP4 stream';
        else if (size === 1) { if (b.length - off < 16) break; size = rd64(b, off + 8); hdr = 16; }
        else if (size === 0) bad = 'open-ended box ' + type;
        if (!bad && size < hdr) bad = 'malformed box ' + type;
        if (!bad && size > MAX_BOX) bad = type + ' box of ' + size + ' bytes';
        if (bad) {
          // The stream is torn here (an append the player aborted and re-sent, most
          // likely): pick it up again at the next box we recognise, drop the rest.
          if (!t.inits && !t.resyncs) throw new Error(t.kind + ': ' + bad); // not MP4 at all, from the very first bytes
          const p = this.nextBoundary(b, off + 1);
          t.frag = null;
          if (p < 0) { t.skippedBytes += Math.max(0, b.length - 7 - off); off = Math.max(off, b.length - 7); break; }
          t.skippedBytes += p - off; t.resyncs++;
          off = p;
          continue;
        }
        if (b.length - off < size) break;
        this.box(t, type, b, { type, start: off, body: off + hdr, end: off + size });
        off += size;
      }
      t.pending = off < b.length ? b.slice(off) : null;
      t.bytes += u8.length;
    }

    // The next position in b at or after `from` that looks like a top-level box a
    // stream can restart at; -1 if none.
    nextBoundary(b, from) {
      for (let p = from; p + 8 <= b.length; p++) {
        if (!RESYNC_AT.has(type4(b, p + 4))) continue;
        const size = rd32(b, p);
        if (size >= 8 && size <= MAX_BOX) return p;
      }
      return -1;
    }

    // The player aborted an append: whatever partial box is pending is void, and so
    // is a fragment header still waiting for its data.
    resync(kind) {
      const t = this.tracks[kind];
      if (!t) return;
      if (t.pending) { t.skippedBytes += t.pending.length; t.pending = null; }
      t.frag = null;
      t.resyncs++;
    }

    box(t, type, b, bx) {
      if (type === 'moov') this.init(t, b, bx);
      else if (type === 'moof') this.moof(t, b, bx);
      else if (type === 'mdat') this.mdat(t, b, bx);
      // ftyp, styp, sidx, emsg, free… carry nothing we need
    }

    init(t, b, moov) {
      const wanted = t.kind === 'video' ? 'vide' : 'soun';
      const trak = boxes(b, moov.body, moov.end).filter((x) => x.type === 'trak').find((tr) => {
        const h = descend(b, tr, ['mdia', 'hdlr']);
        return h && type4(b, h.body + 8) === wanted;
      });
      if (!trak) throw new Error(t.kind + ': no ' + wanted + ' track in the init segment');
      const tkhd = child(b, trak, 'tkhd');
      const mdia = child(b, trak, 'mdia');
      const mdhd = mdia && child(b, mdia, 'mdhd');
      const hdlr = mdia && child(b, mdia, 'hdlr');
      const minf = mdia && child(b, mdia, 'minf');
      const stsd = minf && descend(b, minf, ['stbl', 'stsd']);
      if (!tkhd || !mdhd || !hdlr || !minf || !stsd) throw new Error(t.kind + ': incomplete init segment');
      const tv = b[tkhd.body];
      const id = rd32(b, tkhd.body + (tv === 1 ? 20 : 12));
      const mv = b[mdhd.body];
      const timescale = rd32(b, mdhd.body + (mv === 1 ? 20 : 12));
      if (!timescale) throw new Error(t.kind + ': timescale missing');
      if (rd32(b, stsd.body + 4) < 1) throw new Error(t.kind + ': empty stsd');
      const entry = b.slice(stsd.body + 8, stsd.body + 8 + rd32(b, stsd.body + 8));
      let trex = { duration: 0, size: 0, flags: 0 };
      const mvex = child(b, moov, 'mvex');
      if (mvex) {
        for (const x of boxes(b, mvex.body, mvex.end).filter((y) => y.type === 'trex')) {
          if (rd32(b, x.body + 4) === id) trex = { duration: rd32(b, x.body + 12), size: rd32(b, x.body + 16), flags: rd32(b, x.body + 20) };
        }
      }
      t.inits++;
      t.afterInit = true;
      if (t.entries.length) {
        // A further init segment: the player switched streams mid-way (YouTube does this
        // on long videos, alternating between two encodings of the same quality). A new
        // sample entry gets its own index in the stsd and the chunks from now on point
        // at it — ordinary MP4. Another clock is fine: samples keep their native units
        // and the index is written in the common multiple (finish()).
        t.id = id; t.trex = trex; t.periodTs = timescale;
        const same = t.entries.findIndex((e) => e.length === entry.length && e.every((v, i) => v === entry[i]));
        if (same >= 0) t.sdi = same + 1;
        else { t.entries.push(entry); t.sdi = t.entries.length; }
        return;
      }
      t.id = id; t.trex = trex;
      t.volume = rd16(b, tkhd.body + (tv === 1 ? 36 : 24) + 8 + 4);
      t.width = rd32(b, tkhd.end - 8) >>> 16;
      t.height = rd32(b, tkhd.end - 4) >>> 16;
      t.timescale = timescale; t.periodTs = timescale;
      t.language = rd16(b, mdhd.body + (mv === 1 ? 32 : 20));
      t.handler = wanted;
      t.codec = type4(b, stsd.body + 12);
      t.entries = [entry];
      t.sdi = 1;
      t.hdlr = raw(b, hdlr);
      const mhd = child(b, minf, wanted === 'vide' ? 'vmhd' : 'smhd');
      t.mhd = mhd ? raw(b, mhd) : null;
    }

    moof(t, b, moof) {
      if (!t.entries.length) throw new Error(t.kind + ': fragment before the init segment');
      if (t.frag) { t.frag = null; t.orphans++; } // a header whose data never came (torn stream)
      const trafs = boxes(b, moof.body, moof.end).filter((x) => x.type === 'traf');
      if (trafs.length !== 1) throw new Error(t.kind + ': ' + trafs.length + ' traf boxes in one fragment');
      const traf = trafs[0];
      const tfhd = child(b, traf, 'tfhd');
      if (!tfhd) throw new Error(t.kind + ': tfhd missing');
      const tf = rd24(b, tfhd.body + 1);
      if (rd32(b, tfhd.body + 4) !== t.id) throw new Error(t.kind + ': fragment for another track');
      let p = tfhd.body + 8;
      if (tf & 0x01) throw new Error(t.kind + ': absolute base_data_offset is not supported');
      if (tf & 0x02) p += 4;
      const defDur = (tf & 0x08) ? rd32(b, (p += 4) - 4) : t.trex.duration;
      const defSize = (tf & 0x10) ? rd32(b, (p += 4) - 4) : t.trex.size;
      const defFlags = (tf & 0x20) ? rd32(b, (p += 4) - 4) : t.trex.flags;
      if (tf & 0x10000) throw new Error(t.kind + ': empty fragment');
      const tfdt = child(b, traf, 'tfdt');
      const baseDts = tfdt ? (b[tfdt.body] === 1 ? rd64(b, tfdt.body + 4) : rd32(b, tfdt.body + 4)) : null;
      const runs = [];
      let cursor = null; // where the next run's data begins when it says nothing (relative to the moof)
      for (const trun of boxes(b, traf.body, traf.end).filter((x) => x.type === 'trun')) {
        const v = b[trun.body], fl = rd24(b, trun.body + 1), count = rd32(b, trun.body + 4);
        let q = trun.body + 8;
        let pos = cursor;
        if (fl & 0x01) { pos = rdS32(b, q); q += 4; }
        if (pos == null) throw new Error(t.kind + ': run without a data offset');
        let firstFlags = null;
        if (fl & 0x04) { firstFlags = rd32(b, q); q += 4; }
        const run = { pos, durations: [], sizes: [], cts: [], sync: [], bytes: 0 };
        for (let i = 0; i < count; i++) {
          const dur = (fl & 0x100) ? rd32(b, (q += 4) - 4) : defDur;
          const size = (fl & 0x200) ? rd32(b, (q += 4) - 4) : defSize;
          const sf = (fl & 0x400) ? rd32(b, (q += 4) - 4) : (i === 0 && firstFlags != null ? firstFlags : defFlags);
          const cts = (fl & 0x800) ? (v === 0 ? rd32(b, (q += 4) - 4) : rdS32(b, (q += 4) - 4)) : 0;
          run.durations.push(dur); run.sizes.push(size); run.cts.push(cts); run.sync.push((sf & NON_SYNC) ? 0 : 1);
          run.bytes += size;
        }
        runs.push(run);
        cursor = pos + run.bytes;
      }
      t.frag = { baseDts, runs, moofSize: moof.end - moof.start };
    }

    mdat(t, b, mdat) {
      const frag = t.frag;
      if (!frag) {
        if (!t.entries.length) throw new Error(t.kind + ': data without a fragment header');
        t.orphans++; // data whose header was lost (torn stream): nothing to place it with
        return;
      }
      t.frag = null;
      t.fragments++;
      // Timeline bookkeeping is done on the track's clock; this period's samples may
      // tick in another one (f converts), and are stored in their own units.
      const f = t.timescale / t.periodTs;
      let baseDts = frag.baseDts;
      if (baseDts != null) {
        baseDts = baseDts * f + t.dtsOffset;
        // Right after a re-init the clock may have started over: bridge it so the
        // film simply goes on. A mere re-fetch lands within a buffer window of the
        // last fragment; a restart goes back by most of what was captured.
        const back = Math.max(10 * t.timescale, 0.5 * (t.nextDts - (t.firstDts || 0)));
        if (t.afterInit && t.nextDts != null && baseDts < t.nextDts - back) {
          t.dtsOffset += t.nextDts - baseDts; baseDts = t.nextDts; t.resets++;
        }
      }
      t.afterInit = false;
      // The same segment appended twice (the player re-fetching a window) — drop it.
      if (baseDts != null && t.lastBaseDts != null && baseDts <= t.lastBaseDts) { t.dropped++; return; }
      // A hole in the timeline (a segment lost): stretch the last sample over it so
      // that what follows stays in sync with the other track.
      if (baseDts != null && t.nextDts != null && baseDts > t.nextDts + 0.5 && t.durations.length) {
        const lastTs = t.chunks[t.chunks.length - 1].ts;
        const add = Math.round((baseDts - t.nextDts) * lastTs / t.timescale);
        t.durations[t.durations.length - 1] += add;
        t.secondsAcc += add / lastTs;
        t.nextDts = baseDts;
        t.gaps++;
      }
      if (baseDts != null) { if (t.firstDts == null) t.firstDts = baseDts; t.lastBaseDts = baseDts; }
      else if (t.firstDts == null) t.firstDts = 0;
      if (t.nextDts == null) t.nextDts = t.firstDts;
      const payloadStart = mdat.body, payloadLen = mdat.end - mdat.body;
      const payloadRelMoof = frag.moofSize + (mdat.body - mdat.start);
      for (const run of frag.runs) {
        const inPayload = run.pos - payloadRelMoof;
        if (inPayload < 0 || inPayload + run.bytes > payloadLen) throw new Error(t.kind + ': sample data outside its mdat');
        t.chunks.push({ offset: this.payloadBytes + inPayload, count: run.sizes.length, sdi: t.sdi, ts: t.periodTs });
        for (let i = 0; i < run.sizes.length; i++) {
          t.durations.push(run.durations[i]); t.sizes.push(run.sizes[i]); t.cts.push(run.cts[i]); t.sync.push(run.sync[i]);
          t.nextDts += run.durations[i] * f;
          t.secondsAcc += run.durations[i] / t.periodTs;
          if (run.cts[i]) t.hasCts = true;
        }
      }
      this.parts.push(new Blob([b.subarray(payloadStart, payloadStart + payloadLen)]));
      this.payloadBytes += payloadLen;
    }

    stats() {
      const one = (t) => ({
        codec: t.codec, samples: t.samples, seconds: Math.round(t.seconds * 10) / 10, bytes: t.bytes, width: t.width, height: t.height,
        inits: t.inits, entries: t.entries.length, fragments: t.fragments, dropped: t.dropped, gaps: t.gaps, resets: t.resets,
        resyncs: t.resyncs, orphans: t.orphans, skippedBytes: t.skippedBytes,
        timescale: t.timescale, periodTs: t.periodTs, id: t.id, sdi: t.sdi, firstDts: t.firstDts, lastBaseDts: t.lastBaseDts, nextDts: t.nextDts, dtsOffset: t.dtsOffset,
      });
      return { video: one(this.tracks.video), audio: one(this.tracks.audio), payloadBytes: this.payloadBytes };
    }

    // Seconds of a finished MP4 (ours or ffmpeg's), from its mvhd; null if unreadable.
    static durationOf(u8) {
      try {
        for (const top of boxes(u8, 0, u8.length)) {
          if (top.type !== 'moov') continue;
          const mvhd = child(u8, top, 'mvhd');
          if (!mvhd) return null;
          const v = u8[mvhd.body];
          const ts = rd32(u8, mvhd.body + (v === 1 ? 20 : 12));
          const dur = v === 1 ? rd64(u8, mvhd.body + 24) : rd32(u8, mvhd.body + 16);
          return ts ? dur / ts : null;
        }
      } catch (e) { /* not an MP4 */ }
      return null;
    }

    // The finished file as a Blob: ftyp, moov (index first), mdat.
    finish(tags) {
      const tracks = [this.tracks.video, this.tracks.audio].filter((t) => t.entries.length || t.samples);
      if (!tracks.length) throw new Error('nothing captured');
      for (const t of tracks) {
        if (!t.entries.length) throw new Error(t.kind + ': no init segment');
        if (!t.samples) throw new Error(t.kind + ': no samples');
        if (t.pending && t.pending.length >= 8) throw new Error(t.kind + ': stream ends inside a box');
      }
      // Timeline: both tracks are placed on the source's clock, relative to the
      // earliest presented instant, through an edit list (an empty edit for the
      // track that starts later; ffmpeg does the same). The index is written in the
      // least common multiple of the clocks the periods used, so every value is exact.
      const layout = tracks.map((t) => {
        let outTs = t.timescale;
        for (const ch of t.chunks) if (ch.ts !== outTs) outTs = lcm(outTs, ch.ts);
        if (outTs > 0x7FFFFFFF) throw new Error(t.kind + ': clocks too unlike to share an index');
        const n = t.samples;
        const dur = new Array(n), cts = new Array(n);
        let i = 0;
        for (const ch of t.chunks) {
          const k = outTs / ch.ts;
          for (let j = 0; j < ch.count; j++, i++) { dur[i] = t.durations[i] * k; cts[i] = t.cts[i] * k; }
        }
        let minCts = 0;
        if (t.hasCts) { minCts = Infinity; for (const c of cts) if (c < minCts) minCts = c; }
        const shift = -minCts; // makes every composition offset ≥ 0
        let minPts = Infinity, dts = 0;
        for (let s = 0; s < n; s++) { const p = dts + cts[s] + shift; if (p < minPts) minPts = p; dts += dur[s]; }
        const sumDur = dts;
        const firstDts = Math.round(t.firstDts * outTs / t.timescale);
        return { t, outTs, dur, cts, shift, minPts, sumDur, startSec: (firstDts + minCts + minPts) / outTs };
      });
      const t0 = Math.min(...layout.map((l) => l.startSec));
      for (const l of layout) l.delaySec = l.startSec - t0;

      const ftyp = box('ftyp', ascii('isom'), be32(512), ascii('isom'), ascii('iso2'), ascii('avc1'), ascii('mp41'));
      const size = this.moov(layout, 0, tags).length;                 // the index's size does not depend on the offsets
      const moov = this.moov(layout, ftyp.length + size + 16, tags); // 16: the mdat header (64-bit size)
      const mdatHeader = concatBytes([be32(1), ascii('mdat'), be64(16 + this.payloadBytes)]);
      return new Blob([ftyp, moov, mdatHeader, ...this.parts], { type: 'video/mp4' });
    }

    moov(layout, base, tags) {
      const movieDuration = Math.max(...layout.map((l) => Math.round((l.delaySec + l.sumDur / l.t.timescale) * MOVIE_TIMESCALE)));
      const mvhd = fullbox('mvhd', 0, 0, be32(0), be32(0), be32(MOVIE_TIMESCALE), be32(movieDuration),
        be32(0x10000), be16(0x100), new Uint8Array(10), UNITY_MATRIX, new Uint8Array(24), be32(layout.length + 1));
      const traks = layout.map((l, i) => this.trak(l, i + 1, base));
      const udta = this.udta(tags);
      return box('moov', mvhd, ...traks, ...(udta ? [udta] : []));
    }

    trak(l, id, base) {
      const t = l.t;
      const ts = l.outTs;
      const mediaDur = l.sumDur;
      const delay = Math.round(l.delaySec * MOVIE_TIMESCALE);
      const editDur = Math.round(mediaDur / ts * MOVIE_TIMESCALE);
      const trackDur = delay + editDur;
      const isVideo = t.handler === 'vide';

      const tkhd = fullbox('tkhd', 0, 3, be32(0), be32(0), be32(id), be32(0), be32(trackDur), new Uint8Array(8),
        be16(0), be16(0), be16(isVideo ? 0 : (t.volume || 0x100)), be16(0), UNITY_MATRIX,
        be32(isVideo ? t.width << 16 : 0), be32(isVideo ? t.height << 16 : 0));
      const edits = [];
      if (delay > 0) edits.push(concatBytes([be32(delay), be32(0xFFFFFFFF), be16(1), be16(0)]));
      edits.push(concatBytes([be32(editDur), be32(l.minPts), be16(1), be16(0)]));
      const edts = box('edts', fullbox('elst', 0, 0, be32(edits.length), ...edits));
      const mdhd = mediaDur < 4294967296
        ? fullbox('mdhd', 0, 0, be32(0), be32(0), be32(ts), be32(mediaDur), be16(t.language), be16(0))
        : fullbox('mdhd', 1, 0, be64(0), be64(0), be32(ts), be64(mediaDur), be16(t.language), be16(0));
      const mhd = t.mhd || (isVideo
        ? fullbox('vmhd', 0, 1, be16(0), be16(0), be16(0), be16(0))
        : fullbox('smhd', 0, 0, be16(0), be16(0)));
      const dinf = box('dinf', fullbox('dref', 0, 0, be32(1), fullbox('url ', 0, 1)));
      const stsd = fullbox('stsd', 0, 0, be32(t.entries.length), ...t.entries);
      const stbl = box('stbl', stsd, ...this.sampleTables(t, l, base));
      const minf = box('minf', mhd, dinf, stbl);
      const mdia = box('mdia', mdhd, t.hdlr, minf);
      return box('trak', tkhd, edts, mdia);
    }

    sampleTables(t, l, base) {
      const n = t.samples;
      // stts: runs of equal durations
      const stts = [];
      for (let i = 0; i < n; i++) {
        const d = l.dur[i];
        if (stts.length && stts[stts.length - 1].d === d) stts[stts.length - 1].c++;
        else stts.push({ c: 1, d });
      }
      const sttsVals = []; for (const e of stts) sttsVals.push(e.c, e.d);
      const out = [fullbox('stts', 0, 0, be32(stts.length), table32(sttsVals))];
      // ctts: composition offsets (shifted to be ≥ 0), only when there are any
      if (t.hasCts) {
        const ctts = [];
        for (let i = 0; i < n; i++) {
          const c = l.cts[i] + l.shift;
          if (ctts.length && ctts[ctts.length - 1].o === c) ctts[ctts.length - 1].c++;
          else ctts.push({ c: 1, o: c });
        }
        const vals = []; for (const e of ctts) vals.push(e.c, e.o);
        out.push(fullbox('ctts', 0, 0, be32(ctts.length), table32(vals)));
      }
      // stss: sync samples, only when some are not
      let allSync = true; for (let i = 0; i < n; i++) if (!t.sync[i]) { allSync = false; break; }
      if (!allSync) {
        const keys = []; for (let i = 0; i < n; i++) if (t.sync[i]) keys.push(i + 1);
        out.push(fullbox('stss', 0, 0, be32(keys.length), table32(keys)));
      }
      // stsz
      let same = true; for (let i = 1; i < n; i++) if (t.sizes[i] !== t.sizes[0]) { same = false; break; }
      out.push(same
        ? fullbox('stsz', 0, 0, be32(t.sizes[0]), be32(n))
        : fullbox('stsz', 0, 0, be32(0), be32(n), table32(t.sizes)));
      // stsc: samples per chunk and which stsd entry describes them, run-length by chunk
      const stsc = [];
      t.chunks.forEach((ch, i) => {
        const last = stsc[stsc.length - 1];
        if (!last || last.c !== ch.count || last.sdi !== ch.sdi) stsc.push({ first: i + 1, c: ch.count, sdi: ch.sdi });
      });
      const stscVals = []; for (const e of stsc) stscVals.push(e.first, e.c, e.sdi);
      out.push(fullbox('stsc', 0, 0, be32(stsc.length), table32(stscVals)));
      // co64: where each chunk's data lives in the file
      const co = new Uint8Array(t.chunks.length * 8);
      t.chunks.forEach((ch, i) => co.set(be64(base + ch.offset), i * 8));
      out.push(fullbox('co64', 0, 0, be32(t.chunks.length), co));
      return out;
    }

    udta(tags) {
      const items = [];
      const item = (name, text) => box(name, box('data', be32(1), be32(0), utf8(text)));
      if (tags && tags.title) items.push(item('\xA9nam', tags.title));
      if (tags && tags.artist) items.push(item('\xA9ART', tags.artist));
      if (!items.length) return null;
      const hdlr = fullbox('hdlr', 0, 0, be32(0), ascii('mdir'), ascii('appl'), new Uint8Array(9));
      return box('udta', fullbox('meta', 0, 0, hdlr, box('ilst', ...items)));
    }
  }

  root.Fmp4Muxer = Fmp4Muxer;
  if (typeof module !== 'undefined' && module.exports) module.exports = { Fmp4Muxer };
})(typeof globalThis !== 'undefined' ? globalThis : this);
