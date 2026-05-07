// ============================================================================
// routes/tts.js — ElevenLabs TTS "Now Playing" announcement endpoint
//
// GET /api/tts/voices
//   → returns list of available ElevenLabs voices (cached 1 hr)
//
// GET /api/tts/announce?title=Song+Name&artist=Artist+Name[&voiceId=xxx]
//   → returns MP3 bytes of "Now playing: Song Name by Artist Name"
//   voiceId is optional — falls back to ELEVENLABS_VOICE_ID in .env
//
// Results are cached per voice+text for 24 hours.
// ============================================================================

import { Router } from 'express';
import { fetch }  from 'undici';
import { LRUCache } from 'lru-cache';

const router = Router();

// ── Config ────────────────────────────────────────────────────────────────────
const ELEVEN_API_KEY      = process.env.ELEVENLABS_API_KEY;
const ELEVEN_VOICE_ID_DEF = process.env.ELEVENLABS_VOICE_ID;
const ELEVEN_MODEL        = process.env.ELEVENLABS_MODEL || 'eleven_turbo_v2';

// Cache per voice+text combo, 24 hr TTL
const ttsCache    = new LRUCache({ max: 1000, ttl: 1000 * 60 * 60 * 24 });
// Voice list cached for 1 hour
const voicesCache = new LRUCache({ max: 1,    ttl: 1000 * 60 * 60 });

// ── GET /api/tts/voices ───────────────────────────────────────────────────────
router.get('/tts/voices', async (req, res) => {
  if (!ELEVEN_API_KEY) {
    return res.status(503).json({ error: 'TTS not configured — set ELEVENLABS_API_KEY in .env' });
  }

  const cached = voicesCache.get('list');
  if (cached) return res.json(cached);

  try {
    const r = await fetch('https://api.elevenlabs.io/v1/voices', {
      headers: { 'xi-api-key': ELEVEN_API_KEY }
    });
    if (!r.ok) {
      const err = await r.text().catch(() => '');
      console.error(`[TTS] Voices fetch error ${r.status}:`, err);
      return res.status(502).json({ error: 'Could not fetch voices from ElevenLabs' });
    }
    const data   = await r.json();
    const voices = (data.voices || [])
      .map(v => ({ id: v.voice_id, name: v.name, category: v.category || 'generated' }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const payload = { voices, default: ELEVEN_VOICE_ID_DEF };
    voicesCache.set('list', payload);
    console.log(`[TTS] Fetched ${voices.length} voices from ElevenLabs`);
    res.json(payload);
  } catch (err) {
    console.error('[TTS] Voices request failed:', err.message);
    res.status(500).json({ error: 'Voices request failed' });
  }
});

// ── GET /api/tts/announce ─────────────────────────────────────────────────────
router.get('/tts/announce', async (req, res) => {
  if (!ELEVEN_API_KEY) {
    return res.status(503).json({ error: 'TTS not configured — set ELEVENLABS_API_KEY in .env' });
  }

  const title   = (req.query.title   || '').toString().trim().slice(0, 200);
  const artist  = (req.query.artist  || '').toString().trim().slice(0, 200);
  const voiceId = (req.query.voiceId || '').toString().trim() || ELEVEN_VOICE_ID_DEF;

  if (!voiceId) {
    return res.status(503).json({ error: 'No voice configured — set ELEVENLABS_VOICE_ID in .env or pass voiceId param' });
  }
  if (!title && !artist) {
    return res.status(400).json({ error: 'title or artist required' });
  }

  const text = title && artist
    ? `Now playing: ${title}, by ${artist}.`
    : title
    ? `Now playing: ${title}.`
    : `Now playing by ${artist}.`;

  // Cache key includes voice so different voices don't collide
  const cacheKey = `${voiceId}:${text.toLowerCase()}`;
  const cached   = ttsCache.get(cacheKey);

  if (cached) {
    console.log(`[TTS] Cache hit (${voiceId}): "${text}"`);
    res.set('Content-Type', 'audio/mpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    return res.send(cached);
  }

  try {
    console.log(`[TTS] Generating (voice:${voiceId}): "${text}" via ElevenLabs (${ELEVEN_MODEL})`);

    const ttsRes = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`,
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
            stability:         0.45,
            similarity_boost:  0.80,
            style:             0.20,
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
    console.log(`[TTS] Cached ${buffer.length} bytes for voice ${voiceId}: "${text}"`);

    res.set('Content-Type', 'audio/mpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(buffer);

  } catch (err) {
    console.error('[TTS] Request failed:', err.message);
    res.status(500).json({ error: 'TTS request failed' });
  }
});

export default router;
