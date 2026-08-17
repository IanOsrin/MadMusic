import { describe, it, expect, vi, beforeEach } from 'vitest';

// The FM client is stubbed: these tests are about the matching and the
// append-don't-duplicate rule, not about FileMaker.
const fmFindAll = vi.fn();
const fmCreateRecord = vi.fn();
const fmUpdateRecord = vi.fn();
vi.mock('../../fm-client.js', () => ({
  fmFindAll: (...a) => fmFindAll(...a),
  fmCreateRecord: (...a) => fmCreateRecord(...a),
  fmUpdateRecord: (...a) => fmUpdateRecord(...a),
}));

const { searchSubjects, saveSubject, bustSubjects, normalizeSubject, terms } =
  await import('../../lib/shop-knowledge.js');

const rec = (id, Subject, Titbits, Active = '0') => ({ recordId: id, fieldData: { Subject, Titbits, Active } });

const LIBRARY = [
  rec('1', 'mbaqanga', 'Mbaqanga is a South African style that grew out of Sophiatown in the 1960s, built on a rolling bassline and groaning vocals.'),
  rec('2', 'maskandi', 'Maskandi is Zulu folk guitar music, traditionally a travelling musician picking a guitar and speaking praise poetry over it.'),
  rec('3', 'kwela', 'Kwela is pennywhistle street music from the 1950s townships, played on corners and often a lookout for police vans.'),
];

beforeEach(() => {
  vi.clearAllMocks();
  bustSubjects();
  fmFindAll.mockResolvedValue({ ok: true, data: LIBRARY });
});

describe('subject matching', () => {
  it('finds an entry by its exact subject', async () => {
    const hits = await searchSubjects('mbaqanga');
    expect(hits[0].subject).toBe('mbaqanga');
  });

  it('finds an entry from a natural question, not just the bare word', async () => {
    const hits = await searchSubjects("what's the difference between mbaqanga and maskandi?");
    expect(hits.map(h => h.subject)).toEqual(expect.arrayContaining(['mbaqanga', 'maskandi']));
  });

  it('matches on the body when the subject word is not used', async () => {
    const hits = await searchSubjects('pennywhistle');
    expect(hits[0].subject).toBe('kwela');
  });

  it('returns nothing rather than a bad guess for an unrelated topic', async () => {
    expect(await searchSubjects('bebop trumpet in Detroit')).toEqual([]);
  });

  it('ignores question words, so "what is the" alone matches nothing', async () => {
    expect(terms('what is the')).toEqual([]);
    expect(await searchSubjects('what is the')).toEqual([]);
  });

  it('never breaks a chat turn when FileMaker is down', async () => {
    bustSubjects();
    fmFindAll.mockRejectedValue(new Error('FM unreachable'));
    expect(await searchSubjects('mbaqanga')).toEqual([]);
  });

  it('skips subjects with nothing written under them', async () => {
    bustSubjects();
    fmFindAll.mockResolvedValue({ ok: true, data: [rec('9', 'jive', '')] });
    expect(await searchSubjects('jive')).toEqual([]);
  });
});

describe('filing a subject', () => {
  it('creates an entry with Subject set and no Artist_Name, so it is not a bio', async () => {
    fmCreateRecord.mockResolvedValue({ recordId: '77' });
    await saveSubject('marabi', 'Marabi is a keyboard style from the shebeens of the 1930s, a three-chord cycle played for hours.', { question: 'what is marabi?' });
    const [layout, fields] = fmCreateRecord.mock.calls[0];
    expect(layout).toBeTruthy();
    expect(fields.Subject).toBe('marabi');
    expect(fields.Artist_Name).toBeUndefined();
  });

  it('is NOT gated — Active is for biographies only', async () => {
    fmCreateRecord.mockResolvedValue({ recordId: '78' });
    await saveSubject('marabi', 'Marabi is a keyboard style from the shebeens of the 1930s, a three-chord cycle played for hours.');
    expect(fmCreateRecord.mock.calls[0][1].Active).toBeUndefined();
  });

  it('appends to the existing subject instead of creating a duplicate', async () => {
    fmUpdateRecord.mockResolvedValue({});
    const fuller = LIBRARY[0].fieldData.Titbits + ' It carried through Soweto and into the 1970s, and the Soul Brothers took it onto the charts.';
    await saveSubject('Mbaqanga', fuller, { question: 'tell me more about mbaqanga' });
    expect(fmCreateRecord).not.toHaveBeenCalled();
    expect(fmUpdateRecord).toHaveBeenCalled();
    expect(fmUpdateRecord.mock.calls[0][2].Titbits).toBe(fuller);
  });

  it('keeps the fuller note when the same subject comes back thinner', async () => {
    await saveSubject('mbaqanga', 'Mbaqanga is a South African style of music that people dance to.');
    expect(fmUpdateRecord).not.toHaveBeenCalled();
    expect(fmCreateRecord).not.toHaveBeenCalled();
  });

  it('refuses to file a scrap', async () => {
    expect(await saveSubject('kwela', 'nice music')).toBeNull();
    expect(fmCreateRecord).not.toHaveBeenCalled();
  });

  it('normalises subjects so casing and punctuation do not split a topic', () => {
    expect(normalizeSubject('  Mbaqanga vs. Maskandi! ')).toBe('mbaqanga vs maskandi');
  });
});
