// The fragmented-MP4 → MP4 muxer (extension/mp4mux.js) on a synthetic pair of
// tracks, built here box by box: an H.264-like video track with B-frames (signed
// composition offsets), an AAC-like audio track, a fragment appended twice and a
// hole in the video timeline. The output is checked box by box, byte by byte
// (co64 offsets really point at the samples), and through music-metadata.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { parseBuffer } from 'music-metadata';
import { probeMp4 } from '../mp4-probe.mjs';

const require = createRequire(import.meta.url);
const { Fmp4Muxer } = require('../../extension/mp4mux.js');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// ---- box builders ----------------------------------------------------------
const be16 = (v) => Buffer.from([(v >> 8) & 255, v & 255]);
const be32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0); return b; };
const s32 = (v) => { const b = Buffer.alloc(4); b.writeInt32BE(v); return b; };
const be64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(v)); return b; };
const box = (type, ...parts) => { const body = Buffer.concat(parts); return Buffer.concat([be32(8 + body.length), Buffer.from(type, 'latin1'), body]); };
const full = (type, version, flags, ...parts) => box(type, Buffer.from([version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255]), ...parts);
const zeros = (n) => Buffer.alloc(n);
const MATRIX = Buffer.concat([be32(0x10000), be32(0), be32(0), be32(0), be32(0x10000), be32(0), be32(0), be32(0), be32(0x40000000)]);

function init({ id, handler, timescale, stsdEntry, trex }) {
  const isVideo = handler === 'vide';
  const tkhd = full('tkhd', 0, 3, be32(0), be32(0), be32(id), be32(0), be32(0), zeros(8), be16(0), be16(0),
    be16(isVideo ? 0 : 0x100), be16(0), MATRIX, be32(isVideo ? 320 << 16 : 0), be32(isVideo ? 240 << 16 : 0));
  const mdhd = full('mdhd', 0, 0, be32(0), be32(0), be32(timescale), be32(0), be16(0x55C4), be16(0));
  const hdlr = full('hdlr', 0, 0, be32(0), Buffer.from(handler, 'latin1'), zeros(12), Buffer.from('Handler\0', 'latin1'));
  const mhd = isVideo ? full('vmhd', 0, 1, zeros(8)) : full('smhd', 0, 0, zeros(4));
  const dinf = box('dinf', full('dref', 0, 0, be32(1), full('url ', 0, 1)));
  const stbl = box('stbl', full('stsd', 0, 0, be32(1), stsdEntry), full('stts', 0, 0, be32(0)),
    full('stsc', 0, 0, be32(0)), full('stsz', 0, 0, be32(0), be32(0)), full('stco', 0, 0, be32(0)));
  const trak = box('trak', tkhd, box('mdia', mdhd, hdlr, box('minf', mhd, dinf, stbl)));
  const mvex = box('mvex', full('trex', 0, 0, be32(id), be32(1), be32(trex.duration), be32(trex.size), be32(trex.flags)));
  const mvhd = full('mvhd', 0, 0, be32(0), be32(0), be32(1000), be32(0), be32(0x10000), be16(0x100), zeros(10), MATRIX, zeros(24), be32(id + 1));
  return Buffer.concat([box('ftyp', Buffer.from('iso5', 'latin1'), be32(1), Buffer.from('isomiso5dash', 'latin1')), box('moov', mvhd, trak, mvex)]);
}
const avc1Entry = (w, h) => box('avc1', zeros(6), be16(1), zeros(16), be16(w), be16(h), be32(0x480000), be32(0x480000), be32(0), be16(1), zeros(32), be16(24), be16(0xFFFF),
  box('avcC', Buffer.from([1, 0x64, 0, 0x1F, 0xFF, 0xE1, 0, 0, 1, 0, 0])));
const avc1 = avc1Entry(320, 240);
const mp4a = box('mp4a', zeros(6), be16(1), zeros(8), be16(2), be16(16), be16(0), be16(0), be32(44100 << 16),
  box('esds', Buffer.from([0, 0, 0, 0, 3, 0])));

