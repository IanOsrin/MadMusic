// routes/maddie.js — Maddie, the record shop assistant (prototype, ships dark).
//
// POST /api/maddie/chat  { messages: [{role, content}, ...] }
//                      → { reply, tracks: [{recordId, title, artist, ...}] }
//
// Maddie is a text-only chat assistant over the REAL catalogue: Claude with
// tools that call this server's own public read endpoints (search, similar
// albums, artist bios, public playlists). She recommends only what the
// catalogue actually holds, hands back recordIds so the frontend can play
// previews through the normal guest chokepoint, and never sells.
//
// Mounted only when MADDIE_ENABLED=true (server.js). Requires
// ANTHROPIC_API_KEY in the environment — without it the route answers 503
// with a clear message instead of crashing.
//
// Cost/abuse guards: per-IP rate limit, capped history, capped message
// length, capped tool iterations.

import { Router } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { searchShelves, semanticShelvesAvailable } from '../lib/semantic-shelves.js';

const router = Router();

// Haiku by default — Maddie's job (persona + tool calls over a catalogue) sits
// comfortably in the cheapest tier: ~1c per visitor message. Set MADDIE_MODEL
// to a bigger model if her taste ever needs the upgrade.
const MADDIE_MODEL = process.env.MADDIE_MODEL || 'claude-haiku-4-5';
const SELF = `http://127.0.0.1:${process.env.PORT || 3000}`;
const MAX_TOOL_ITERATIONS = 6;
const MAX_HISTORY = 16;          // messages kept per request
const MAX_MSG_CHARS = 1500;      // per message
const RATE_LIMIT = { max: 30, windowMs: 10 * 60 * 1000 }; // per IP

// ── persona ──────────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are Maddie, the assistant behind the counter at MAD Music — a small online record shop sitting on the Gallo vault, the deepest archive of South African music anywhere (about sixty thousand recordings, from the 1950s to now). Much of it exists nowhere else. Visitors can play a free 30-second preview of anything.

Your character: you grew up among these crates. Warm, quick, a little opinionated — the sharp one behind the counter who plays people things instead of describing them. Light South African seasoning in your speech (an "eish" when the shelves let someone down, a "sharp" when they don't) — never so much that a visitor in Stockholm needs a glossary. You serve a 70-year-old asking for Mahlathini and a 25-year-old crate-digger from Berlin with exactly the same respect.

House rules — these are absolute:
1. PLAY FIRST, TALK SECOND. When you recommend music, ALWAYS call recommend_tracks so the visitor gets press-play cards. At most 3 tracks at a time — a short stack, not the whole shelf.
2. ONLY THE CATALOGUE. Recommend only tracks you have actually seen in a tool result this conversation. Never invent artists, titles or recordIds. If asked about music in general, steer back to what's on the shelves.
3. HONEST MISSES. If the search comes up empty, say so plainly ("Eish — that one's not on our shelves") and offer the nearest thing that IS here. Never pretend.
4. ONE LINE OF STORY, not a lecture. If artist_info gives you something interesting, spend it in a sentence.
5. ASK ONE GOOD QUESTION back when the request is vague ("for dancing or for remembering?") — one question, not an interrogation.
6. NEVER SELL. No mention of subscriptions, pricing or signing up. Ever. If asked what this place is: a small shop on a very big vault, slowly bringing the archive back out, tape by tape; anyone can taste anything for free.
7. KEEP IT SHORT. Two to four sentences for most replies. This is a chat window, not a letter.
8. STAY AT THE COUNTER. You only talk about the music here — not other streaming services, not news, not anything else. Deflect gently and bring it back to the shelves.

Tool notes: search_shelves is your main move — try artist/track/album params for specific names and q for moods or free text. If a first search misses, try once more with different terms before declaring a miss. similar_albums works when you have an artist+album to seed from. recordIds must be copied EXACTLY from tool results into recommend_tracks.`;

// ── tools ────────────────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'search_shelves',
    description: 'Search the catalogue. Use artist/track/album for specific names, q for free-text or genre-ish queries. Returns up to 10 tracks with recordIds.',
    input_schema: {
      type: 'object',
      properties: {
        q:      { type: 'string', description: 'free-text query (mood, genre, words from a lyric or title)' },
        artist: { type: 'string' },
        track:  { type: 'string' },
        album:  { type: 'string' },
      },
    },
  },
  {
    name: 'similar_albums',
    description: 'Find albums similar to a seed track/album (semantic similarity + tempo). Needs artist and title of the seed.',
    input_schema: {
      type: 'object',
      properties: {
        artist: { type: 'string' },
        title:  { type: 'string', description: 'album or track title to seed from' },
      },
      required: ['artist'],
    },
  },
  {
    name: 'artist_info',
    description: 'Fetch the shop\'s biography card for an artist, if one exists. Good for one line of story.',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
  },
  {
    name: 'list_playlists',
    description: 'List the shop\'s curated playlists (built by Kwela, who stocks the shelves).',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'recommend_tracks',
    description: 'Hand the visitor playable track cards. Call this EVERY time you recommend specific tracks (max 3). Copy recordId/title/artist exactly from earlier tool results.',
    input_schema: {
      type: 'object',
      properties: {
        tracks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              recordId:   { type: 'string' },
              title:      { type: 'string' },
              artist:     { type: 'string' },
              album:      { type: 'string' },
              year:       { type: 'string' },
              artworkUrl: { type: 'string' },
            },
            required: ['recordId', 'title', 'artist'],
          },
        },
      },
      required: ['tracks'],
    },
  },
];

// ── tool executors (self-fetch against this server's public endpoints) ──────
const pick = (f, names) => {
  for (const n of names) {
    const v = f?.[n];
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
};

function compactTrack(item) {
  const f = item.fields || item.fieldData || {};
  return {
    recordId: String(item.recordId),
    title:  pick(f, ['Track Name', 'Tape Files::Track Name']),
    artist: pick(f, ['Track Artist', 'Album Artist', 'Tape Files::Album Artist']),
    album:  pick(f, ['Album Title', 'Tape Files::Album Title']),
    year:   pick(f, ['Year of Release']),
    genre:  pick(f, ['Genre', 'Local Genre']),
    artworkUrl: pick(f, ['Artwork_S3_URL', 'Tape Files::Artwork_S3_URL']),
  };
}

async function selfGet(path) {
  const res = await fetch(`${SELF}${path}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) return { _httpStatus: res.status };
  return res.json();
}

