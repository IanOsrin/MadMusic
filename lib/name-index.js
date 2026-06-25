/**
 * lib/name-index.js — runtime loader for the catalogue NAME index that powers
 * search "Did you mean…" typo suggestions.
 *
 * Loads data/catalog-names.json (built offline by scripts/build-name-index.mjs)
 * once at boot and answers fuzzy name lookups entirely in memory — NO FileMaker
 * on the request path (preserves the 10k-concurrent rule). Same degrade-
 * gracefully contract as lib/semantic-index.js: if the artifact is absent or
 * unreadable the index stays ready=false and suggestNames() returns [] — search
 * still works (just without suggestions), and nothing is fatal at boot.
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createLogger } from './logger.js';

const log = createLogger('name-index');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = process.env.NAME_INDEX_PATH || path.join(__dirname, '..', 'data', 'catalog-names.json');

const norm = (s) => String(s ?? '').toLowerCase().trim().replace(/\s+/g, ' ');

// ── module state ──────────────────────────────────────────────────────────────
let ready = false;
let info = {};
let entries = [];                 // [{ name, normName, kind, n }]
const trigramIndex = new Map();   // trigram → Set(entryIdx)

export function nameIndexStatus() {
  return { ready, artists: info.artists || 0, albums: info.albums || 0, builtAt: info.builtAt || null, path: INDEX_PATH };
}

function trigramsOf(s) {
  const t = `  ${norm(s)} `;
  const grams = new Set();
  for (let i = 0; i < t.length - 2; i++) grams.add(t.slice(i, i + 3));
  return grams;
}

// Classic Levenshtein (names are short; candidate sets are trigram-prefiltered).
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[b.length];
}

// Similarity in [0,1]: 1 = identical. Normalised by the longer string.
const ratio = (a, b) => {
  const m = Math.max(a.length, b.length);
  return m === 0 ? 1 : 1 - levenshtein(a, b) / m;
};

export function initNameIndex() {
  try {
    if (!fs.existsSync(INDEX_PATH)) {
      log.info(`index artifact not found at ${INDEX_PATH} — suggestions disabled (build with: node scripts/build-name-index.mjs)`);
      ready = false;
      return false;
    }
    const raw = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
    const seen = new Map(); // normName → entryIdx (first wins; artists added before albums)
    entries = [];
    trigramIndex.clear();
    const add = (list, kind) => {
      for (const item of list || []) {
        const name = String(item?.name ?? '').trim();
        if (!name) continue;
        const normName = norm(name);
        if (seen.has(normName)) continue;
        const idx = entries.length;
        entries.push({ name, normName, kind, n: Number(item.n) || 1 });
        seen.set(normName, idx);
        for (const g of trigramsOf(normName)) {
          let s = trigramIndex.get(g);
          if (!s) { s = new Set(); trigramIndex.set(g, s); }
          s.add(idx);
        }
      }
    };
    add(raw.artists, 'artist'); // artists first so a name shared by both resolves to "artist"
    add(raw.albums, 'album');
    info = { artists: (raw.artists || []).length, albums: (raw.albums || []).length, builtAt: raw.builtAt };
    ready = true;
    log.info(`loaded ${entries.length} distinct names (${info.artists} artists, ${info.albums} albums) built ${info.builtAt}`);
    return true;
  } catch (err) {
    log.warn(`failed to load name index (${err.message}) — suggestions disabled`);
    ready = false;
    return false;
  }
}

/**
 * Fuzzy "did you mean" suggestions for a typo'd query.
 * Returns [{ name, kind, score }] ordered best-first, excluding the exact query.
 * Empty array when the index isn't ready or nothing clears the threshold.
 *
 * @param {string} query
 * @param {{ limit?: number, minScore?: number }} [opts]
 */
export function suggestNames(query, { limit = 4, minScore = 0.66 } = {}) {
  if (!ready) return [];
  const nq = norm(query);
  if (nq.length < 3) return [];
  const qTokens = nq.split(' ').filter(Boolean);

  // Candidate prefilter: entries sharing at least 2 trigrams with the query
  // (cheap recall gate so we don't Levenshtein every name on every request).
  const counts = new Map();
  for (const g of trigramsOf(nq)) {
    const s = trigramIndex.get(g);
    if (s) for (const idx of s) counts.set(idx, (counts.get(idx) || 0) + 1);
  }

  // Best similarity of one token to a whole string OR (for words ≥3) any of its
  // tokens. This is what lets "dimphiwe" reach the "Simphiwe" word inside
  // "Simphiwe Dana" — the catalogue stores the full name, not the first name alone.
  const bestMatch = (tok, str, strTokens) => {
    let best = ratio(tok, str);
    if (tok.length >= 3) {
      for (const st of strTokens) {
        if (st.length < 3) continue;
        const r = ratio(tok, st);
        if (r > best) best = r;
      }
    }
    return best;
  };

  const scored = [];
  for (const [idx, shared] of counts) {
    if (shared < 2) continue;
    const e = entries[idx];
    if (e.normName === nq) continue; // exact — search already handles it
    const cTokens = e.normName.split(' ').filter(Boolean);
    // Two-way coverage: how much of the QUERY the name explains, and how much of
    // the NAME the query explains. Averaging both is what keeps a single shared
    // common word ("Oliver", "Soul", "Black") from making an unrelated name a top
    // hit — a real correction has to cover most of BOTH sides, not just one word.
    let qSum = 0;
    for (const qt of qTokens) qSum += bestMatch(qt, e.normName, cTokens);
    const queryCov = qSum / qTokens.length;
    let cSum = 0;
    for (const ct of cTokens) cSum += bestMatch(ct, nq, qTokens);
    const candCov = cSum / cTokens.length;
    let score = (queryCov + candCov) / 2;
    const whole = ratio(nq, e.normName); // safety net for odd tokenisation/spacing
    if (whole > score) score = whole;
    if (score >= minScore) scored.push({ name: e.name, normName: e.normName, kind: e.kind, score, n: e.n });
  }

  // Best score first; for ties prefer the more common name, then the shorter
  // (cleaner) one — so the base "Simphiwe Dana" outranks "Simphiwe Dana feat. …".
  scored.sort((a, b) => (b.score - a.score) || (b.n - a.n) || (a.normName.length - b.normName.length));
  const out = [];
  const accepted = []; // normNames already taken
  for (const s of scored) {
    // Collapse near-duplicate variants: skip a name that just extends one we've
    // already suggested ("Simphiwe Dana feat. X" once "Simphiwe Dana" is in).
    if (accepted.some(a => s.normName === a || s.normName.startsWith(a + ' '))) continue;
    accepted.push(s.normName);
    out.push({ name: s.name, kind: s.kind, score: Number(s.score.toFixed(3)) });
    if (out.length >= limit) break;
  }
  return out;
}
