// Duplication ratchet (see duplication.js).
//
// This is NOT a correctness test — it is a progress gauge for the code-quality
// overhaul. It records how much CSS/JS is duplicated across the view files and
// fails if a change makes duplication WORSE. As the overhaul extracts shared
// CSS/JS into common files, regenerate the baseline downward:
//   UPDATE_BASELINE=1 npx vitest run tests/frontend/duplication-baseline.test.js

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildDuplicationReport } from './duplication.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = join(__dirname, 'duplication.baseline.json');

let current;
let baseline;

beforeAll(() => {
  current = buildDuplicationReport();
  if (process.env.UPDATE_BASELINE === '1' || !existsSync(BASELINE_PATH)) {
    writeFileSync(BASELINE_PATH, JSON.stringify(current, null, 2) + '\n');
    console.log(`[duplication] baseline written to ${BASELINE_PATH}`);
  }
  baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
});

describe('frontend duplication ratchet', () => {
  it('does not increase total duplicated CSS/JS across views', () => {
    expect(
      current.totalRedundantCopies,
      `duplication grew from ${baseline.totalRedundantCopies} to ${current.totalRedundantCopies} redundant lines`,
    ).toBeLessThanOrEqual(baseline.totalRedundantCopies);
  });

  it('does not increase duplicated CSS specifically', () => {
    expect(current.cssDuplication.redundantCopies)
      .toBeLessThanOrEqual(baseline.cssDuplication.redundantCopies);
  });

  it('does not increase duplicated inline JS specifically', () => {
    expect(current.jsDuplication.redundantCopies)
      .toBeLessThanOrEqual(baseline.jsDuplication.redundantCopies);
  });
});
