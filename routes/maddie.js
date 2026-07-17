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
import { semanticShelvesAvailable, knnRaw } from '../lib/semantic-shelves.js';
import { answerFromShelves, QUESTION_LINE } from '../lib/maddie-lite.js';

const router = Router();

// Haiku by default — Maddie's job (persona + tool calls over a catalogue) sits
// comfortably in the cheapest tier: ~1c per visitor message. Set MADDIE_MODEL
// to a bigger model if her taste ever needs the upgrade.
const MADDIE_MODEL = process.env.MADDIE_MODEL || 'claude-haiku-4-5';
const SELF = `http://127.0.0.1:${process.env.PORT || 3000}`;
const MAX_TOOL_ITERATIONS = 8;
const MAX_HISTORY = 16;          // messages kept per request
const MAX_MSG_CHARS = 1500;      // per message
const RATE_LIMIT = { max: 30, windowMs: 10 * 60 * 1000 }; // per IP

// ── persona ──────────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are Maddie, the assistant behind the counter at MAD Music — a small online record shop sitting on the Gallo vault, the deepest archive of South African music anywhere (about sixty thousand recordings, from the 1950s to now). Much of it exists nowhere else. Visitors can play a free 30-second preview of anything.

Your character: you grew up among these crates. Warm, quick, a little opinionated — the sharp one behind the counter who plays people things instead of describing them. Light South African seasoning in your speech (an "eish" when the shelves let someone down, a "sharp" when they don't) — never so much that a visitor in Stockholm needs a glossary. You serve a 70-year-old asking for Mahlathini and a 25-year-old crate-digger from Berlin with exactly the same respect.

House rules — these are absolute:
1. PLAY FIRST, TALK SECOND. When you recommend music, ALWAYS call recommend_tracks so the visitor gets press-play cards. Up to 5 tracks at a time — a good stack, not the whole shelf.
2. ONLY THE CATALOGUE. Recommend only tracks you have actually seen in a tool result this conversation. Never invent artists, titles or recordIds.
2b. FACTS COME FROM TOOLS, NEVER FROM MEMORY. Do NOT state where an artist is from, what genre they play, who was in which band, or any other biography unless a tool result told you THIS conversation (artist_info, or the genre/year fields on returned tracks). Your own memory of South African music specifics is unreliable, and getting an artist's story wrong in front of someone who loves them is the worst thing that can happen at this counter. You MAY use a hunch silently to pick EXTRA search terms (e.g. also searching a band you think a person played with) — but if the search doesn't confirm it, drop the hunch without ever mentioning it. Asked a factual question you can't ground in a tool result? Say plainly: "I only know what's on the shelves — but let me show you those," and show them.
3. HONEST MISSES. If the search comes up empty, say so plainly ("Eish — that one's not on our shelves") and offer the nearest thing that IS here. Never pretend.
4. ONE LINE OF STORY, not a lecture. If artist_info gives you something interesting, spend it in a sentence.
5. ASK ONE GOOD QUESTION back when the request is vague ("for dancing or for remembering?") — one question, not an interrogation.
6. NEVER SELL. No mention of subscriptions, pricing or signing up. Ever. If asked what this place is: a small shop on a very big vault, slowly bringing the archive back out, tape by tape; anyone can taste anything for free.
7. KEEP IT SHORT. Two to four sentences for most replies. This is a chat window, not a letter.
8. STAY AT THE COUNTER. You only talk about the music here — not other streaming services, not news, not anything else. Deflect gently and bring it back to the shelves.

Tool notes: you have TWO search moves — use both. search_shelves is exact/lexical (names of artists, tracks, albums). feel_search is the shop's semantic index (62,000+ tracks embedded by meaning) — it finds music by mood, feeling, era, instrument, style, "sounds like", even half-memories; it is the stronger opener for anything that isn't a name lookup.

NAME LOOKUPS ARE SACRED: when the visitor names an artist or band, your FIRST call is ALWAYS search_shelves with the artist parameter set to that exact name — not q, not feel_search, no rephrasing. Only widen (feel_search, alternate spellings, related searches) AFTER you've seen what the shelves hold under the name they actually said.

DIG DEEP — this is a crate-digging shop, not a search box. For any request beyond a simple name lookup, run AT LEAST two searches from different angles (e.g. feel_search on the mood + search_shelves on a genre or artist it surfaces) before you hand anything over. If results feel thin or obvious, search again with different words. Prefer one more search over a guess, and pick your 5 from the RICHEST pool you gathered. similar_albums works when you have an artist+album to seed from. recordIds (and cat where present) must be copied EXACTLY from tool results into recommend_tracks.`;

// ── tools ────────────────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'search_shelves',
    description: 'Exact/lexical catalogue search. Use artist/track/album for specific names, q for free-text. Returns up to 20 tracks with recordIds.',
    input_schema: {
      type: 'object',
      properties: {
        q:      { type: 'string', description: 'free-text query (genre, words from a lyric or title)' },
        artist: { type: 'string' },
        track:  { type: 'string' },
        album:  { type: 'string' },
      },
    },
  },
  {
    name: 'feel_search',
    description: 'Semantic search over the whole catalogue BY MEANING — describe a mood, feeling, era, instrument, style, occasion or "sounds like" in a sentence and get the closest tracks. The strongest opener for anything that is not a plain name lookup. Returns up to ~20 tracks with recordIds.',
    input_schema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'natural-language description of what the visitor is after, e.g. "warm 1970s township saxophone jive for remembering a father"' },
      },
      required: ['description'],
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
    description: 'Hand the visitor playable track cards. Call this EVERY time you recommend specific tracks (max 5). Copy recordId/title/artist exactly from earlier tool results.',
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
              albumArtist:{ type: 'string' },
              cat:        { type: 'string', description: 'catalogue number, copied exactly when the tool result had one' },
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
    albumArtist: pick(f, ['Album Artist', 'Tape Files::Album Artist']),
    cat:    pick(f, ['Reference Catalogue Number', 'Album Catalogue Number']),
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
      const p = new URLSearchParams({ limit: '20' });
      for (const k of ['q', 'artist', 'track', 'album']) {
        if (input?.[k]) p.set(k, String(input[k]).slice(0, 100));
      }
      const data = await selfGet(`/api/search?${p}`);
      const items = (data.items || []).map(compactTrack).filter(t => t.title);
      return items.length
        ? { found: items.length, tracks: items }
        : { found: 0, note: 'nothing on the shelves for that — try different terms (or feel_search) once more, then be honest about the miss', suggestions: data.suggestions || [] };
    }
    case 'feel_search': {
      const hits = await knnRaw(String(input?.description || '').slice(0, 300), 24);
      if (hits === null) return { found: 0, note: 'semantic index unavailable — use search_shelves instead' };
      const items = hits.map((h) => ({
        recordId: h.recordId,
        title:  h.m.track || '',
        artist: (h.m.artist || h.m.albumArtist || '').slice(0, 60),
        album:  h.m.album || '',
        albumArtist: (h.m.albumArtist || '').slice(0, 60),
        cat:    h.m.catalogue || '',
        year:   h.m.year || '',
        genre:  h.m.genre || h.m.localGenre || '',
        artworkUrl: h.m.artworkUrl || '',
      })).filter(t => t.title && t.artist);
      return items.length
        ? { found: items.length, tracks: items }
        : { found: 0, note: 'nothing close by feel — rephrase the description or fall back to search_shelves' };
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
      // The route nests the payload under `artist` ({found, artist:{name, bio,
      // country}}); tolerate the old flat shape too.
      const a = (data && typeof data.artist === 'object' && data.artist) || {};
      const bio = a.bio || data?.bio;
      if (data?.found && bio) {
        return {
          found: true,
          name: a.name || (typeof data.artist === 'string' ? data.artist : '') || input.name,
          country: a.country || data.country || '',
          bio: String(bio).slice(0, 1200),
        };
      }
      return { found: false };
    }
    case 'list_playlists': {
      const data = await selfGet('/api/public-playlists');
      return { playlists: (data.playlists || []).map(pl => ({ name: pl.name, trackCount: pl.trackCount })) };
    }
    case 'recommend_tracks': {
      const tracks = Array.isArray(input?.tracks) ? input.tracks.slice(0, 5) : [];
      const clean = tracks
        .filter(t => t && t.recordId && t.title && t.artist)
        .map(t => ({
          recordId: String(t.recordId).slice(0, 30),
          title:    String(t.title).slice(0, 200),
          artist:   String(t.artist).slice(0, 200),
          album:    t.album ? String(t.album).slice(0, 200) : '',
          albumArtist: t.albumArtist ? String(t.albumArtist).slice(0, 200) : '',
          cat:      t.cat ? String(t.cat).slice(0, 40) : '',
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
// instead: lib/maddie-lite.js parses the message (genre/tempo/mood/decade/
// language/artist become hard filters, filler is stripped, only descriptive
// words are embedded) and asks a clarifying question when the request is
// vague. Same panel, same playable cards — no external AI, no per-message
// cost.
const LITE_SHOP_LINE = 'This is MAD Music — a small shop sitting on a very big vault: the Gallo archive, the deepest collection of South African music anywhere. It’s slowly being brought back out, tape by tape, and you can listen to a taste of anything for free. Tell me what you’re in the mood for.';
const LITE_HELLO_LINE = 'Hello. Tell me what you’re after — a song, an artist, a feeling, even half a memory — and I’ll check the shelves.';

async function maddieLite(userText, prevAssistant, prevUser) {
  const q = String(userText || '').trim();
  if (/^(hi|hello|hey|howzit|hallo|thanks|thank you|sharp)\b/i.test(q) && q.length < 30) {
    return { reply: LITE_HELLO_LINE, tracks: [] };
  }
  if (/what.*(is this|place|site|shop)|who are you/i.test(q)) {
    return { reply: LITE_SHOP_LINE, tracks: [] };
  }
  // Curated-playlists intent: name Kwela's shelves rather than embedding the
  // word "playlist" (which would just match tracks with playlist-ish titles).
  if (/playlist|curated|collection/i.test(q)) {
    try {
      const data = await selfGet('/api/public-playlists');
      const names = (data.playlists || []).map((pl) => pl.name.replace(/-/g, ' ')).filter(Boolean);
      if (names.length) {
        return {
          reply: `Kwela stocks those shelves — we've got: ${names.join(', ')}. They're on the home page under Playlists. Or tell me a mood and I'll pull tracks myself.`,
          tracks: [],
        };
      }
    } catch { /* fall through to semantic search */ }
  }
  // If Maddie just asked her clarifying question, read this answer TOGETHER
  // with what the visitor said before it ("play me something" → "gospel").
  const text = (prevAssistant === QUESTION_LINE && prevUser)
    ? `${prevUser} ${q}`
    : q;
  return answerFromShelves(text);
}

// ── chat endpoint ────────────────────────────────────────────────────────────
router.post('/chat', async (req, res) => {
  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      // Free mode: semantic shelves, no LLM, no external calls.
      const incomingLite = Array.isArray(req.body?.messages) ? req.body.messages : [];
      const textOf = (m) => (m && typeof m.content === 'string' ? m.content.slice(0, MAX_MSG_CHARS) : '');
      const users = incomingLite.filter(m => m && m.role === 'user' && typeof m.content === 'string');
      const assistants = incomingLite.filter(m => m && m.role === 'assistant' && typeof m.content === 'string');
      const lastUser = users[users.length - 1];
      if (!lastUser) return res.status(400).json({ error: 'Say something to Maddie first.' });
      const ip0 = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '?';
      if (rateLimited(ip0)) return res.status(429).json({ error: 'Maddie needs a breather — try again in a few minutes.' });
      const lite = await maddieLite(
        textOf(lastUser),
        textOf(assistants[assistants.length - 1]),
        textOf(users[users.length - 2])
      );
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
