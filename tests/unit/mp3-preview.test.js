import { describe, it, expect } from 'vitest';
import { computePreviewCap, _internal } from '../../lib/mp3-preview.js';

const SECONDS = 30;

// ── buffer builders ─────────────────────────────────────────────────────────

// MPEG1 Layer III frame header: 0xFF 0xFB, bitrate/sample-rate in byte 3.
// 0x90 = bitrate idx 9 (128 kbps), sample rate idx 0 (44100), no padding.
function cbrHeader({ bitrateIdx = 9, stereo = true } = {}) {
  const b3 = (bitrateIdx << 4) | 0x00;
  const b4 = stereo ? 0x00 : 0xc0;
  return Buffer.from([0xff, 0xfb, b3, b4]);
}

function id3Tag(payloadSize) {
  // syncsafe encoding of payloadSize (7 bits per byte)
  const s = payloadSize;
  const header = Buffer.from([
    0x49, 0x44, 0x33, 0x04, 0x00, 0x00,
    (s >> 21) & 0x7f, (s >> 14) & 0x7f, (s >> 7) & 0x7f, s & 0x7f
  ]);
  return Buffer.concat([header, Buffer.alloc(payloadSize)]);
}

function xingFrame({ frames, bytes, stereo = true }) {
  // MPEG1: side info 32 (stereo) / 17 (mono) → Xing at 4 + sideInfo
  const frame = Buffer.alloc(1044); // 128kbps@44100 frame size ≈ 417; oversize is fine
  cbrHeader({ stereo }).copy(frame, 0);
  const off = 4 + (stereo ? 32 : 17);
  frame.write('Xing', off, 'latin1');
  frame.writeUInt32BE(0x03, off + 4);        // frames + bytes present
  frame.writeUInt32BE(frames, off + 8);
  frame.writeUInt32BE(bytes, off + 12);
  return frame;
}

// ── tests ───────────────────────────────────────────────────────────────────

describe('computePreviewCap', () => {
  it('CBR 128kbps, no ID3: cap = 30s worth of bytes', () => {
    const buf = Buffer.concat([cbrHeader(), Buffer.alloc(8192)]);
    const r = computePreviewCap(buf, SECONDS);
    expect(r.resolved).toBe(true);
    expect(r.method).toBe('cbr');
    expect(r.byteRate).toBe(16000);            // 128 kbps
    expect(r.capBytes).toBe(0 + 16000 * SECONDS);
  });

  it('CBR 320kbps: higher bitrate → larger cap, same duration', () => {
    const buf = Buffer.concat([cbrHeader({ bitrateIdx: 14 }), Buffer.alloc(8192)]);
    const r = computePreviewCap(buf, SECONDS);
    expect(r.byteRate).toBe(40000);            // 320 kbps
    expect(r.capBytes).toBe(40000 * SECONDS);
  });

  it('skips an ID3v2 tag and caps relative to the first frame', () => {
    const tag = id3Tag(2000);
    const buf = Buffer.concat([tag, cbrHeader(), Buffer.alloc(8192)]);
    const r = computePreviewCap(buf, SECONDS);
    expect(r.resolved).toBe(true);
    expect(r.audioStart).toBe(tag.length);
    expect(r.capBytes).toBe(tag.length + 16000 * SECONDS);
  });

  it('uses the Xing average byte rate for VBR files', () => {
    // 1000 frames * 1152 samples / 44100 Hz = 26.122s; 4,000,000 bytes total
    const buf = Buffer.concat([xingFrame({ frames: 1000, bytes: 4_000_000 }), Buffer.alloc(8192)]);
    const r = computePreviewCap(buf, SECONDS);
    expect(r.method).toBe('xing');
    const duration = (1000 * 1152) / 44100;
    expect(r.capBytes).toBe(Math.ceil((4_000_000 / duration) * SECONDS));
  });

  it('asks for more bytes when the ID3 tag extends past the buffer', () => {
    const tag = id3Tag(100_000);
    const r = computePreviewCap(tag.subarray(0, 4096), SECONDS);
    expect(r.resolved).toBe(false);
    expect(r.needBytes).toBeGreaterThan(100_000);
  });

  it('falls back to a conservative 128kbps cap on unparseable data', () => {
    const buf = Buffer.alloc(8192, 0x41); // "AAAA…" — no sync word anywhere
    const r = computePreviewCap(buf, SECONDS);
    expect(r.resolved).toBe(true);
    expect(r.method).toBe('fallback');
    expect(r.capBytes).toBe(_internal.FALLBACK_BYTE_RATE * SECONDS);
  });

  it('fallback never yields MORE than 30s for common bitrates', () => {
    // If the real file is ≥128 kbps, a 128 kbps-assumed cap is ≤ 30s of audio.
    const cap = _internal.FALLBACK_BYTE_RATE * SECONDS;
    for (const kbps of [128, 192, 256, 320]) {
      const realByteRate = (kbps * 1000) / 8;
      expect(cap / realByteRate).toBeLessThanOrEqual(SECONDS + 0.001);
    }
  });

  it('needs at least 10 bytes to even classify the file', () => {
    const r = computePreviewCap(Buffer.alloc(4), SECONDS);
    expect(r.resolved).toBe(false);
  });

  it('mono Xing offset is honoured', () => {
    const buf = Buffer.concat([xingFrame({ frames: 500, bytes: 1_000_000, stereo: false }), Buffer.alloc(8192)]);
    const r = computePreviewCap(buf, SECONDS);
    expect(r.method).toBe('xing');
  });
});
