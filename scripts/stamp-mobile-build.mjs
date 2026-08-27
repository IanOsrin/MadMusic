#!/usr/bin/env node
// Stamp the mobile app's asset graph with one build number, so a deploy is
// instantly visible on cached phones (Safari serves last week's modules with
// this week's HTML otherwise — the ?v= note in main.js, generalised).
//
//   node scripts/stamp-mobile-build.mjs 5
//
// Rewrites: mobile.html's /css/mobile.css, /js/helpers.js and /js/mobile/*.js
// references, and EVERY relative import inside public/js/mobile/*.js — module
// cache keys are full URLs, so busting the entry file alone leaves the rest
// of the graph stale.
import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';

const v = process.argv[2];
if (!/^\d+$/.test(v || '')) { console.error('usage: node scripts/stamp-mobile-build.mjs <buildNumber>'); process.exit(1); }

const root = join(import.meta.dirname, '..', 'public');
let files = 0, stamps = 0;

function stamp(text) {
  // any .css/.js reference that already carries ?v=N, or is bare, gets ?v=<v>;
  // extra params after the stamp (the css retry's &r=) are preserved
  return text
    .replace(/((?:href|src)=")([^"?]+\.(?:css|js))(\?v=\d+)?(["&])/g, (_, a, path, _old, tail) => { stamps++; return `${a}${path}?v=${v}${tail === '&' ? '&' : '"'}`; })
    .replace(/(from\s+')(\.\/[^'?]+\.js)(\?v=\d+)?(')/g, (_, a, path, _old, q) => { stamps++; return `${a}${path}?v=${v}${q}`; })
    .replace(/(import\(')(\.\/[^'?]+\.js)(\?v=\d+)?('\))/g, (_, a, path, _old, q) => { stamps++; return `${a}${path}?v=${v}${q}`; });
}

const html = join(root, 'mobile.html');
writeFileSync(html, stamp(readFileSync(html, 'utf8'))); files++;

const dir = join(root, 'js', 'mobile');
for (const f of readdirSync(dir)) {
  if (!f.endsWith('.js')) continue;
  const p = join(dir, f);
  writeFileSync(p, stamp(readFileSync(p, 'utf8'))); files++;
}
console.log(`stamped build ${v}: ${stamps} references across ${files} files`);
