#!/usr/bin/env node
/**
 * build-mad-mixer.mjs — make public/mad-mixer.html from the Digital Cupboard Stems app.
 *
 *   node scripts/build-mad-mixer.mjs [path/to/app-stems.html]
 *
 * The MASTER stays in the DCMax repo (default: the Bandlab drive,
 * /Volumes/Bandlab/DigitalCupboardMax/frontend-src/app-stems.html, or $MAD_MIXER_SRC).
 * Nothing here edits it. This script copies it and adapts the copy for MAD:
 *   · name and header → "Mad Mixer", MAD logo, MAD footer
 *   · the warm amber palette → MAD's dark grey + purple (every hard-coded colour mapped)
 *   · lamejs/JSZip from cdnjs (allowed by MAD's security policy) instead of jsDelivr
 *   · "contact Digital Cupboard" wording → MAD wording
 *   · public/css/mad-mixer.css + public/js/mad-mixer.js injected (branding + the adapter
 *     that signs in with the MAD token, points API calls at /api/mixer and loads ?t= tracks)
 * Every substitution must match: if the master changes shape, the build stops and says
 * which one missed, rather than shipping a half-branded page.
 * Re-run after any change to the master, then reload /mixer.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = process.argv[2] || process.env.MAD_MIXER_SRC || '/Volumes/Bandlab/DigitalCupboardMax/frontend-src/app-stems.html';
const OUT = path.join(here, '..', 'public', 'mad-mixer.html');

if (!fs.existsSync(SRC)) {
  console.error(`Master not found: ${SRC}\nIs the Bandlab drive connected? Or pass the path to app-stems.html.`);
  process.exit(1);
}
let html = fs.readFileSync(SRC, 'utf8');

// Provenance: which commit of the master this was built from.
let commit = 'unknown';
try {
  const repo = path.dirname(path.dirname(SRC));
  commit = execFileSync('git', ['-C', repo, 'log', '-1', '--format=%h %cs %s'], { encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['-C', repo, 'status', '--porcelain', '--', path.relative(repo, SRC)], { encoding: 'utf8' }).trim();
  if (dirty) commit += ' (+ uncommitted changes)';
} catch { /* not a git checkout — fine */ }

const missed = [];
function sub(from, to, { all = false, optional = false } = {}) {
  const n = typeof from === 'string' ? html.split(from).length - 1 : (html.match(from) || []).length;
  if (!n) { if (!optional) missed.push(String(from).slice(0, 90)); return; }
  html = all ? (typeof from === 'string' ? html.split(from).join(to) : html.replace(from, to))
             : html.replace(from, to);
}

// ── 1 · identity ──────────────────────────────────────────────────────────────
sub(/<title>[^<]*<\/title>/, '<title>Mad Mixer — Music Africa Direct</title>');
sub('<div class="logo">🎛️</div>',
    '<a class="logo mm-logo" href="/" title="Back to Music Africa Direct"><img src="/img/Madmusiclogonew-dark.png" alt="MAD — Music Africa Direct"></a>');
sub(/<h1>Digital Cupboard Audio App<\/h1>\s*<small>[^<]*<\/small>/,
    '<h1>Mad Mixer</h1>\n    <small>Split any track into stems — vocals, drums, bass and more — then mix, rework and download</small>');
sub(/<span class="header-badge">[^<]*<\/span>/, '<span class="header-badge">Stems</span>');
sub(/<footer>[^<]*<\/footer>/, '<footer>Mad Mixer · Music Africa Direct · stem engine by Digital Cupboard</footer>');
sub('Split credits used up — contact Digital Cupboard to top up.', 'You have used this month’s splits — they reset on the 1st.', { optional: true });
sub(/Contact Digital Cupboard( to top up)?/g, 'Contact Music Africa Direct', { all: true, optional: true });
sub(/contact Digital Cupboard/g, 'contact Music Africa Direct', { all: true, optional: true });

