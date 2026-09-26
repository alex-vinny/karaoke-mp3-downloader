// Minimal MP4 box walker for the tests: which codecs the file holds and the video
// size, without pulling in ffprobe. Enough to assert "H.264 720p + AAC".
import fs from 'node:fs';

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl']);
const VIDEO = new Set(['avc1', 'avc3', 'hvc1', 'hev1', 'vp09', 'av01']);
const AUDIO = new Set(['mp4a', 'Opus', 'ac-3', 'ec-3', 'fLaC']);

export function probeMp4(file) {
  const buf = fs.readFileSync(file);
  const out = { brand: null, video: null, width: null, height: null, audio: null };
  walk(buf, 0, buf.length, out);
  return out;
}

function walk(buf, start, end, out) {
  let off = start;
  while (off + 8 <= end) {
    let size = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    let header = 8;
    if (size === 1) { size = Number(buf.readBigUInt64BE(off + 8)); header = 16; } // largesize
    else if (size === 0) size = end - off;                                        // to the end
    if (size < header) break;
    const bodyStart = off + header;
    const bodyEnd = Math.min(end, off + size);
    if (type === 'ftyp') out.brand = buf.toString('latin1', bodyStart, bodyStart + 4);
    else if (CONTAINERS.has(type)) walk(buf, bodyStart, bodyEnd, out);
    else if (type === 'stsd') walk(buf, bodyStart + 8, bodyEnd, out); // version+flags, entry_count
    else if (VIDEO.has(type)) {
      out.video = type;
      // SampleEntry: 6 reserved + 2 data_reference_index; VisualSampleEntry: 16 bytes
      // of pre_defined/reserved, then width and height (16 bits each).
      out.width = buf.readUInt16BE(bodyStart + 24);
      out.height = buf.readUInt16BE(bodyStart + 26);
    } else if (AUDIO.has(type)) out.audio = type;
    off += size;
  }
}
