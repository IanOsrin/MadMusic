// Ian, 2026-11-09: "it plays then stops, we actually want it to carry on with other songs".
// Static guards; the behaviour itself needs a browser (real audio events).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p) => readFileSync(resolve(process.cwd(), p), 'utf8');
const app = read('public/app.html');
const player = read('public/js/player.js');
const phone = read('public/js/mobile/player.js');
const stream = read('routes/stream.js');

describe('music carries on when a song ends', () => {
  it('desktop falls back to more songs when nothing else has a next one', () => {
    const ended = app.slice(app.indexOf('End-of-track auto-advance for queues'));
    expect(ended.slice(0, 700)).toMatch(/_carryOn\(false\)/);
    expect(player).toMatch(/moreSongsAfter:\s*_randomSongsRefill/);
  });

  it('songs with no recordId (podcasts) are not followed by music', () => {
    expect(app).toMatch(/var lastId = _meta && _meta\.recordId;[\s\S]{0,120}if \(!lastId/);
  });

  it('a banner song drops any earlier queue, so an old album cannot resume after it', () => {
    const hero = app.slice(app.indexOf('function editorialAction(it)'));
    expect(hero.slice(0, 2000)).toMatch(/window\.MADClaimQueue\(null\);\s*\n\s*\/\/ In guest mode/);
  });

  it('a card play runs on through its rail', () => {
    expect(app).toMatch(/window\.MADClaimQueue\(_songQueue\(ids, idx\)\)/);
    expect(app).toMatch(/var q = \{ ids: ids, idx: idx, autoEnded: true \}/);
  });

  it('every row queue reports when there is no next row', () => {
    expect(app).toMatch(/if \(!rows\[i\]\) return false;/);
    expect(read('public/js/catalog.js').match(/if \(!r\) return false; r\.click\(\);/g)).toHaveLength(2);
  });

  it('guests move on at the 30-second mark too', () => {
    expect(app).toMatch(/else if \(!_advanceQueue\(\)\) setTimeout\(function \(\) \{ _carryOn\(true\); \}/);
  });

  it('a banner song supplies its genre, on both desktop and phone', () => {
    expect(stream).toMatch(/const \{ url, field, artworkUrl, genre, _cached \} = resolved;/);
    expect(player).toMatch(/\/container'\);\s*\n\s*if \(r\.ok\) genre = /);
    expect(phone).toMatch(/\/container`\);\s*\n\s*if \(r\.ok\) genre = /);
  });
});
