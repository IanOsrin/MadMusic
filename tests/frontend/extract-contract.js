// Frontend structural-contract extractor.
//
// The MadMusic frontend has no build step: app.html's inline <script> blocks
// coordinate with app.min.js (and the js/*.js modules) purely through shared
// window.* globals, script load-order, and element IDs. There is no compiler to
// catch a broken contract. This module fingerprints that contract so a refactor
// that silently severs it gets caught by tests/frontend/structural-contract.test.js.
//
// Pure functions, no backend, no dependencies — just reads files from public/.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const PUBLIC_DIR = join(__dirname, '..', '..', 'public');

// HTML views users actually load. ringtone.html is included because it shares
// the player/stream contract.
export const HTML_VIEWS = ['app.html', 'mobile.html', 'audio-lab.html', 'ringtone.html'];
// Standalone JS that participates in the global contract.
export const JS_MODULES = [
  'app.min.js',
  'js/helpers.js', 'js/auth.js', 'js/player.js', 'js/playlists.js',
  'js/catalog.js', 'js/currency.js', 'js/discovery.js', 'js/mobile.js',
];

// Browser/DOM built-ins that live on window but are not part of OUR contract.
const WINDOW_BUILTINS = new Set([
  'location', 'addEventListener', 'removeEventListener', 'innerWidth', 'innerHeight',
  'scrollTo', 'scrollY', 'scrollX', 'matchMedia', 'history', 'navigator', 'document',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'open', 'close', 'clear',
  'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'localStorage',
  'sessionStorage', 'fetch', 'alert', 'confirm', 'prompt', 'parent', 'top', 'self',
  'console', 'dataLayer', 'getSelection', 'focus', 'blur', 'print', 'crypto', 'btoa', 'atob',
  'devicePixelRatio', 'screen', 'frames', 'onload', 'onresize', 'onscroll', 'onerror',
  'pageYOffset', 'pageXOffset', 'visualViewport', 'AudioContext', 'webkitAudioContext',
  'dispatchEvent', 'postMessage', 'requestIdleCallback', 'CustomEvent', 'Event', 'URL',
]);

function read(name) {
  return readFileSync(join(PUBLIC_DIR, name), 'utf8');
}

// Strip the ?v=...&t=... cache-busting query so the fingerprint is stable across
// version bumps but still notices a script being added, removed, or reordered.
function stripQuery(src) {
  return src.replace(/\?.*$/, '');
}

// Ordered sequence of <script> entries: external scripts become their src path,
// inline blocks become the literal "inline". Captures load-order coupling
// (e.g. "inline scripts before app.min.js") without being brittle to inline edits.
export function scriptSequence(html) {
  const seq = [];
  const re = /<script\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1];
    const srcMatch = attrs.match(/\bsrc\s*=\s*"([^"]+)"/i);
    seq.push(srcMatch ? stripQuery(srcMatch[1]) : 'inline');
  }
  return seq;
}

export function externalScripts(html) {
  return scriptSequence(html).filter((s) => s !== 'inline');
}

// All window.<ident> identifiers referenced in a source string, minus DOM built-ins.
export function windowGlobals(src) {
  const out = new Set();
  const re = /window\.([A-Za-z_$][A-Za-z0-9_$]*)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (!WINDOW_BUILTINS.has(m[1])) out.add(m[1]);
  }
  return [...out].sort();
}

// Element IDs declared in markup: id="foo".
export function definedIds(html) {
  const out = new Set();
  const re = /\bid\s*=\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) out.add(m[1]);
  return [...out].sort();
}

// Element IDs the code reaches for: getElementById('foo') and querySelector('#foo').
export function referencedIds(src) {
  const out = new Set();
  let m;
  const byId = /getElementById\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = byId.exec(src)) !== null) out.add(m[1]);
  // querySelector('#foo') / querySelectorAll('#foo .bar') — take the leading #id token only.
  const byQuery = /querySelector(?:All)?\(\s*['"]#([A-Za-z_][\w-]*)/g;
  while ((m = byQuery.exec(src)) !== null) out.add(m[1]);
  return [...out].sort();
}

// Build the full contract fingerprint from disk.
export function buildContract() {
  const files = {};
  const globalsByFile = {};
  const allReferencedIds = new Set();

  for (const view of HTML_VIEWS) {
    const html = read(view);
    const g = windowGlobals(html);
    files[view] = {
      scriptOrder: scriptSequence(html),
      externalScripts: externalScripts(html),
      windowGlobals: g,
      definedIds: definedIds(html),
    };
    globalsByFile[view] = new Set(g);
    referencedIds(html).forEach((id) => allReferencedIds.add(id));
  }

  for (const mod of JS_MODULES) {
    const src = read(mod);
    const g = windowGlobals(src);
    globalsByFile[mod] = new Set(g);
    referencedIds(src).forEach((id) => allReferencedIds.add(id));
  }

  // crossFileGlobals: window.* names referenced in 2+ files — the actual shared
  // contract surface between app.html inline code and app.min.js et al.
  const counts = new Map();
  for (const set of Object.values(globalsByFile)) {
    for (const name of set) counts.set(name, (counts.get(name) || 0) + 1);
  }
  const crossFileGlobals = [...counts.entries()]
    .filter(([, c]) => c >= 2)
    .map(([name]) => name)
    .sort();

  // For each view, the IDs that ARE both declared here AND reached for by code
  // somewhere — i.e. DOM elements other code depends on. These must not vanish.
  const dependedOnIds = {};
  for (const view of HTML_VIEWS) {
    dependedOnIds[view] = files[view].definedIds.filter((id) => allReferencedIds.has(id));
  }

  return {
    note: 'Auto-generated fingerprint of the no-build frontend contract. Regenerate with UPDATE_BASELINE=1 npx vitest run tests/frontend/structural-contract.test.js',
    files,
    crossFileGlobals,
    referencedIds: [...allReferencedIds].sort(),
    dependedOnIds,
  };
}