// One fragment: moof (one traf, one trun, moof-relative data offset) + mdat.
// `samples`: [{ size, cts?, sync? }], `sizesOnly` picks the audio-style trun.
function fragment({ id, seq, baseDts, samples, defDur, defFlags, sizesOnly }) {
  const data = Buffer.concat(samples.map((s) => s.bytes));
  const build = (dataOffset) => {
    const tfhd = sizesOnly
      ? full('tfhd', 0, 0x020000, be32(id))
      : full('tfhd', 0, 0x020028, be32(id), be32(defDur), be32(defFlags));
    const tfdt = full('tfdt', 1, 0, be64(baseDts));
    const trunFlags = sizesOnly ? 0x201 : 0xA05; // data_offset + sizes (+ first_sample_flags + signed cts)
    const rows = samples.map((s) => (sizesOnly ? be32(s.size) : Buffer.concat([be32(s.size), s32(s.cts)])));
    const trun = sizesOnly
      ? full('trun', 1, trunFlags, be32(samples.length), s32(dataOffset), ...rows)
      : full('trun', 1, trunFlags, be32(samples.length), s32(dataOffset), be32(0x02000000), ...rows); // first sample: sync
    return box('moof', full('mfhd', 0, 0, be32(seq)), box('traf', tfhd, tfdt, trun));
  };
  const moofSize = build(0).length;
  return Buffer.concat([build(moofSize + 8), box('mdat', data)]);
}

const pattern = (tag, n) => Buffer.alloc(n, tag);

// ---- the streams -----------------------------------------------------------
const VIDEO_TS = 90000, FRAME = 3000, AUDIO_TS = 44100, AAC = 1024;
const videoSamples = (f) => [
  { size: 50, cts: 0, bytes: pattern(0x10 + f * 3, 50) },        // I
  { size: 20, cts: 6000, bytes: pattern(0x11 + f * 3, 20) },     // P (shown later)
  { size: 30, cts: -3000, bytes: pattern(0x12 + f * 3, 30) },    // B (shown earlier)
];
const audioSamples = (f) => [10, 11, 12, 13].map((n, i) => ({ size: n, bytes: pattern(0x80 + f * 4 + i, n) }));
const HOLE = 9000; // the third video fragment starts 9000 ticks late

function videoStream() {
  return Buffer.concat([
    init({ id: 1, handler: 'vide', timescale: VIDEO_TS, stsdEntry: avc1, trex: { duration: FRAME, size: 0, flags: 0x10000 } }),
    fragment({ id: 1, seq: 1, baseDts: 0, samples: videoSamples(0), defDur: FRAME, defFlags: 0x10000 }),
    fragment({ id: 1, seq: 2, baseDts: 3 * FRAME, samples: videoSamples(1), defDur: FRAME, defFlags: 0x10000 }),
    fragment({ id: 1, seq: 3, baseDts: 6 * FRAME + HOLE, samples: videoSamples(2), defDur: FRAME, defFlags: 0x10000 }),
  ]);
}
function audioStream() {
  const second = fragment({ id: 2, seq: 2, baseDts: 4 * AAC, samples: audioSamples(1), sizesOnly: true });
  return Buffer.concat([
    init({ id: 2, handler: 'soun', timescale: AUDIO_TS, stsdEntry: mp4a, trex: { duration: AAC, size: 0, flags: 0 } }),
    fragment({ id: 2, seq: 1, baseDts: 0, samples: audioSamples(0), sizesOnly: true }),
    second, second, // appended twice, as a re-fetched window would be
    fragment({ id: 2, seq: 3, baseDts: 8 * AAC, samples: audioSamples(2), sizesOnly: true }),
  ]);
}

// Feed both streams in small slices, alternating, so boxes span calls.
function mux(slice = 1000) {
  const m = new Fmp4Muxer();
  const v = videoStream(), a = audioStream();
  for (let off = 0; off < Math.max(v.length, a.length); off += slice) {
    if (off < v.length) m.feed('video', new Uint8Array(v.subarray(off, Math.min(off + slice, v.length))));
    if (off < a.length) m.feed('audio', new Uint8Array(a.subarray(off, Math.min(off + slice, a.length))));
  }
  return m;
}

