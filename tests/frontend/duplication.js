// Duplication measurement across the sprawling frontend view files.
//
// The three big views (app.html, mobile.html, audio-lab.html) + ringtone.html
// were built by copy-paste and share large amounts of CSS and JS. This module
// produces a STABLE, reproducible numeric fingerprint of that duplication so the
// overhaul can prove it actually reduced it (see duplication-baseline.test.js,
// which ratchets the numbers down — they may shrink, never grow).
//
// Pure functions, no backend, no dependencies.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PUBLIC_DIR, HTML_VIEWS } from './extract-contract.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export { HTML_VIEWS };

function read(name) {
  return readFileSync(join(PUBLIC_DIR, name), 'utf8');
}

function blocksBetween(html, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(html)) !== null) out.push(m[1]);
  return out;
}

// A line is "significant" for duplication purposes if it carries real content —
// not blank, not a lone brace/bracket/comment marker that would match everywhere.
function isSignificant(line) {
  const t = line.trim();
  if (t.length < 20) return false;
  if (/^[{}()<>;,/*\-=.\s]+$/.test(t)) return false;
  return true;
}

function significantLines(text) {
  return text.split('\n').map((l) => l.trim()).filter(isSignificant);
}

// Count, across a set of {file -> lines} maps, how many distinct lines appear in
// 2+ files and how many redundant copies exist overall.
function crossFileDuplication(linesByFile) {
  const occ = new Map(); // line -> Set(files)
  for (const [file, lines] of Object.entries(linesByFile)) {
    for (const line of new Set(lines)) {
      if (!occ.has(line)) occ.set(line, new Set());
      occ.get(line).add(file);
    }
  }
  let sharedLineKeys = 0;
  let redundantCopies = 0;
  const examples = [];
  for (const [line, files] of occ) {
    if (files.size >= 2) {
      sharedLineKeys += 1;
      redundantCopies += files.size - 1;
      if (examples.length < 15) examples.push({ files: [...files].sort(), line: line.slice(0, 100) });
    }
  }
  return { sharedLineKeys, redundantCopies, examples };
}

export function buildDuplicationReport() {
  const perFile = {};
  const cssByFile = {};
  const jsByFile = {};

  for (const view of HTML_VIEWS) {
    const html = read(view);
    const css = blocksBetween(html, 'style').join('\n');
    // Inline scripts only (those without a src attribute were captured as full blocks).
    const inlineJs = blocksBetween(html, 'script')
      .filter((b) => b.trim().length > 0)
      .join('\n');

    const cssLines = significantLines(css);
    const jsLines = significantLines(inlineJs);

    cssByFile[view] = cssLines;
    jsByFile[view] = jsLines;
    perFile[view] = {
      totalLines: html.split('\n').length,
      styleBlocks: blocksBetween(html, 'style').length,
      cssSignificantLines: cssLines.length,
      inlineJsSignificantLines: jsLines.length,
    };
  }

  const css = crossFileDuplication(cssByFile);
  const js = crossFileDuplication(jsByFile);

  return {
    note: 'Stable duplication fingerprint of the frontend views. Lower is better. Regenerate with UPDATE_BASELINE=1 npx vitest run tests/frontend/duplication-baseline.test.js',
    perFile,
    cssDuplication: { sharedLineKeys: css.sharedLineKeys, redundantCopies: css.redundantCopies },
    jsDuplication: { sharedLineKeys: js.sharedLineKeys, redundantCopies: js.redundantCopies },
    totalRedundantCopies: css.redundantCopies + js.redundantCopies,
    cssExamples: css.examples,
    jsExamples: js.examples,
  };
}
