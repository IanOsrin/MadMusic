// ============================================================================
// routes/tts.js — ElevenLabs TTS "Now Playing" announcement endpoint
//
// GET /api/tts/announce?title=Song+Name&artist=Artist+Name
//   → returns MP3 bytes of "Now playing: Song Name by Artist Name"
//
// Results are cached in an LRU cache so repeated plays of the same track
// are served instantly without hitting the ElevenLabs API again.
// ============================================================================

import { Router } from 'express';
import { fetch }  from 'undici';
import { LRUCache } from 'lru-cache';

const router = Router();

// ── Config ────────────────────────────────────────────────────────────────────
const ELEVEN_API_KEY  = process.env.ELEVENLABS_API_KEY;
const ELEVEN_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
const ELEVEN_MODEL    = process.env.ELEVENLABS_MODEL || 'eleven_turbo_v2';

// Cache up to 500 announcements for 24 hours — covers a full day of play rotation
const ttsCache = new LRUCache({ max: 500, ttl: 1000 * 60 * 60 * 24 });

// ── Route ─────────────────────────────────────────────────────────────────────
router.get('/tts/announce', async (req, res) => {
  if (!ELEVEN_API_KEY || !ELEVEN_VOICE_ID) {
    return res.status(503).json({ error: 'TTS not configured — set ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID in .env' });
  }

  const title  = (req.query.title  || '').toString().trim().slice(0, 200);
  const artist = (req.query.artist || '').toString().trim().slice(0, 200);

  if (!title && !artist) {
    return res.status(400).json({ error: 'title or artist required' });
  }

  const text = title && artist
    ? `Now playing: ${title}, by ${artist}.`
    : title
    ? `Now playing: ${title}.`
    : `Now playing by ${artist}.`;

  const cacheKey = text.toLowerCase();
  const cached   = ttsCache.get(cacheKey);

  if (cached) {
    console.log(`[TTS] Cache hit: "${text}"`);
    res.set('Content-Type', 'audio/mpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    return res.send(cached);
  }

  try {
    console.log(`[TTS] Generating: "${text}" via ElevenLabs (${ELEVEN_MODEL})`);

    const ttsRes = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(ELEVEN_VOICE_ID)}`,
      {
        method:  'POST',
        headers: {
          'xi-api-key':   ELEVEN_API_KEY,
          'Content-Type': 'application/json',
          'Accept':       'audio/mpeg'
        },
        body: JSON.stringify({
          text,
          model_id: ELEVEN_MODEL,
          voice_settings: {
            stability:        0.45,
            similarity_boost: 0.80,
            style:            0.20,
            use_speaker_boost: true
          }
        })
      }
    );

    if (!ttsRes.ok) {
      const errBody = await ttsRes.text().catch(() => '');
      console.error(`[TTS] ElevenLabs error ${ttsRes.status}:`, errBody);
      return res.status(502).json({ error: 'TTS upstream failed', detail: errBody });
    }

    const buffer = Buffer.from(await ttsRes.arrayBuffer());
    ttsCache.set(cacheKey, buffer);
    console.log(`[TTS] Cached ${buffer.length} bytes for: "${text}"`);

    res.set('Content-Type', 'audio/mpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(buffer);

  } catch (err) {
    console.error('[TTS] Request failed:', err.message);
    res.status(500).json({ error: 'TTS request failed' });
  }
});

export default router;
