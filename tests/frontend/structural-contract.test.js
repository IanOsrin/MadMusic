// Tripwire for the no-build frontend contract (see extract-contract.js).
//
// These tests do NOT prove the UI works — they prove that an aggressive refactor
// of the sprawling HTML files did not silently sever the load-order / shared-global
// / element-ID coupling that app.html inline scripts rely on from app.min.js et al.
//
// Workflow:
//   1. Baseline is committed at tests/frontend/contract.baseline.json.
//   2. After an INTENTIONAL frontend change, review the diff, then regenerate:
//        UPDATE_BASELINE=1 npx vitest run tests/frontend/structural-contract.test.js
//   3. An UNINTENTIONAL drift fails the test with a readable diff.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildContract, HTML_VIEWS } from './extract-contract.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = join(__dirname, 'contract.baseline.json');

let current;
let baseline;

beforeAll(() => {
  current = buildContract();

  if (process.env.UPDATE_BASELINE === '1' || !existsSync(BASELINE_PATH)) {
    writeFileSync(BASELINE_PATH, JSON.stringify(current, null, 2) + '\n');
    // eslint-disable-next-line no-console
    console.log(`[contract] baseline written to ${BASELINE_PATH}`);
  }
  baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
});

describe('frontend structural contract', () => {
  it('preserves external <script> load-order in every view', () => {
    // Order-sensitive: catches a script being added, removed, or reordered —
    // the single most dangerous class of regression for this codebase.
    for (const view of HTML_VIEWS) {
      expect(current.files[view].externalScripts, `external script order in ${view}`)
        .toEqual(baseline.files[view].externalScripts);
    }
  });

  it('keeps inline-vs-external script positions in every view', () => {
    // app.min.js must keep sitting at the right point among inline blocks
    // ("MUST register before app.min.js so ended fires first").
    for (const view of HTML_VIEWS) {
      expect(current.files[view].scriptOrder, `script sequence in ${view}`)
        .toEqual(baseline.files[view].scriptOrder);
    }
  });

  it('does not drop any shared window.* global', () => {
    // New shared globals are fine; a DISAPPEARING one means a producer or
    // consumer was severed across files.
    const missing = baseline.crossFileGlobals.filter(
      (g) => !current.crossFileGlobals.includes(g),
    );
    expect(missing, 'shared globals removed from the cross-file contract').toEqual([]);
  });

  it('keeps every DOM element that other code depends on', () => {
    // An ID that is both declared in a view AND reached for by getElementById/
    // querySelector somewhere must keep existing in that view.
    for (const view of HTML_VIEWS) {
      const stillDefined = new Set(current.files[view].definedIds);
      const missing = baseline.dependedOnIds[view].filter((id) => !stillDefined.has(id));
      expect(missing, `depended-on element IDs removed from ${view}`).toEqual([]);
    }
  });

  it('introduces no NEW orphaned element references across the frontend', () => {
    // An "orphan" = an ID reached for by getElementById/querySelector but not
    // declared in any view's markup. Many orphans are legitimate (elements built
    // at runtime in JS templates), so we grandfather everything orphaned at
    // baseline time and only fail on NEW orphans — i.e. either a refactor deleted
    // an element that code still references, or new code references a typo'd ID.
    const definedNow = new Set(HTML_VIEWS.flatMap((v) => current.files[v].definedIds));
    const baselineOrphans = new Set(
      baseline.referencedIds.filter(
        (id) => !HTML_VIEWS.some((v) => baseline.files[v].definedIds.includes(id)),
      ),
    );
    const newOrphans = current.referencedIds
      .filter((id) => !definedNow.has(id))
      .filter((id) => !baselineOrphans.has(id));
    expect(newOrphans, 'newly orphaned element references (deleted element or typo)')
      .toEqual([]);
  });
});
