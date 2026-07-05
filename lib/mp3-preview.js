// MP3 preview byte-cap parser — pure Node, no ffmpeg.
//
// Guest previews (/api/preview/:recordId) must serve AT MOST ~N seconds of
// audio. The web service has no ffmpeg (only the analyzer Docker cron does),
// so instead of transcoding we compute how many BYTES of the source MP3
// correspond to N seconds and stream only that prefix. Truncated MP3 is valid
// input for every decoder — playback simply ends at the cut.
//
// Strategy, in order of accuracy:
//   1. Xing/Info VBR header  → exact average byte rate (bytes/duration).
//   2. First frame header    → CBR bitrate (correct for CBR, approximate for
//                              VBR files without a Xing tag — rare).
//   3. Fallback              → assume 128 kbps. Deliberately LOW: if the real
//                              bitrate is higher the preview is shorter than
//                              N seconds, never longer. Enforcement errs short.
//
// The parser is incremental: feed it the first chunk(s) of the file and it
// either resolves a byte cap or asks for more bytes (large embedded ID3 art
// can push the first audio frame hundreds of KB into the file).

const FALLBACK_BYTE_RATE = 16000; // 128 kbps in bytes/sec — see note above

// Layer III bitrate tables (kbps), indexed by the 4-bit bitrate field.
const BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATES_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];

const SAMPLE_RATES = {
  3: [44100, 48000, 32000], // MPEG1
  2: [22050, 24000, 16000], // MPEG2
  0: [11025, 12000, 8000]   // MPEG2.5
};

// How many bytes past the audio start we need to see before giving up on
// finding a frame header (junk/odd encodings) and falling back.
const FRAME_SEARCH_WINDOW = 4096;

// Never ask the caller to buffer more than this waiting for the first audio
// frame (pathological ID3 tags). Past it, resolve with the fallback rate
// measured from the START of the buffer — still a hard cap, just imprecise.
const MAX_PARSE_BYTES = 2 * 1024 * 1024;

function id3v2Size(buf) {
  // "ID3" magic + 2 version bytes + 1 flag byte + 4 syncsafe size bytes
  if (buf.length < 10) return null;
  if (buf[0] !== 0x49 || buf[1] !== 0x44 || buf[2] !== 0x33) return 0;
  const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
  const footer = (buf[5] & 0x10) ? 10 : 0;
  return 10 + size + footer;
}

function parseFrameHeader(buf, offset) {
  if (offset + 4 > buf.length) return null;
  const b1 = buf[offset], b2 = buf[offset + 1], b3 = buf[offset + 2], b4 = buf[offset + 3];
  if (b1 !== 0xff || (b2 & 0xe0) !== 0xe0) return null;

  const versionBits = (b2 >> 3) & 0x03; // 3=MPEG1, 2=MPEG2, 0=MPEG2.5, 1=reserved
  const layerBits   = (b2 >> 1) & 0x03; // 1=Layer III
  if (versionBits === 1 || layerBits !== 1) return null; // only Layer III (MP3)

  const bitrateIdx    = (b3 >> 4) & 0x0f;
  const sampleRateIdx = (b3 >> 2) & 0x03;
  if (bitrateIdx === 0 || bitrateIdx === 15 || sampleRateIdx === 3) return null;

  const mpeg1      = versionBits === 3;
  const bitrateKbps = (mpeg1 ? BITRATES_V1_L3 : BITRATES_V2_L3)[bitrateIdx];
  const sampleRate  = SAMPLE_RATES[versionBits][sampleRateIdx];
  const channelMode = (b4 >> 6) & 0x03; // 3 = mono
  const samplesPerFrame = mpeg1 ? 1152 : 576;

  return { mpeg1, bitrateKbps, sampleRate, mono: channelMode === 3, samplesPerFrame };
}

// Xing/Info tag sits after the side-info block of the first frame.
function xingOffset(frame) {
  if (frame.mpeg1) return frame.mono ? 4 + 17 : 4 + 32;
  return frame.mono ? 4 + 9 : 4 + 17;
}

function parseXing(buf, frameStart, frame) {
  const off = frameStart + xingOffset(frame);
  if (off + 16 > buf.length) return null;
  const tag = buf.toString('latin1', off, off + 4);
  if (tag !== 'Xing' && tag !== 'Info') return null;
  const flags = buf.readUInt32BE(off + 4);
  let p = off + 8;
  let frames = null, bytes = null;
  if (flags & 0x01) { frames = buf.readUInt32BE(p); p += 4; }
  if (flags & 0x02) { bytes = buf.readUInt32BE(p); p += 4; }
  if (!frames || !bytes) return null;
  return { frames, bytes };
}

/**
 * Try to compute the byte cap for `seconds` of audio from the file prefix in
 * `buf`. Returns either:
 *   { resolved: true, capBytes, byteRate, audioStart, method }
 *   { resolved: false, needBytes }  — feed more data (needBytes = total prefix
 *                                     length wanted) and call again.
 * A resolved cap is always a hard upper bound ≥ audioStart, so headers and
 * tag art are never truncated away from an otherwise-valid stream.
 */
export function computePreviewCap(buf, seconds) {
  const fallback = (audioStart) => ({
    resolved: true,
    capBytes: audioStart + Math.ceil(FALLBACK_BYTE_RATE * seconds),
    byteRate: FALLBACK_BYTE_RATE,
    audioStart,
    method: 'fallback'
  });

  const tagSize = id3v2Size(buf);
  if (tagSize === null) {
    return buf.length >= MAX_PARSE_BYTES ? fallback(0) : { resolved: false, needBytes: 10 };
  }

  const audioStart = tagSize;
  if (audioStart >= MAX_PARSE_BYTES) return fallback(0);

  const searchEnd = audioStart + FRAME_SEARCH_WINDOW;
  if (buf.length < Math.min(searchEnd, MAX_PARSE_BYTES)) {
    return { resolved: false, needBytes: Math.min(searchEnd, MAX_PARSE_BYTES) };
  }

  let frame = null, frameStart = audioStart;
  for (let i = audioStart; i < Math.min(searchEnd, buf.length - 4); i++) {
    frame = parseFrameHeader(buf, i);
    if (frame) { frameStart = i; break; }
  }
  if (!frame) return fallback(audioStart);

  const xing = parseXing(buf, frameStart, frame);
  if (xing) {
    const duration = (xing.frames * frame.samplesPerFrame) / frame.sampleRate;
    if (duration > 0) {
      const byteRate = xing.bytes / duration;
      return {
        resolved: true,
        capBytes: frameStart + Math.ceil(byteRate * seconds),
        byteRate,
        audioStart: frameStart,
        method: 'xing'
      };
    }
  }

  const byteRate = (frame.bitrateKbps * 1000) / 8;
  return {
    resolved: true,
    capBytes: frameStart + Math.ceil(byteRate * seconds),
    byteRate,
    audioStart: frameStart,
    method: 'cbr'
  };
}

export const _internal = { id3v2Size, parseFrameHeader, parseXing, FALLBACK_BYTE_RATE, MAX_PARSE_BYTES };
