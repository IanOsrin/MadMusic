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
import { fmFindRecords, fmCreateRecord } from '../fm-client.js';

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
1. PLAY FIRST, TALK SECOND. When you recommend music, ALWAYS call recommend_tracks so the visitor gets press-play cards. Up to 5 tracks for a normal hand-over — a good stack, not the whole shelf; when the visitor EXPLICITLY asks for a big list ("give me 20 gospel songs"), go up to 15. A PROMISE NEEDS CARDS: if your words offer music ("here's a taste", "have a listen", naming specific albums as if serving them), you MUST have called recommend_tracks with real recordIds in that SAME turn — words that promise play with no cards behind them are a broken promise at this counter. This applies to who-is questions too: tell the story, then EITHER hand cards immediately or ask what they'd like to hear — never describe "a taste" you haven't actually poured.
2. ONLY THE CATALOGUE. Recommend only tracks you have actually seen in a tool result this conversation. Never invent artists, titles or recordIds.
2b. FACTS COME FROM TOOLS, NEVER FROM MEMORY. Do NOT state where an artist is from, what genre they play, who was in which band, or any other biography unless a tool result told you THIS conversation (artist_info, or the genre/year fields on returned tracks). Your own memory of South African music specifics is unreliable, and getting an artist's story wrong in front of someone who loves them is the worst thing that can happen at this counter. You MAY use a hunch silently to pick EXTRA search terms (e.g. also searching a band you think a person played with) — but if the search doesn't confirm it, drop the hunch without ever mentioning it. Asked ANYTHING about who an artist IS — what band, where from, their story? Call artist_info for that name EVERY TIME before answering (the shop keeps bio cards for many artists; the visitor's exact question is often answered right there). Always use the BEST spelling you know: if a search corrected the visitor's typo ("morebee" → the shelves say "Morbee"), re-run artist_info with the CORRECTED name — a bio miss on a misspelling proves nothing. Only after artist_info misses on the corrected spelling may you say: "I only know what's on the shelves — but let me show you those," and show them.
3. HONEST MISSES. If the search comes up empty, say so plainly ("Eish — that one's not on our shelves") and offer the nearest thing that IS here. Never pretend.
4. ONE LINE OF STORY, not a lecture. If artist_info gives you something interesting, spend it in a sentence.
5. ASK ONE GOOD QUESTION back when the request is vague ("for dancing or for remembering?") — one question, not an interrogation.
6. NEVER SELL. No mention of subscriptions, pricing or signing up. Ever. If asked what this place is: a small shop on a very big vault, slowly bringing the archive back out, tape by tape; anyone can taste anything for free.
7. KEEP IT SHORT. Two to four sentences for most replies. This is a chat window, not a letter.
8. STAY AT THE COUNTER. You only talk about the music here — not other streaming services, not news, not anything else. Deflect gently and bring it back to the shelves.

Tool notes: you have TWO search moves — use both. search_shelves is exact/lexical (names of artists, tracks, albums). feel_search is the shop's semantic index (62,000+ tracks embedded by meaning) — it finds music by mood, feeling, era, instrument, style, "sounds like", even half-memories; it is the stronger opener for anything that isn't a name lookup.

NAME LOOKUPS ARE SACRED: when the visitor names an artist or band, your FIRST call is ALWAYS search_shelves with the artist parameter set to that exact name — not q, not feel_search, no rephrasing. Only widen (feel_search, alternate spellings, related searches) AFTER you've seen what the shelves hold under the name they actually said.

THE WEB IS YOUR BACK ROOM — USE IT: when the shelves AND the bio card both miss on a genuine music question, do NOT stop and shrug — call web_search on the visitor's behalf, EVERY TIME. That call has two jobs: (1) answer their question honestly, clearly flagged as coming from the wider web, not our shelves ("not on our shelves, but the story goes…"); (2) harvest leads — other names they recorded under, their bands, labels, collaborators, alternate spellings — and IMMEDIATELY bring each lead back to search_shelves: obscure artists often hide in this vault under different billings (it has happened that a famous name turned out to be hiding behind a pseudonym on these very shelves). Rules that still hold: never imply we stock music the shelves didn't return; never state web findings as shelf knowledge; stay on music. A visitor leaving informed beats a visitor leaving empty-handed — and a web lead that unlocks the vault beats both.

DIG DEEP — this is a crate-digging shop, not a search box. For any request beyond a simple name lookup, run AT LEAST two searches from different angles (e.g. feel_search on the mood + search_shelves on a genre or artist it surfaces) before you hand anything over. If results feel thin or obvious, search again with different words. Prefer one more search over a guess, and pick your 5 from the RICHEST pool you gathered. similar_albums works when you have an artist+album to seed from. recordIds (and cat where present) must be copied EXACTLY from tool results into recommend_tracks.`;

// ── tools ────────────────────────────────────────────────────────────────────
// Server-side web search (runs on Anthropic's infra, ~$10/1k searches).
// LAST RESort for genuine misses; capped per turn. MADDIE_WEB_SEARCH=false
// disables. The _20260209 variant needs Sonnet 4.6+/Opus 4.6+; Haiku gets
// the basic _20250305 variant.
// Searches cost ~1c each; 2 proved too tight for her research style (query +
// variant and she was dry mid-dig). Tune from Render via MADDIE_WEB_MAX_USES.
const WEB_MAX_USES = Math.max(1, parseInt(process.env.MADDIE_WEB_MAX_USES || '6', 10) || 6);
const WEB_SEARCH_TOOL = /haiku/.test(MADDIE_MODEL)
  ? { type: 'web_search_20250305', name: 'web_search', max_uses: WEB_MAX_USES }
  : { type: 'web_search_20260209', name: 'web_search', max_uses: WEB_MAX_USES };
const WEB_SEARCH_ENABLED = () => process.env.MADDIE_WEB_SEARCH !== 'false';

const TOOLS = [
  {
    name: 'search_shelves',
    description: 'Exact/lexical catalogue search. Use artist/track/album for specific names, q for free-text. Returns tracks with recordIds; set limit up to 50 when the visitor wants breadth.',
    input_schema: {
      type: 'object',
      properties: {
        q:      { type: 'string', description: 'free-text query (genre, words from a lyric or title)' },
        artist: { type: 'string' },
        track:  { type: 'string' },
        album:  { type: 'string' },
        limit:  { type: 'integer', description: 'how many results to fetch (default 25, max 50) — raise it for "everything you have" style requests' },
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
        count: { type: 'integer', description: 'how many results (default 24, max 50)' },
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
    description: 'Fetch the shop\'s knowledge card for an artist: biography/titbits PLUS a "related music in the streamer" digest (composer credits on others\' records, collaborations, compilation appearances). Call it for who-is questions AND when a visitor wants to go deeper on an artist — the related list tells you which OTHER albums on these shelves carry their fingerprints.',
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
    description: 'Hand the visitor playable track cards. Call this EVERY time you recommend specific tracks (max 5 normally; up to 15 when the visitor explicitly asked for a big list). Copy recordId/title/artist exactly from earlier tool results.',
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
  // Fail fast (10 s) and LOUD — a silent tool failure surfaces to the visitor
  // as Maddie apologising about "the shelves", with nothing in the logs.
  try {
    const res = await fetch(`${SELF}${path}`, {
      // x-forwarded-proto satisfies the production force-HTTPS middleware —
      // without it, loopback self-fetches get 301'd to https://127.0.0.1
      // (nothing speaks TLS there → ERR_SSL_PACKET_LENGTH_TOO_LONG), which
      // silently killed EVERY self-fetch tool in prod while feel_search
      // (in-process) masked it. Reproduced + fixed 2026-07-17.
      headers: { Accept: 'application/json', 'x-forwarded-proto': 'https' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.warn(`[maddie-tools] self-fetch ${path} → HTTP ${res.status}`);
      return { _httpStatus: res.status };
    }
    return res.json();
  } catch (err) {
    console.warn(`[maddie-tools] self-fetch ${path} FAILED: ${err?.cause?.code || err?.name || ''} ${err?.message || err}`);
    throw err;
  }
}

/** Boot-time self-diagnostic: exercise the exact internal path the tools use
 *  and print the verdict to the logs, so a broken loopback/auth/config is
 *  visible within seconds of deploy instead of surfacing as Maddie apologies. */
export async function maddieSelfCheck() {
  for (const p of ['/api/search?artist=Lucky%20Dube&limit=1', '/api/artist-bio?name=Ken%20Espen', '/api/public-playlists']) {
    const t0 = Date.now();
    try {
      const data = await selfGet(p);
      const note = data?._httpStatus ? `HTTP ${data._httpStatus}` : `ok (${JSON.stringify(data).length} bytes)`;
      console.log(`[maddie-selfcheck] ${p} → ${note} in ${Date.now() - t0}ms`);
    } catch (err) {
      console.error(`[maddie-selfcheck] ${p} → FAILED in ${Date.now() - t0}ms: ${err?.message}`);
    }
  }
}

async function executeTool(name, input, ctx) {
  switch (name) {
    case 'search_shelves': {
      const lim = Math.max(1, Math.min(50, parseInt(input?.limit, 10) || 25));
      const p = new URLSearchParams({ limit: String(lim) });
      for (const k of ['q', 'artist', 'track', 'album']) {
        if (input?.[k]) p.set(k, String(input[k]).slice(0, 100));
      }
      const data = await selfGet(`/api/search?${p}`);
      let items = (data.items || []).map(compactTrack).filter(t => t.title);
      if (items.length) return { found: items.length, tracks: items };
      // Exact-name miss (likely a typo — "kahn morebee"): the q= path is
      // fuzzy AND returns did-you-mean candidates, so retry there before
      // reporting a miss.
      const typed = ['artist', 'track', 'album'].map(k => input?.[k]).filter(Boolean).join(' ');
      if (typed) {
        const fp = new URLSearchParams({ limit: String(lim), q: typed.slice(0, 100) });
        const fuzzy = await selfGet(`/api/search?${fp}`);
        items = (fuzzy.items || []).map(compactTrack).filter(t => t.title);
        if (items.length || (fuzzy.suggestions || []).length) {
          return {
            found: items.length,
            tracks: items,
            note: 'the EXACT name missed — these are FUZZY matches for what they typed. If did_you_mean has a clear best candidate, use it (tell the visitor what you corrected to); if candidates differ meaningfully, ask "did you mean X or Y?"',
            did_you_mean: (fuzzy.suggestions || []).slice(0, 5),
          };
        }
      }
      return { found: 0, note: 'nothing on the shelves for that — try different terms (or feel_search) once more, then be honest about the miss', did_you_mean: data.suggestions || [] };
    }
    case 'feel_search': {
      const kCount = Math.max(1, Math.min(50, parseInt(input?.count, 10) || 24));
      const hits = await knnRaw(String(input?.description || '').slice(0, 300), kCount);
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
      // titbits, country}}); tolerate the old flat shape too. Titbits is the
      // AI's own knowledge field — preferred over the writer's Bio article.
      const a = (data && typeof data.artist === 'object' && data.artist) || {};
      const bio = a.titbits || a.bio || data?.bio;
      if (data?.found && bio) {
        return {
          found: true,
          name: a.name || (typeof data.artist === 'string' ? data.artist : '') || input.name,
          country: a.country || data.country || '',
          // Comprehensive profiles run 2-3k chars — give her the whole card
          // (facts are front-loaded by convention, so even a clip keeps them).
          bio: String(bio).slice(0, 3500),
          related_music_in_streamer: a.related
            ? String(a.related).slice(0, 2500) + '\n(auto-collated leads — verify each via search_shelves before recommending; only hand over recordIds you have seen in a search result)'
            : '',
        };
      }
      // Knowledge gap — feed the self-learning loop (a draft titbit is
      // proposed AFTER the reply is sent; see suggestTitbitsForGaps).
      const missName = String(input?.name || '').trim();
      if (missName && ctx.bioMisses && !ctx.bioMisses.includes(missName)) ctx.bioMisses.push(missName);
      return { found: false };
    }
    case 'list_playlists': {
      const data = await selfGet('/api/public-playlists');
      return { playlists: (data.playlists || []).map(pl => ({ name: pl.name, trackCount: pl.trackCount })) };
    }
    case 'recommend_tracks': {
      const tracks = Array.isArray(input?.tracks) ? input.tracks.slice(0, 15) : [];
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

// ── self-learning loop: gap → AI-drafted titbit → human approval ────────────
// When a visitor asks about an artist and artist_info finds nothing, the model
// drafts a titbit AFTER the reply is sent (never delays the visitor) and it is
// written to FM as an Active=0 record on API_Artist_Bio with a Suggestion_Note.
// Ian reviews in FileMaker and flips Active to 1 to publish — the machine
// PROPOSES, a human APPROVES. Nothing self-writes into truth.
// Disable with MADDIE_LEARN=false. Costs ~1 extra model call per NEW gap,
// capped per day.
const LEARN_ENABLED = () => process.env.MADDIE_LEARN !== 'false';
const MAX_SUGGESTIONS_PER_DAY = 20;
const _suggest = { day: '', count: 0, inFlight: new Set(), known: null, knownAt: 0 };

const normName = (s) => String(s || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

async function knownBioNames() {
  // Cache the full name list (any Active state — a pending suggestion also
  // counts as "known") for 10 minutes.
  if (_suggest.known && Date.now() - _suggest.knownAt < 600_000) return _suggest.known;
  const res = await fmFindRecords('API_Artist_Bio', [{ Artist_Name: '*' }], { limit: 1000 });
  const set = new Set();
  for (const r of res?.data || []) {
    set.add(normName(r.fieldData.Artist_Name));
    for (const alias of String(r.fieldData.Aliases || '').split(/[\n|]+/)) {
      const n = normName(alias);
      if (n) set.add(n);
    }
  }
  _suggest.known = set;
  _suggest.knownAt = Date.now();
  return set;
}

const DRAFTER_PROMPT = `You draft knowledge-base entries ("titbits") about music artists for MAD Music, a South African record shop sitting on the Gallo vault. A human curator reviews every draft before it is published — but write as if no one checks, because one day someone won't.

RESEARCH FIRST: use web_search to look the artist up (South African music context; try spelling variants). Then write 80–200 words of flowing prose: who the artist is or was, where from, era, genre, band memberships and collaborations, notable works. Include ONLY facts your research or confident knowledge supports. If a detail is plausible but uncertain, omit it or tag it inline with [UNVERIFIED]. Never guess origins, line-ups or dates. Output ONLY the prose entry — no citations, no preamble.

The artist is likely (but not certainly) South African or African; the name may be misspelled or genuinely obscure. If neither your knowledge nor the web yields anything reliable about this specific artist, reply with exactly NO_RELIABLE_KNOWLEDGE and nothing else.`;

async function suggestTitbitsForGaps(gaps, visitorQuestion) {
  if (!LEARN_ENABLED() || !process.env.ANTHROPIC_API_KEY || !gaps?.length) return;
  const today = new Date().toISOString().slice(0, 10);
  if (_suggest.day !== today) { _suggest.day = today; _suggest.count = 0; }

  for (const rawName of gaps.slice(0, 3)) {
    const name = rawName.slice(0, 80);
    const key = normName(name);
    if (!key || key.length < 3) continue;
    if (_suggest.count >= MAX_SUGGESTIONS_PER_DAY) return;
    if (_suggest.inFlight.has(key)) continue;
    _suggest.inFlight.add(key);
    try {
      const known = await knownBioNames();
      if (known.has(key)) continue; // record (or pending suggestion) already exists

      const anthropic = new Anthropic();
      // Mini web-research loop (server-side tool may pause; container id must
      // thread through, same as the chat loop).
      const dMessages = [{ role: 'user', content: `Artist: "${name}"\nContext — a visitor asked: "${String(visitorQuestion || '').slice(0, 200)}"` }];
      let dContainer = null;
      let text = '';
      for (let i = 0; i < 4; i++) {
        const draft = await anthropic.messages.create({
          model: MADDIE_MODEL,
          max_tokens: 600,
          system: DRAFTER_PROMPT,
          tools: WEB_SEARCH_ENABLED() ? [WEB_SEARCH_TOOL] : [],
          messages: dMessages,
          ...(dContainer ? { container: dContainer } : {}),
        });
        dContainer = draft.container?.id || dContainer;
        const t = (draft.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
        if (t) text = t;
        if (draft.stop_reason === 'pause_turn') { dMessages.push({ role: 'assistant', content: draft.content }); continue; }
        break;
      }
      // Models sometimes narrate before the entry ("Let me now write…---").
      // Keep only what follows the last --- separator, then strip any
      // leading meta-chatter lines.
      if (text.includes('---')) {
        const parts = text.split(/\n-{3,}\n?/);
        text = parts[parts.length - 1].trim();
      }
      text = text.replace(/^(?:(?:I['’]ve|I have|I'll|I will|Let me|However|Based on|Now I|Okay|Good)[^\n]*\n+)+/, '').trim();
      if (!text || text.includes('NO_RELIABLE_KNOWLEDGE') || text.length < 80) {
        // Still a work item: record the GAP so real visitor demand reaches
        // Ian's FileMaker inbox even when neither AI nor web could draft.
        // (Empty Titbits keeps it unservable even if Active were flipped.)
        await fmCreateRecord('API_Artist_Bio', {
          Artist_Name: name,
          Titbits: '',
          Active: '0',
          Suggestion_Note: `KNOWLEDGE GAP — visitors asked: "${String(visitorQuestion || '').slice(0, 150)}" (${today}). AI + web research found nothing reliable. Write the Titbits yourself and set Active=1 (or delete).`,
        });
        _suggest.count += 1;
        _suggest.known?.add(key);
        console.log(`[maddie-learn] no reliable knowledge for "${name}" — GAP record created (Active=0)`);
        continue;
      }

      const res = await fmCreateRecord('API_Artist_Bio', {
        Artist_Name: name,
        Titbits: text,
        Active: '0', // ← the approval gate: invisible everywhere until Ian flips it
        Suggestion_Note: `AI-drafted (${MADDIE_MODEL}) from visitor question: "${String(visitorQuestion || '').slice(0, 150)}" — ${today}. REVIEW, EDIT, THEN SET Active=1 TO PUBLISH (or delete).`,
      });
      _suggest.count += 1;
      _suggest.known?.add(key);
      console.log(`[maddie-learn] drafted titbit for "${name}" → API_Artist_Bio recordId ${res?.recordId} (Active=0, pending review; ${_suggest.count}/${MAX_SUGGESTIONS_PER_DAY} today)`);
    } catch (err) {
      console.warn(`[maddie-learn] suggestion failed for "${name}":`, err?.message || err);
      // The demand must never vanish because drafting hiccupped (rate limit,
      // model error) — record the gap anyway for Ian's inbox.
      try {
        await fmCreateRecord('API_Artist_Bio', {
          Artist_Name: name,
          Titbits: '',
          Active: '0',
          Suggestion_Note: `KNOWLEDGE GAP — visitors asked: "${String(visitorQuestion || '').slice(0, 150)}" (${today}). AI drafting failed (${String(err?.message || err).slice(0, 80)}) — write the Titbits yourself and set Active=1 (or delete).`,
        });
        _suggest.count += 1;
        _suggest.known?.add(key);
        console.log(`[maddie-learn] GAP record created for "${name}" after drafting failure`);
      } catch (e2) {
        console.warn(`[maddie-learn] even the gap record failed for "${name}":`, e2?.message || e2);
      }
    } finally {
      _suggest.inFlight.delete(key);
    }
  }
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
    const ctx = { recommended: [], bioMisses: [] };
    const messages = [...history];
    let reply = '';
    // The _20260209 web tool filters results via a server-side code-execution
    // container; once one exists, every follow-up request in the turn must
    // carry its id or the API 400s ("container_id is required…").
    let containerId = null;

    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      const response = await anthropic.messages.create({
        model: MADDIE_MODEL,
        // Enough headroom to write a 15-card recommend_tracks call — 700 was
        // truncating tool inputs mid-write (cards arrived empty).
        max_tokens: 4000,
        system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        tools: WEB_SEARCH_ENABLED() ? [...TOOLS, WEB_SEARCH_TOOL] : TOOLS,
        messages,
        ...(containerId ? { container: containerId } : {}),
      });
      containerId = response.container?.id || containerId;
      if (response.stop_reason === 'max_tokens') console.warn('[maddie] turn truncated at max_tokens — reply/cards may be incomplete');

      if (response.stop_reason === 'refusal') {
        reply = "Let's keep it to the music — what are you in the mood for?";
        break;
      }

      const toolUses = response.content.filter(b => b.type === 'tool_use');
      const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
      if (text) reply = text;

      // Server-side tools (web_search) run on Anthropic's servers; a long
      // server-tool turn pauses — append the assistant turn and continue,
      // the server resumes where it left off.
      if (response.stop_reason === 'pause_turn') {
        messages.push({ role: 'assistant', content: response.content });
        continue;
      }

      if (!toolUses.length || response.stop_reason !== 'tool_use') break;

      messages.push({ role: 'assistant', content: response.content });
      const results = [];
      for (const tu of toolUses) {
        let result;
        try {
          result = await executeTool(tu.name, tu.input, ctx);
        } catch (err) {
          console.warn(`[maddie-tools] ${tu.name}(${JSON.stringify(tu.input).slice(0, 120)}) failed: ${err?.message || err}`);
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

    // Self-learning loop — after the visitor has their answer, propose draft
    // titbits for any artists the bio card couldn't cover. Fire-and-forget.
    const lastQuestion = history[history.length - 1]?.content || '';
    suggestTitbitsForGaps(ctx.bioMisses, lastQuestion)
      .catch((e) => console.warn('[maddie-learn] loop error:', e?.message || e));
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

export { suggestTitbitsForGaps, SYSTEM_PROMPT, TOOLS, WEB_SEARCH_TOOL, executeTool, MADDIE_MODEL };