// ── 2 · libraries from the CDN MAD's security policy allows ──────────────────
sub('https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js', 'https://cdnjs.cloudflare.com/ajax/libs/lamejs/1.2.1/lame.min.js');
sub('https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js', 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js');

// ── 3 · palette: DCMax warm amber → MAD dark grey + purple ───────────────────
// Status colours (green = ok, red = danger) and the per-stem colour palette are kept.
const HEX = {
  // accents: amber/gold → MAD purples
  '#c47d2a': '#8b5cf6', '#9a5e12': '#7c3aed', '#2e1d0a': '#1e1433', '#e09a3a': '#a78bfa',
  '#ffcb52': '#c4b5fd', '#f59e0b': '#a78bfa', '#d99300': '#7c3aed', '#f0a832': '#a78bfa',
  '#e89a14': '#8b5cf6', '#ffd35e': '#c4b5fd', '#c9a15e': '#a78bfa', '#caa46a': '#b4a3f0',
  '#f0c987': '#c4b5fd', '#7a6234': '#6d5bb0', '#c05a28': '#7c3aed',
  // surfaces: warm browns → MAD greys
  '#100c07': '#121212', '#1c1610': '#1a1a1a', '#251d14': '#222222', '#1a1208': '#1a1a1a',
  '#221c16': '#1f1f1f', '#0e0a06': '#0e0e0e', '#0a0705': '#0a0a0a', '#080603': '#080808',
  '#2c2419': '#262626', '#3a2f24': '#333333', '#3d2c1a': '#333333', '#4a3a20': '#3a3a3a',
  '#160f06': '#161616', '#3a2f1c': '#2e2e2e', '#201508': '#1c1c1c', '#5a4e2c': '#4a4a4a',
  // text: warm creams → MAD neutrals
  '#f0e6d2': '#e8e8e8', '#f2e8d0': '#e8e8e8', '#e8d8c0': '#e0e0e0', '#b8a890': '#b0b0b0',
  '#a89172': '#9a9a9a', '#b09070': '#aaaaaa', '#7a6a55': '#999999', '#5a4a30': '#777777',
};
let colourHits = 0;
for (const [from, to] of Object.entries(HEX)) {
  const re = new RegExp(from.replace('#', '#') + '(?![0-9a-fA-F])', 'gi');
  html = html.replace(re, () => { colourHits++; return to; });
}
const RGBA = [[/rgba\(\s*196\s*,\s*125\s*,\s*42\s*,/g, 'rgba(139,92,246,'], [/rgba\(\s*240\s*,\s*168\s*,\s*50\s*,/g, 'rgba(167,139,250,'],
              [/rgba\(\s*180\s*,\s*100\s*,\s*20\s*,/g, 'rgba(139,92,246,'], [/rgba\(\s*61\s*,\s*44\s*,\s*26\s*,/g, 'rgba(51,51,51,']];
for (const [re, to] of RGBA) html = html.replace(re, () => { colourHits++; return to; });

// ── 4 · MAD's branding sheet + the adapter ───────────────────────────────────
sub('</head>', '<link rel="stylesheet" href="/css/mad-mixer.css?v=2">\n</head>');
const lastBody = html.lastIndexOf('</body>');
if (lastBody < 0) missed.push('</body>');
else html = html.slice(0, lastBody) + '<script src="/js/mad-mixer.js?v=3"></script>\n' + html.slice(lastBody);

html = html.replace(/<!DOCTYPE html>/i, (m) => `${m}\n<!-- Mad Mixer — GENERATED by scripts/build-mad-mixer.mjs from ${path.basename(SRC)} @ ${commit}.\n     Do not edit here: change the DCMax master, then rebuild. -->`);

if (missed.length) {
  console.error('Build stopped — these parts of the master were not found (it may have changed):\n  · ' + missed.join('\n  · '));
  process.exit(2);
}
fs.writeFileSync(OUT, html);
console.log(`Mad Mixer built → ${path.relative(process.cwd(), OUT)} (${(html.length / 1024).toFixed(0)} KB, ${colourHits} colours remapped)\n  from ${SRC}\n  @ ${commit}`);
