import ffmpeg from 'fluent-ffmpeg'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { readFile, unlink } from 'fs/promises'

/**
 * Transcode an audio file to MP3.
 * @param {string} inputPath — path to source audio file (WAV, FLAC, etc.)
 * @param {number} bitrate   — kbps, e.g. 320 or 128
 * @returns {Promise<Buffer>} — MP3 buffer
 */
export async function transcodeToMp3(inputPath, bitrate = 320) {
  const outPath = join(tmpdir(), `${randomUUID()}.mp3`)
  await new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .audioCodec('libmp3lame')
      .audioBitrate(bitrate)
      .audioChannels(2)
      .format('mp3')
      .on('error', (err) => reject(new Error(`ffmpeg error: ${err.message}`)))
      .on('end', resolve)
      .save(outPath)
  })
  const buf = await readFile(outPath)
  await unlink(outPath).catch(() => {})
  return buf
}

/**
 * Generate a waveform from a WAV buffer.
 * Parses the RIFF/WAV PCM data, mixes to mono, downsamples to ~1000 RMS points.
 * @param {Buffer} wavBuffer
 * @returns {{ peaks: number[] }} — values 0..1
 */
export function generateWaveform(wavBuffer) {
  const buf = Buffer.isBuffer(wavBuffer) ? wavBuffer : Buffer.from(wavBuffer)

  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Not a valid WAV file')
  }

  // Walk RIFF chunks to find 'fmt ' and 'data'
  let fmt = null
  let dataStart = -1
  let dataBytes = 0
  let offset = 12

  while (offset < buf.length - 8) {
    const id   = buf.toString('ascii', offset, offset + 4)
    const size = buf.readUInt32LE(offset + 4)
    const bodyStart = offset + 8

    if (id === 'fmt ') {
      fmt = {
        audioFormat:  buf.readUInt16LE(bodyStart),      // 1 = PCM, 3 = float
        numChannels:  buf.readUInt16LE(bodyStart + 2),
        sampleRate:   buf.readUInt32LE(bodyStart + 4),
        bitsPerSample: buf.readUInt16LE(bodyStart + 14)
      }
    } else if (id === 'data') {
      dataStart = bodyStart
      dataBytes = size
      break
    }

    offset = bodyStart + size + (size % 2)  // chunks are word-aligned
  }

  if (!fmt) throw new Error('WAV fmt chunk not found')
  if (dataStart < 0) throw new Error('WAV data chunk not found')

  const { numChannels, bitsPerSample, audioFormat } = fmt
  const bytesPerSample = bitsPerSample / 8
  const bytesPerFrame  = bytesPerSample * numChannels
  const totalFrames    = Math.floor(dataBytes / bytesPerFrame)

  // Extract mono float samples
  const samples = new Float32Array(totalFrames)
  for (let i = 0; i < totalFrames; i++) {
    const frameOff = dataStart + i * bytesPerFrame
    let sum = 0
    for (let ch = 0; ch < numChannels; ch++) {
      const sampleOff = frameOff + ch * bytesPerSample
      let val = 0
      if (audioFormat === 3) {
        // IEEE float
        val = buf.readFloatLE(sampleOff)
      } else if (bitsPerSample === 8) {
        val = (buf.readUInt8(sampleOff) - 128) / 128
      } else if (bitsPerSample === 16) {
        val = buf.readInt16LE(sampleOff) / 32768
      } else if (bitsPerSample === 24) {
        const lo = buf.readUInt16LE(sampleOff)
        const hi = buf.readInt8(sampleOff + 2)
        val = ((hi << 16) | lo) / 8388608
      } else if (bitsPerSample === 32) {
        val = buf.readInt32LE(sampleOff) / 2147483648
      }
      sum += val
    }
    samples[i] = sum / numChannels
  }

  // Downsample to ~1000 RMS points
  const NUM_POINTS  = 1000
  const chunkSize   = Math.max(1, Math.floor(totalFrames / NUM_POINTS))
  const peaks       = []
  let maxRms        = 0

  for (let i = 0; i < NUM_POINTS; i++) {
    const start = i * chunkSize
    const end   = Math.min(start + chunkSize, totalFrames)
    let sumSq   = 0
    for (let j = start; j < end; j++) {
      sumSq += samples[j] * samples[j]
    }
    const rms = Math.sqrt(sumSq / (end - start))
    peaks.push(rms)
    if (rms > maxRms) maxRms = rms
  }

  // Normalise to 0..1
  const normalised = maxRms > 0
    ? peaks.map(p => Math.round((p / maxRms) * 1000) / 1000)
    : peaks.map(() => 0)

  return { peaks: normalised }
}
