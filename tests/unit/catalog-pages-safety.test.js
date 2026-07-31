import { describe, it, expect, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { inlineJson } from '../../lib/share-meta.js';

// Guards for findings 12 and 13 of AUDIT_2026-07-31.md — both on the public,
// crawlable catalogue pages, which are served to anyone with no token.

let src;

beforeAll(async () => {
  src = await readFile(path.resolve('routes/catalog-pages.js'), 'utf8');
});

describe('finding 12 — JSON-LD must not be injectable', () => {
  it('escapes < so a value cannot close the script block', () => {
    const hostile = { name: 'Album </script><img src=x onerror=alert(1)>' };
    const out = inlineJson(hostile);
    expect(out).not.toContain('</script>');
    expect(out).toContain('\\u003c');
    // Still valid JSON — escaping must not corrupt the payload.
    expect(JSON.parse(out).name).toBe(hostile.name);
  });

  it('the ld+json block uses inlineJson, never raw JSON.stringify', () => {
    // JSON.stringify does not escape '<'. The realistic injection path is the
    // artist bio, which Maddie drafts from visitor-influenced input.
    expect(src).toMatch(/type="application\/ld\+json">\$\{inlineJson\(/);
    expect(src).not.toMatch(/ld\+json">\$\{JSON\.stringify\(/);
  });
});

describe('finding 13 — album pages must list only their own tracks', () => {
  it('queries the tracklist with exact-match operators', () => {
    // A plain multi-word value falls through to conditionSql's phrase-PREFIX
    // ILIKE, so "Greatest Hits" also matched "Greatest Hits Vol. 2" by the same
    // artist — the page and its JSON-LD numTracks listed another album's tracks.
    expect(src).toMatch(/'Album Title':\s*`==\$\{album\.title\}`/);
    expect(src).toMatch(/'Album Artist':\s*`==\$\{album\.artist\}`/);
  });

  it('has no remaining bare Album Title / Album Artist pgFind conditions', () => {
    expect(src).not.toMatch(/'Album Title':\s*album\.title/);
    expect(src).not.toMatch(/'Album Artist':\s*album\.artist/);
  });
});