// ---- a reader for the output ------------------------------------------------
function walk(buf, start = 0, end = buf.length) {
  const out = [];
  let off = start;
  while (off + 8 <= end) {
    let size = buf.readUInt32BE(off), hdr = 8;
    const type = buf.toString('latin1', off + 4, off + 8);
    if (size === 1) { size = Number(buf.readBigUInt64BE(off + 8)); hdr = 16; }
    const b = { type, start: off, body: off + hdr, end: off + size };
    if (['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'udta', 'ilst'].includes(type)) b.kids = walk(buf, b.body, b.end);
    if (type === 'meta') b.kids = walk(buf, b.body + 4, b.end);
    out.push(b);
    off += size;
  }
  return out;
}
const kid = (b, type) => b.kids.find((k) => k.type === type);
const table = (buf, b, countAt = 4) => { const n = buf.readUInt32BE(b.body + countAt); const out = []; for (let i = 0; i < n; i++) out.push(buf.readUInt32BE(b.body + countAt + 4 + i * 4)); return out; };
const pairs = (buf, b) => { const n = buf.readUInt32BE(b.body + 4); const out = []; for (let i = 0; i < n; i++) out.push([buf.readUInt32BE(b.body + 8 + i * 8), buf.readInt32BE(b.body + 12 + i * 8)]); return out; };

async function finished(m, tags = { title: 'Test song', artist: 'Someone' }) {
  return Buffer.from(await m.finish(tags).arrayBuffer());
}

test('layout: ftyp, moov (index first) with two tracks, then mdat with a 64-bit size', async () => {
  const m = mux();
  const buf = await finished(m);
  const top = walk(buf);
  assert.deepEqual(top.map((b) => b.type), ['ftyp', 'moov', 'mdat']);
  assert.equal(buf.readUInt32BE(top[2].start), 1, 'mdat uses largesize');
  assert.equal(top[2].end, buf.length);
  assert.equal(top[2].end - top[2].body, m.payloadBytes);
  const moov = top[1];
  assert.equal(moov.kids.filter((k) => k.type === 'trak').length, 2);
  const mvhd = kid(moov, 'mvhd');
  assert.equal(buf.readUInt32BE(mvhd.body + 12), 1000, 'movie timescale');
  // video: 9 frames of 3000 ticks + the 9000-tick hole = 36000/90000 = 400 ms; audio: 12 × 1024 / 44100 = 279 ms
  assert.equal(buf.readUInt32BE(mvhd.body + 16), 400, 'movie duration (ms)');
});

test('video track: sizes, sync samples, non-negative composition offsets, edit list, hole stretched', async () => {
  const m = mux();
  const buf = await finished(m);
  const moov = walk(buf)[1];
  const trak = moov.kids.filter((k) => k.type === 'trak')[0];
  const stbl = kid(kid(kid(trak, 'mdia'), 'minf'), 'stbl');
  assert.equal(buf.toString('latin1', kid(stbl, 'stsd').body + 12, kid(stbl, 'stsd').body + 16), 'avc1');
  assert.deepEqual(table(buf, kid(stbl, 'stsz'), 8), [50, 20, 30, 50, 20, 30, 50, 20, 30]);
  assert.deepEqual(table(buf, kid(stbl, 'stss')), [1, 4, 7], 'first sample of each fragment is the keyframe');
  // stts: 3000 × 5, then the hole-stretched 6th sample (3000 + 9000), then 3000 × 3
  assert.deepEqual(pairs(buf, kid(stbl, 'stts')), [[5, 3000], [1, 12000], [3, 3000]]);
  // ctts: offsets shifted by +3000 so the B-frame's -3000 becomes 0
  assert.deepEqual(pairs(buf, kid(stbl, 'ctts')), [[1, 3000], [1, 9000], [1, 0], [1, 3000], [1, 9000], [1, 0], [1, 3000], [1, 9000], [1, 0]]);
  const elst = kid(kid(trak, 'edts'), 'elst');
  assert.equal(buf.readUInt32BE(elst.body + 4), 1, 'one edit: no delay');
  assert.equal(buf.readUInt32BE(elst.body + 8), 400, 'edit duration (ms)');
  assert.equal(buf.readUInt32BE(elst.body + 12), 3000, 'media_time = first presented composition time');
  const tkhd = kid(trak, 'tkhd');
  assert.equal(buf.readUInt32BE(tkhd.body + 12), 1, 'track_ID');
  assert.equal(buf.readUInt32BE(tkhd.body + 76) >>> 16, 320);
  assert.equal(buf.readUInt32BE(tkhd.body + 80) >>> 16, 240);
});

test('audio track: the fragment appended twice is dropped; constant durations; no stss/ctts', async () => {
  const m = mux();
  const buf = await finished(m);
  const moov = walk(buf)[1];
  const trak = moov.kids.filter((k) => k.type === 'trak')[1];
  const stbl = kid(kid(kid(trak, 'mdia'), 'minf'), 'stbl');
  assert.equal(buf.toString('latin1', kid(stbl, 'stsd').body + 12, kid(stbl, 'stsd').body + 16), 'mp4a');
  assert.deepEqual(table(buf, kid(stbl, 'stsz'), 8), [10, 11, 12, 13, 10, 11, 12, 13, 10, 11, 12, 13]);
  assert.deepEqual(pairs(buf, kid(stbl, 'stts')), [[12, 1024]]);
  assert.equal(kid(stbl, 'stss'), undefined);
  assert.equal(kid(stbl, 'ctts'), undefined);
  assert.equal(buf.readUInt32BE(kid(stbl, 'co64').body + 4), 3, 'three chunks');
  const tkhd = kid(trak, 'tkhd');
  assert.equal(buf.readUInt32BE(tkhd.body + 12), 2, 'track_ID');
  assert.equal(buf.readUInt16BE(tkhd.body + 36), 0x100, 'volume 1.0');
});

function checkOffsets(buf) {
  const moov = walk(buf)[1];
  const traks = moov.kids.filter((k) => k.type === 'trak');
  const expected = [
    [0, 1, 2].flatMap((f) => videoSamples(f).map((s) => s.bytes)),
    [0, 1, 2].flatMap((f) => audioSamples(f).map((s) => s.bytes)),
  ];
  traks.forEach((trak, ti) => {
    const stbl = kid(kid(kid(trak, 'mdia'), 'minf'), 'stbl');
    const sizes = table(buf, kid(stbl, 'stsz'), 8);
    const co64 = kid(stbl, 'co64');
    const n = buf.readUInt32BE(co64.body + 4);
    const stsc = kid(stbl, 'stsc');
    const entries = []; for (let i = 0; i < buf.readUInt32BE(stsc.body + 4); i++) entries.push([buf.readUInt32BE(stsc.body + 8 + i * 12), buf.readUInt32BE(stsc.body + 12 + i * 12)]);
    let sample = 0;
    for (let c = 0; c < n; c++) {
      let off = Number(buf.readBigUInt64BE(co64.body + 8 + c * 8));
      const perChunk = entries.filter((e) => e[0] <= c + 1).pop()[1];
      for (let i = 0; i < perChunk; i++, sample++) {
        assert.deepEqual(buf.subarray(off, off + sizes[sample]), expected[ti][sample], `track ${ti + 1} sample ${sample + 1}`);
        off += sizes[sample];
      }
    }
    assert.equal(sample, sizes.length);
  });
}

test('co64 offsets point at the sample bytes, for both tracks', async () => {
  checkOffsets(await finished(mux()));
});

test('tags and a real parser: music-metadata reads duration, title and artist; mp4-probe sees avc1 320×240 + mp4a', async () => {
  const buf = await finished(mux());
  const meta = await parseBuffer(buf, { mimeType: 'video/mp4' });
  assert.equal(meta.common.title, 'Test song');
  assert.equal(meta.common.artist, 'Someone');
  // music-metadata reports the AUDIO track's duration (12 × 1024 / 44100), not the movie's
  assert.ok(Math.abs(meta.format.duration - 12288 / 44100) < 0.001, 'duration ' + meta.format.duration);
  const tmp = path.join(root, 'tests', '.tmp');
  fs.mkdirSync(tmp, { recursive: true });
  const file = path.join(tmp, 'mp4mux-unit.mp4');
  fs.writeFileSync(file, buf);
  assert.deepEqual(probeMp4(file), { brand: 'isom', video: 'avc1', width: 320, height: 240, audio: 'mp4a' });
});

test('slicing does not matter: 1-byte, 1000-byte and 64 KB feeds give the same tables and valid offsets', async () => {
  const files = await Promise.all([1, 1000, 65536].map((n) => finished(mux(n))));
  const tables = files.map((buf) => walk(buf)[1].kids.filter((k) => k.type === 'trak').map((trak) => {
    const stbl = kid(kid(kid(trak, 'mdia'), 'minf'), 'stbl');
    return ['stts', 'ctts', 'stss', 'stsz', 'stsc'].map((t) => (kid(stbl, t) ? buf.subarray(kid(stbl, t).start, kid(stbl, t).end).toString('hex') : null));
  }));
  // the sample data may be interleaved differently (boxes complete in another order); the tables never
  for (const t of tables.slice(1)) assert.deepEqual(t, tables[0]);
  assert.ok(files.every((f) => f.length === files[0].length));
  files.forEach(checkOffsets);
});

test('a track that starts later gets an empty edit (delay)', async () => {
  const m = new Fmp4Muxer();
  m.feed('video', new Uint8Array(videoStream()));
  // audio that begins 0.5 s into the source: base decode time 22050
  const a = Buffer.concat([
    init({ id: 2, handler: 'soun', timescale: AUDIO_TS, stsdEntry: mp4a, trex: { duration: AAC, size: 0, flags: 0 } }),
    fragment({ id: 2, seq: 1, baseDts: 22050, samples: audioSamples(0), sizesOnly: true }),
  ]);
  m.feed('audio', new Uint8Array(a));
  const buf = await finished(m);
  const trak = walk(buf)[1].kids.filter((k) => k.type === 'trak')[1];
  const elst = kid(kid(trak, 'edts'), 'elst');
  assert.equal(buf.readUInt32BE(elst.body + 4), 2, 'empty edit + media edit');
  assert.equal(buf.readUInt32BE(elst.body + 8), 500, 'delay (ms)');
  assert.equal(buf.readUInt32BE(elst.body + 12), 0xFFFFFFFF, 'empty edit');
  const stats = m.stats();
  assert.equal(stats.video.codec, 'avc1');
  assert.equal(stats.audio.samples, 4);
});

const VIDEO_TREX = { duration: FRAME, size: 0, flags: 0x10000 };
const videoInit = (id, entry = avc1) => init({ id, handler: 'vide', timescale: VIDEO_TS, stsdEntry: entry, trex: VIDEO_TREX });
const videoFrag = (id, seq, baseDts, f) => fragment({ id, seq, baseDts, samples: videoSamples(f), defDur: FRAME, defFlags: 0x10000 });
const stscOf = (buf, stbl) => { const b = kid(stbl, 'stsc'); const out = []; for (let i = 0; i < buf.readUInt32BE(b.body + 4); i++) out.push([buf.readUInt32BE(b.body + 8 + i * 12), buf.readUInt32BE(b.body + 12 + i * 12), buf.readUInt32BE(b.body + 16 + i * 12)]); return out; };
const videoStbl = (buf) => { const trak = walk(buf)[1].kids.filter((k) => k.type === 'trak')[0]; return kid(kid(kid(trak, 'mdia'), 'minf'), 'stbl'); };

test('a second init segment with the same sample entry: the track simply goes on', async () => {
  const m = new Fmp4Muxer();
  m.feed('video', new Uint8Array(videoStream()));
  m.feed('video', new Uint8Array(Buffer.concat([videoInit(1), videoFrag(1, 4, 9 * FRAME + HOLE, 3)])));
  m.feed('audio', new Uint8Array(audioStream()));
  const buf = await finished(m);
  const stbl = videoStbl(buf);
  assert.equal(buf.readUInt32BE(kid(stbl, 'stsd').body + 4), 1, 'one sample entry');
  assert.equal(table(buf, kid(stbl, 'stsz'), 8).length, 12, 'four fragments of three samples');
  assert.deepEqual(stscOf(buf, stbl), [[1, 3, 1]]);
  const st = m.stats().video;
  assert.equal(st.inits, 2); assert.equal(st.entries, 1); assert.equal(st.fragments, 4); assert.equal(st.dropped, 0); assert.equal(st.resets, 0);
  assert.equal(buf.readUInt32BE(kid(walk(buf)[1], 'mvhd').body + 16), 500, 'movie duration (ms)');
});

test('a second init segment with a new sample entry (another encoding): a second stsd entry the later chunks point at', async () => {
  const m = new Fmp4Muxer();
  m.feed('video', new Uint8Array(videoStream()));
  m.feed('video', new Uint8Array(Buffer.concat([videoInit(7, avc1Entry(640, 360)), videoFrag(7, 4, 9 * FRAME + HOLE, 3), videoFrag(7, 5, 12 * FRAME + HOLE, 4)])));
  m.feed('audio', new Uint8Array(audioStream()));
  const buf = await finished(m);
  const stbl = videoStbl(buf);
  const stsd = kid(stbl, 'stsd');
  assert.equal(buf.readUInt32BE(stsd.body + 4), 2, 'two sample entries');
  const second = stsd.body + 8 + buf.readUInt32BE(stsd.body + 8);
  assert.equal(buf.readUInt16BE(second + 8 + 24), 640, 'the second entry is the new one');
  assert.deepEqual(stscOf(buf, stbl), [[1, 3, 1], [4, 3, 2]], 'chunks 4 and 5 use entry 2');
  assert.equal(table(buf, kid(stbl, 'stsz'), 8).length, 15);
  assert.deepEqual(table(buf, kid(stbl, 'stss')), [1, 4, 7, 10, 13]);
  const st = m.stats().video;
  assert.equal(st.entries, 2); assert.equal(st.fragments, 5); assert.equal(st.dropped, 0);
});

test('the clock starting over after a re-init is bridged; a mere re-fetch after it is still dropped', async () => {
  // fragments 10 s apart (holes stretched), then a re-init whose first fragment says t = 0
  const far = Buffer.concat([videoInit(1), videoFrag(1, 1, 0, 0), videoFrag(1, 2, 10 * VIDEO_TS, 1), videoFrag(1, 3, 20 * VIDEO_TS, 2)]);
  const m = new Fmp4Muxer();
  m.feed('video', new Uint8Array(far));
  m.feed('video', new Uint8Array(Buffer.concat([videoInit(1), videoFrag(1, 4, 0, 3), videoFrag(1, 5, 3 * FRAME, 4)])));
  m.feed('audio', new Uint8Array(audioStream()));
  const buf = await finished(m);
  const stbl = videoStbl(buf);
  assert.equal(table(buf, kid(stbl, 'stsz'), 8).length, 15, 'all five fragments kept');
  const st = m.stats().video;
  assert.equal(st.resets, 1); assert.equal(st.dropped, 0); assert.equal(st.gaps, 2);
  // 20 s + the last stretched sample (3 × 3000) … : total = 20 s + 9000 + 9000 + 9000 ticks
  assert.equal(buf.readUInt32BE(kid(walk(buf)[1], 'mvhd').body + 16), Math.round((20 * VIDEO_TS + 3 * 3 * FRAME) / VIDEO_TS * 1000));
  // a re-fetch after a re-init (a fragment already covered) is still a duplicate
  const m2 = new Fmp4Muxer();
  m2.feed('video', new Uint8Array(far));
  m2.feed('video', new Uint8Array(Buffer.concat([videoInit(1), videoFrag(1, 3, 20 * VIDEO_TS, 2), videoFrag(1, 4, 20 * VIDEO_TS + 3 * FRAME, 3)])));
  m2.feed('audio', new Uint8Array(audioStream()));
  await finished(m2);
  assert.equal(m2.stats().video.dropped, 1); assert.equal(m2.stats().video.resets, 0); assert.equal(m2.stats().video.samples, 12);
});

test('a re-init with another clock: samples keep their units, the index is written in the common multiple', async () => {
  const m = new Fmp4Muxer();
  m.feed('video', new Uint8Array(videoStream()));                       // 90000 ticks/s, frames of 3000
  // the other encoding ticks at 30000: frames of 1000, starting where the first left off (36000 → 12000)
  const other = init({ id: 2, handler: 'vide', timescale: 30000, stsdEntry: avc1Entry(1280, 720), trex: { duration: 1000, size: 0, flags: 0x10000 } });
  m.feed('video', new Uint8Array(Buffer.concat([other, fragment({ id: 2, seq: 4, baseDts: 12000, samples: videoSamples(3), defDur: 1000, defFlags: 0x10000 })])));
  m.feed('audio', new Uint8Array(audioStream()));
  const buf = await finished(m);
  const trak = walk(buf)[1].kids.filter((k) => k.type === 'trak')[0];
  const mdhd = kid(kid(trak, 'mdia'), 'mdhd');
  assert.equal(buf.readUInt32BE(mdhd.body + 12), 90000, 'index clock = lcm(90000, 30000)');
  assert.equal(buf.readUInt32BE(mdhd.body + 16), 36000 + 9000, 'media duration in that clock');
  const stbl = videoStbl(buf);
  assert.deepEqual(pairs(buf, kid(stbl, 'stts')), [[5, 3000], [1, 12000], [6, 3000]], 'the new period: 1000-tick frames became 3000');
  assert.deepEqual(pairs(buf, kid(stbl, 'ctts')).slice(-3), [[1, 9000], [1, 27000], [1, 0]], 'its offsets scaled too: 0, 18000, -9000 shifted by 9000');
  assert.equal(m.stats().video.seconds, 0.5);
  assert.equal(m.stats().video.dropped, 0);
});

test('a torn stream (an append the player aborted, then re-sent) is picked up again', async () => {
  const initBuf = videoInit(1), f1 = videoFrag(1, 1, 0, 0), f2 = videoFrag(1, 2, 3 * FRAME, 1), f3 = videoFrag(1, 3, 6 * FRAME + HOLE, 2);
  const torn = Buffer.concat([initBuf, f1, f2.subarray(0, f2.length - 20)]); // cut inside the second fragment's data
  // (a) with the abort signal from the hook: exact — the partial box is dropped, the re-sent fragment is whole
  const m = new Fmp4Muxer();
  m.feed('video', new Uint8Array(torn));
  m.resync('video');
  m.feed('video', new Uint8Array(Buffer.concat([f2, f3])));
  m.feed('audio', new Uint8Array(audioStream()));
  const buf = await finished(m);
  checkOffsets(buf);
  let st = m.stats().video;
  assert.equal(st.fragments, 3); assert.equal(st.dropped, 0); assert.equal(st.resyncs, 1); assert.ok(st.skippedBytes > 0);
  // (b) without the signal: the muxer notices the tear by itself and goes on from the next fragment it recognises
  const m2 = new Fmp4Muxer();
  m2.feed('video', new Uint8Array(Buffer.concat([torn, f2, f3])));
  m2.feed('audio', new Uint8Array(audioStream()));
  const buf2 = await finished(m2);
  st = m2.stats().video;
  assert.equal(st.samples, 9); assert.equal(st.resyncs, 1);
  assert.equal(buf2.readUInt32BE(kid(walk(buf2)[1], 'mvhd').body + 16), 400, 'the timeline is intact');
});

test('durationOf reads the movie duration of a finished file (ours or ffmpeg-style)', async () => {
  const buf = await finished(mux());
  assert.equal(Fmp4Muxer.durationOf(new Uint8Array(buf)), 0.4);
  assert.equal(Fmp4Muxer.durationOf(new Uint8Array([1, 2, 3])), null);
});

test('what it refuses: data before the header, an incomplete stream, not MP4 at all', () => {
  const m2 = new Fmp4Muxer();
  assert.throws(() => m2.feed('audio', new Uint8Array(box('mdat', Buffer.alloc(4)))), /before the init|without a fragment header/);
  const m3 = new Fmp4Muxer();
  const v = videoStream();
  m3.feed('video', new Uint8Array(v.subarray(0, v.length - 10)));
  m3.feed('audio', new Uint8Array(audioStream()));
  assert.throws(() => m3.finish({}), /inside a box/);
  const m5 = new Fmp4Muxer();
  assert.throws(() => m5.feed('video', new Uint8Array([0x1A, 0x45, 0xDF, 0xA3, 0x9F, 0x42, 0x86, 0x81, 1, 2, 3, 4])), /not an MP4/);
});
