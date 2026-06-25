/**
 * scripts/build-name-index.mjs — derive the catalogue NAME index for search
 * "Did you mean…" suggestions.
 *
 * Scans the live FileMaker layout once and writes a small JSON of the DISTINCT
 * artist + album names (with occurrence counts) that the app loads at boot
 * (lib/name-index.js) to fuzzy-match typo'd queries — NO FileMaker on the
 * request path (preserves the 10k-concurrent rule). Same offline-artifact
 * pattern as scripts/semantic/build-index.mjs → data/semantic.db.
 *
 *   node scripts/build-name-index.mjs                 # full scan
 *   node scripts/build-name-index.mjs --limit 5000    # sample run
 *
 * Output: data/catalog-names.json (gitignored runtime artifact).
 *
 * Env (in .env): FM_HOST, FM_DB, FM_USER, FM_PASS (SUGGEST_FM_* override the
 * source, mirroring build-index.mjs so a snapshot copy can be used instead).
 *
 * Only VISIBLE, PLAYABLE records contribute names, so suggestions can only ever
 * point at something search can actually return.
 */

import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { hasValidAudio } from '../lib/track.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const OUT_PATH = process.env.NAME_INDEX_PATH || path.join(ROOT, 'data', 'catalog-names.json');

const HOST = process.env.SUGGEST_FM_HOST || process.env.FM_HOST;
const FMDB = process.env.SUGGEST_FM_DB   || process.env.FM_DB;
const USER = process.env.SUGGEST_FM_USER || process.env.FM_USER;
const PASS = process.env.SUGGEST_FM_PASS || process.env.FM_PASS;
const LAYOUT = process.env.FM_LAYOUT || 'API_Album_Songs';
const PAGE = 1000;

const argLimit = (() => {
  const i = process.argv.indexOf('--limit');
  return i > -1 ? Number(process.argv[i + 1]) : Infinity;
})();

if (!HOST || !FMDB || !USER || !PASS) {
  console.error('[name-index] missing FM creds — set FM_HOST/FM_DB/FM_USER/FM_PASS (env or .env)');
  process.exit(1);
}

// Visibility mirrors build-index.mjs: empty or "show" → visible.
function isVisible(f) {
  const raw = f['Visibility'] ?? f['Tape Files::Visibility'] ?? '';
  const v = String(raw).trim().toLowerCase();
  return !v || v === 'show';
}

async function fmLogin() {
  const auth = Buffer.from(`${USER}:${PASS}`).toString('base64');
  const r = await fetch(`${HOST}/fmi/data/vLatest/databases/${FMDB}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
    body: '{}'
  }).then((x) => x.json());
  if (!r.response?.token) throw new Error(`FM login failed: ${JSON.stringify(r.messages)}`);
  return r.response.token;
}

async function fmLogout(token) {
  await fetch(`${HOST}/fmi/data/vLatest/databases/${FMDB}/sessions/${token}`, { method: 'DELETE' }).catch(() => {});
}

async function fmPage(token, offset, limit) {
  const r = await fetch(
    `${HOST}/fmi/data/vLatest/databases/${FMDB}/layouts/${LAYOUT}/records?_offset=${offset}&_limit=${limit}`,
    { headers: { Authorization: `Bearer ${token}` } }
  ).then((x) => x.json());
  if (!r.response?.data) {
    const code = r.messages?.[0]?.code;
    if (code === '401' || code === '101') return [];
    throw new Error(`FM page failed at offset ${offset}: ${JSON.stringify(r.messages)}`);
  }
  return r.response.data;
}

const val = (f, k) => String(f[k] ?? '').trim();
const norm = (s) => String(s ?? '').toLowerCase().trim().replace(/\s+/g, ' ');

// Reject obvious non-names so suggestions stay clean.
function looksLikeName(s) {
  if (!s) return false;
  const n = norm(s);
  if (n.length < 2 || n.length > 80) return false;
  if (n === 'null' || n === 'unknown' || n === 'various' || n === 'n/a') return false;
  if (!/[a-z]/i.test(n)) return false; // must contain a letter (not just digits/punct)
  return true;
}

async function main() {
  const t0 = Date.now();
  console.log(`[name-index] source: ${HOST}/${FMDB} layout ${LAYOUT}`);
  const token = await fmLogin();

  // name (normalised) → { display, n }  — keep the most common original casing.
  const artists = new Map();
  const albums = new Map();
  const bump = (map, raw) => {
    if (!looksLikeName(raw)) return;
    const key = norm(raw);
    const e = map.get(key);
    if (e) {
      e.n += 1;
      // Prefer the casing that appears most often as the display form.
      e.variants[raw] = (e.variants[raw] || 0) + 1;
    } else {
      map.set(key, { display: raw.trim(), n: 1, variants: { [raw]: 1 } });
    }
  };

  let offset = 1;
  let scanned = 0;
  let kept = 0;
  try {
    while (scanned < argLimit) {
      const page = await fmPage(token, offset, Math.min(PAGE, argLimit - scanned));
      if (!page.length) break;
      for (const rec of page) {
        scanned += 1;
        const f = rec.fieldData || {};
        if (!isVisible(f)) continue;
        if (!hasValidAudio(f)) continue;
        kept += 1;
        bump(artists, val(f, 'Album Artist'));
        bump(artists, val(f, 'Track Artist'));
        bump(albums, val(f, 'Album Title') || val(f, 'Tape Files::Album Title'));
      }
      offset += page.length;
      if (scanned % 10000 < PAGE) {
        console.log(`[name-index] scanned ${scanned} (artists=${artists.size} albums=${albums.size}) ${(Date.now() - t0) / 1000 | 0}s`);
      }
    }
  } finally {
    await fmLogout(token);
  }

  const finalize = (map) =>
    [...map.values()]
      .map((e) => {
        // pick the most frequent original casing as display
        const display = Object.entries(e.variants).sort((a, b) => b[1] - a[1])[0][0].trim();
        return { name: display, n: e.n };
      })
      .sort((a, b) => b.n - a.n);

  const out = {
    builtAt: new Date().toISOString(),
    source: `${HOST}/${FMDB}/${LAYOUT}`,
    scanned,
    kept,
    artists: finalize(artists),
    albums: finalize(albums)
  };

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  // Atomic write (tmp + rename) so a boot-time read never sees a partial file.
  const tmp = `${OUT_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(out));
  fs.renameSync(tmp, OUT_PATH);

  console.log(`[name-index] done: scanned ${scanned}, kept ${kept}, ${out.artists.length} artists, ${out.albums.length} albums → ${OUT_PATH} (${(Date.now() - t0) / 1000 | 0}s)`);
}

main().catch((err) => {
  console.error('[name-index] FAILED:', err.message);
  process.exit(1);
});
