import { describe, it, expect } from 'vitest';
import {
  normalizeEmail,
  normTitle,
  makeAlbumKey,
  normalizeRecordId,
  parsePositiveInt,
  parseNonNegativeInt,
  normalizeSeconds,
  toCleanString,
  escapeHtml,
  formatTimestampUTC,
  parseFileMakerTimestamp,
  splitPlaylistNames,
  slugifyPlaylistName,
  normalizeShareId,
  generateShareId
} from '../../lib/format.js';

describe('normalizeEmail', () => {
  it('lowercases and trims', () => {
    expect(normalizeEmail('  Foo@Bar.COM ')).toBe('foo@bar.com');
  });
  it('returns empty for non-string', () => {
    expect(normalizeEmail(123)).toBe('');
    expect(normalizeEmail(null)).toBe('');
    expect(normalizeEmail(undefined)).toBe('');
  });
});

describe('normTitle', () => {
  it('collapses whitespace and strips edge non-word chars', () => {
    expect(normTitle('  ?? Hello   World !! ')).toBe('Hello World');
  });
  it('normalises curly quotes', () => {
    expect(normTitle('it’s')).toBe("it's");
    expect(normTitle('say “hi” yo')).toBe('say "hi" yo');
  });
  it('handles null/undefined', () => {
    expect(normTitle(null)).toBe('');
    expect(normTitle(undefined)).toBe('');
  });
});

describe('makeAlbumKey', () => {
  it('prefers catalogue when present', () => {
    expect(makeAlbumKey('CAT-1', 'X', 'Y')).toBe('cat:cat-1');
  });
  it('falls back to title+artist', () => {
    expect(makeAlbumKey('', 'Abbey Road', 'The Beatles')).toBe('title:abbey road|artist:the beatles');
  });
});

describe('parsePositiveInt / parseNonNegativeInt', () => {
  it('positive accepts >0', () => {
    expect(parsePositiveInt('5', 99)).toBe(5);
    expect(parsePositiveInt('0', 99)).toBe(99);
    expect(parsePositiveInt('-1', 99)).toBe(99);
    expect(parsePositiveInt('abc', 99)).toBe(99);
  });
  it('non-negative accepts >=0', () => {
    expect(parseNonNegativeInt('0', 99)).toBe(0);
    expect(parseNonNegativeInt('-1', 99)).toBe(99);
  });
});

describe('normalizeSeconds', () => {
  it('rounds and clamps to >=0', () => {
    expect(normalizeSeconds(3.6)).toBe(4);
    expect(normalizeSeconds('5.2')).toBe(5);
    expect(normalizeSeconds(-3)).toBe(0);
    expect(normalizeSeconds('garbage')).toBe(0);
  });
});

describe('toCleanString', () => {
  it('returns string for string', () => {
    expect(toCleanString('x')).toBe('x');
  });
  it('returns empty for null/undefined', () => {
    expect(toCleanString(null)).toBe('');
    expect(toCleanString(undefined)).toBe('');
  });
});

describe('escapeHtml', () => {
  it('escapes the five HTML metas', () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&</a>`))
      .toBe('&lt;a href=&quot;x&quot; onclick=&#039;y&#039;&gt;&amp;&lt;/a&gt;');
  });
  it('coerces non-strings safely', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(42)).toBe('42');
  });
});

describe('formatTimestampUTC', () => {
  it('formats a known date deterministically', () => {
    expect(formatTimestampUTC(new Date('2024-03-04T05:06:07Z'))).toBe('03/04/2024 05:06:07');
  });
  it('falls back to now() for invalid', () => {
    expect(formatTimestampUTC('not-a-date')).toMatch(/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}$/);
  });
});

describe('parseFileMakerTimestamp', () => {
  it('parses ISO', () => {
    expect(parseFileMakerTimestamp('2024-03-04T00:00:00Z')).toBe(Date.parse('2024-03-04T00:00:00Z'));
  });
  it('returns 0 for falsy', () => {
    expect(parseFileMakerTimestamp(null)).toBe(0);
    expect(parseFileMakerTimestamp('')).toBe(0);
  });
});

describe('splitPlaylistNames', () => {
  it('splits on , ; | and newlines', () => {
    expect(splitPlaylistNames('a,b ; c|d\ne')).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
  it('drops empties', () => {
    expect(splitPlaylistNames(',,,')).toEqual([]);
  });
});

describe('slugifyPlaylistName', () => {
  it('lowercases + dashes', () => {
    expect(slugifyPlaylistName('My Cool!  Playlist')).toBe('my-cool-playlist');
  });
  it('trims edge dashes', () => {
    expect(slugifyPlaylistName('!!hello!!')).toBe('hello');
  });
});

describe('normalizeShareId', () => {
  it('trims strings', () => {
    expect(normalizeShareId('  abc ')).toBe('abc');
  });
  it('returns empty for non-strings', () => {
    expect(normalizeShareId(null)).toBe('');
  });
});

describe('generateShareId', () => {
  it('returns 32 hex chars', () => {
    const id = generateShareId();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });
  it('returns unique values', () => {
    const a = generateShareId();
    const b = generateShareId();
    expect(a).not.toBe(b);
  });
});

describe('normalizeRecordId', () => {
  it('trims and stringifies', () => {
    expect(normalizeRecordId(' 42 ')).toBe('42');
    expect(normalizeRecordId(42)).toBe('42');
    expect(normalizeRecordId(null)).toBe('');
  });
});