async function executeTool(name, input, ctx) {
  switch (name) {
    case 'search_shelves': {
      const p = new URLSearchParams({ limit: '10' });
      for (const k of ['q', 'artist', 'track', 'album']) {
        if (input?.[k]) p.set(k, String(input[k]).slice(0, 100));
      }
      const data = await selfGet(`/api/search?${p}`);
      const items = (data.items || []).map(compactTrack).filter(t => t.title);
      return items.length
        ? { found: items.length, tracks: items }
        : { found: 0, note: 'nothing on the shelves for that — try different terms once, then be honest about the miss', suggestions: data.suggestions || [] };
    }
    case 'similar_albums': {
      const p = new URLSearchParams({ limit: '6' });
      if (input?.artist) p.set('artist', String(input.artist).slice(0, 100));
      if (input?.title)  p.set('title', String(input.title).slice(0, 100));
      const data = await selfGet(`/api/suggestions?${p}`);
      const items = (data.items || data.suggestions || []).slice(0, 6).map(s => ({
        artist: s.artist || s.albumArtist || '',
        album:  s.album || s.albumTitle || s.title || '',
        year:   s.year || '',
        recordId: s.recordId ? String(s.recordId) : undefined,
      })).filter(s => s.album || s.artist);
      return items.length ? { similar: items, note: 'these are albums — search_shelves the artist/album to get playable tracks with recordIds' } : { similar: [], note: 'no similar albums found' };
    }
    case 'artist_info': {
      const data = await selfGet(`/api/artist-bio?name=${encodeURIComponent(String(input?.name || '').slice(0, 100))}`);
      if (data?.found && data.bio) {
        return { found: true, name: data.artist || input.name, country: data.country || '', bio: String(data.bio).slice(0, 900) };
      }
      return { found: false };
    }
    case 'list_playlists': {
      const data = await selfGet('/api/public-playlists');
      return { playlists: (data.playlists || []).map(pl => ({ name: pl.name, trackCount: pl.trackCount })) };
    }
    case 'recommend_tracks': {
      const tracks = Array.isArray(input?.tracks) ? input.tracks.slice(0, 3) : [];
      const clean = tracks
        .filter(t => t && t.recordId && t.title && t.artist)
        .map(t => ({
          recordId: String(t.recordId).slice(0, 30),
          title:    String(t.title).slice(0, 200),
          artist:   String(t.artist).slice(0, 200),
          album:    t.album ? String(t.album).slice(0, 200) : '',
          year:     t.year ? String(t.year).slice(0, 10) : '',
          artworkUrl: t.artworkUrl ? String(t.artworkUrl).slice(0, 500) : '',
        }));
      ctx.recommended.push(...clean);
      return { ok: true, handed_over: clean.length };
    }
    default:
      return { error: `unknown tool ${name}` };
  }
}

// ── rate limiting (simple in-memory per IP) ──────────────────────────────────
const rateBuckets = new Map();
function rateLimited(ip) {
  const now = Date.now();
  let b = rateBuckets.get(ip);
  if (!b || now > b.reset) { b = { count: 0, reset: now + RATE_LIMIT.windowMs }; rateBuckets.set(ip, b); }
  b.count += 1;
  if (rateBuckets.size > 5000) rateBuckets.clear(); // crude memory guard
  return b.count > RATE_LIMIT.max;
}

