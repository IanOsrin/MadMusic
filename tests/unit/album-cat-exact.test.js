import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// 2026-09-30: /api/album?cat= matched catalogue numbers by PREFIX ("BL 30" also returned BL 300, 302,
// 303, 304, 308A/B, 30A/30B), so a YouTube song link for The Creations' "Groovy Love" (BL 30) opened
// another album. Catalogue lookups must be exact on both the Postgres and the FileMaker path.
describe('/api/album?cat= matches the catalogue number exactly', () => {
  const src = readFileSync(new URL('../../routes/catalog/discovery.js', import.meta.url), 'utf8');
  const route = src.slice(src.indexOf("router.get('/album'"));
  it('uses == (Postgres) / fmExactMatch (FileMaker), never a bare value', () => {
    expect(route).toMatch(/'Reference Catalogue Number': usePostgresMetadata\(\) \? '==' \+ cat : fmExactMatch\(cat\)/);
    expect(route).not.toMatch(/'Reference Catalogue Number': cat \}/);
  });
});