// ── Maddie-lite: zero-cost semantic fallback ─────────────────────────────────
// With no ANTHROPIC_API_KEY, Maddie answers from the local semantic index
// instead: the visitor's words are embedded IN-PROCESS (no external AI, no
// per-message cost) and matched against the catalogue. Same panel, same
// playable cards — just templated lines instead of generated conversation.
const LITE_HIT_LINES = [
  'Here’s what the shelves say to that — press play and tell me if I’m close.',
  'Sharp. Closest things on the shelves — have a listen.',
  'Off what you said, these came off the shelf first. Not quite it? Give me another word or two — a feeling, a decade, an artist.',
];
const LITE_MISS_LINE = 'Eish — the shelves came up quiet on that one. Try me with different words: an artist, a mood, a decade, an instrument.';
const LITE_SHOP_LINE = 'This is MAD Music — a small shop sitting on a very big vault: the Gallo archive, the deepest collection of South African music anywhere. It’s slowly being brought back out, tape by tape, and you can listen to a taste of anything for free. Tell me what you’re in the mood for.';
const LITE_HELLO_LINE = 'Hello. Tell me what you’re after — a song, an artist, a feeling, even half a memory — and I’ll check the shelves.';

async function maddieLite(userText) {
  const q = String(userText || '').trim();
  if (/^(hi|hello|hey|howzit|hallo|thanks|thank you|sharp)\b/i.test(q) && q.length < 30) {
    return { reply: LITE_HELLO_LINE, tracks: [] };
  }
  if (/what.*(is this|place|site|shop)|who are you/i.test(q)) {
    return { reply: LITE_SHOP_LINE, tracks: [] };
  }
  const hits = await searchShelves(q, 12);
  if (hits === null) return null; // no index — feature unavailable
  // Diversity: at most one track per artist in the hand-over stack.
  const picked = [];
  const seenArtists = new Set();
  for (const h of hits) {
    const key = h.artist.toLowerCase();
    if (seenArtists.has(key)) continue;
    seenArtists.add(key);
    picked.push(h);
    if (picked.length === 3) break;
  }
  if (!picked.length) return { reply: LITE_MISS_LINE, tracks: [] };
  let hash = 0;
  for (const ch of q) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return {
    reply: LITE_HIT_LINES[hash % LITE_HIT_LINES.length],
    tracks: picked.map((t) => ({
      recordId: t.recordId, title: t.title, artist: t.artist,
      album: t.album, year: t.year, artworkUrl: t.artworkUrl,
    })),
  };
}

// ── chat endpoint ────────────────────────────────────────────────────────────
router.post('/chat', async (req, res) => {
  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      // Free mode: semantic shelves, no LLM, no external calls.
      const incomingLite = Array.isArray(req.body?.messages) ? req.body.messages : [];
      const lastUser = [...incomingLite].reverse().find(m => m && m.role === 'user' && typeof m.content === 'string');
      if (!lastUser) return res.status(400).json({ error: 'Say something to Maddie first.' });
      const ip0 = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '?';
      if (rateLimited(ip0)) return res.status(429).json({ error: 'Maddie needs a breather — try again in a few minutes.' });
      const lite = await maddieLite(lastUser.content.slice(0, MAX_MSG_CHARS));
      if (lite) return res.json(lite);
      return res.status(503).json({ error: 'Maddie is not on shift (no API key and no semantic index).' });
    }
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '?';
    if (rateLimited(ip)) {
      return res.status(429).json({ error: 'Maddie needs a breather — try again in a few minutes.' });
    }

    const incoming = Array.isArray(req.body?.messages) ? req.body.messages : [];
    const history = incoming
      .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
      .slice(-MAX_HISTORY)
      .map(m => ({ role: m.role, content: m.content.slice(0, MAX_MSG_CHARS) }));
    if (!history.length || history[history.length - 1].role !== 'user') {
      return res.status(400).json({ error: 'Say something to Maddie first.' });
    }

    const anthropic = new Anthropic();
    const ctx = { recommended: [] };
    const messages = [...history];
    let reply = '';

    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      const response = await anthropic.messages.create({
        model: MADDIE_MODEL,
        max_tokens: 700,
        system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        tools: TOOLS,
        messages,
      });

      if (response.stop_reason === 'refusal') {
        reply = "Let's keep it to the music — what are you in the mood for?";
        break;
      }

      const toolUses = response.content.filter(b => b.type === 'tool_use');
      const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
      if (text) reply = text;

      if (!toolUses.length || response.stop_reason !== 'tool_use') break;

      messages.push({ role: 'assistant', content: response.content });
      const results = [];
      for (const tu of toolUses) {
        let result;
        try {
          result = await executeTool(tu.name, tu.input, ctx);
        } catch (err) {
          result = { error: `tool failed: ${err.message}` };
        }
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result) });
      }
      messages.push({ role: 'user', content: results });
    }

    if (!reply) reply = 'Eish — lost my thread there. Ask me that again?';

    // Dedupe recommendations by recordId, keep order
    const seen = new Set();
    const tracks = ctx.recommended.filter(t => !seen.has(t.recordId) && seen.add(t.recordId));

    res.json({ reply, tracks });
  } catch (err) {
    const status = err?.status || 500;
    console.error('[maddie] chat failed:', err?.message || err);
    res.status(status >= 400 && status < 600 ? status : 500).json({
      error: status === 429
        ? 'The counter is busy — give it a minute.'
        : 'Maddie stepped away from the counter for a moment. Try again shortly.',
    });
  }
});

export default router;
