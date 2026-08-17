/**
 * lib/shop-knowledge.js — Maddie's subject knowledge: what the shop has already
 * learned about topics that are not about one artist.
 *
 * "What's the difference between mbaqanga and maskandi?" has no artist to file
 * under, so before this it was researched from scratch every single time it was
 * asked, and the answer thrown away the moment the visitor closed the tab. Each
 * repeat cost another web dig. These records are that answer, kept.
 *
 * Stored on the SAME FM layout as artist bios (`API_Artist_Bio`) using the
 * Subject field, because that is where Ian added it — an entry has a Subject and
 * no Artist_Name, where a bio has a name and no Subject.
 *
 * TWO RULES SEPARATE THIS FROM BIOS, and both matter:
 *
 *   1. NOT GATED. Artist bios ship Active=0 and wait for review, because they are
 *      client-facing and marketing-proofed. Subject entries are Maddie's internal
 *      resource, never shown to a visitor, so they are readable the moment they
 *      are written — that is the whole saving. Active is for biographies only.
 *
 *   2. NEVER SERVED TO A CLIENT. There is deliberately no route here. The lookup
 *      is a function the chat loop calls in-process, so an internal working note
 *      cannot leak onto the site through an endpoint someone finds later.
 *
 * Reads go through the SWR cache like every other FM read path (see CLAUDE.md);
 * writes are never cached and bust the cache themselves.
 */
import { fmFindAll, fmCreateRecord, fmUpdateRecord } from '../fm-client.js';
import { FM_ARTIST_BIO_LAYOUT } from './fm-fields.js';
import { createSwrCache } from './swr-cache.js';

const TTL_MS   = Number(process.env.SHOP_KNOWLEDGE_TTL_MS || 300_000);   // 5 min
const MAX_ROWS = Number(process.env.SHOP_KNOWLEDGE_MAX || 10_000);       // backstop, not a page size

/** Normalise a subject for comparison: lowercase, collapse whitespace, drop punctuation. */
export function normalizeSubject(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const STOP = new Set(['a','an','the','and','or','of','in','on','is','are','was','were','to','for',
  'what','who','whom','whose','which','how','why','when','where','do','does','did','tell','me',
  'about','between','difference','vs','versus','some','any','can','you','i','it','its','this','that']);

/** Content words of a query — what a topic match should actually turn on. */
export function terms(s) {
  return [...new Set(normalizeSubject(s).split(' ').filter(w => w.length > 2 && !STOP.has(w)))];
}

export function mapSubjectRecord(r) {
  const f = r.fieldData || {};
  return {
    recordId: r.recordId,
    subject: String(f.Subject || '').trim(),
    knowledge: String(f.Titbits || '').trim(),
    note: String(f.Suggestion_Note || '').trim(),
  };
}

/**
 * Every record carrying a Subject, whatever its Active state — see rule 1. A
 * record needs both a subject and something written under it to be worth
 * returning; a subject with empty Titbits is a gap someone logged, not an answer.
 */
async function fetchSubjects() {
  // Paged: this set only ever grows, and that is the point of it.
  const res = await fmFindAll(FM_ARTIST_BIO_LAYOUT, [{ Subject: '*' }], { pageSize: 500, maxRecords: MAX_ROWS });
  return (res?.data || [])
    .map(mapSubjectRecord)
    .filter(s => s.subject && s.knowledge);
}

const subjectSwr = createSwrCache({
  ttlMs: TTL_MS,
  max: 2,
  label: 'shop-knowledge',
  name: 'shop-knowledge',
  loader: () => fetchSubjects(),
});

/** Drop the cached list so a just-written entry is findable on the next question. */
export function bustSubjects() {
  try { subjectSwr.cache.clear(); } catch { /* cache shape changed — not fatal */ }
}

export async function allSubjects() {
  try {
    const r = await subjectSwr.get('default');
    return r.value || [];
  } catch {
    return [];              // FM down must never break a chat turn
  }
}

/**
 * Find what the shop already knows about a topic. Scores an exact subject match
 * highest, then subject-word overlap, then a mention in the body — so "maskandi"
 * finds the mbaqanga/maskandi entry filed under either name.
 */
export async function searchSubjects(query, { limit = 3 } = {}) {
  const q = normalizeSubject(query);
  if (!q) return [];
  const words = terms(query);
  const rows = await allSubjects();

  const scored = rows.map(row => {
    const subj = normalizeSubject(row.subject);
    const body = normalizeSubject(row.knowledge);
    let score = 0;
    if (subj === q) score += 100;
    else if (subj.includes(q) || q.includes(subj)) score += 50;
    const subjWords = new Set(subj.split(' '));
    for (const w of words) {
      if (subjWords.has(w)) score += 10;
      else if (subj.includes(w)) score += 6;
      else if (body.includes(w)) score += 2;
    }
    return { row, score };
  }).filter(s => s.score > 0);

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(s => s.row);
}

/**
 * File what was learned. Appends to an existing subject rather than creating a
 * second record for the same topic — otherwise asking a popular question twice
 * quietly doubles the shelf instead of deepening it.
 */
export async function saveSubject(subject, knowledge, { question = '', source = '' } = {}) {
  const subj = String(subject || '').trim().slice(0, 100);
  const text = String(knowledge || '').trim();
  if (!subj || text.length < 40) return null;      // nothing worth keeping

  const stamp = new Date().toISOString().slice(0, 10);
  const rows = await allSubjects();
  const existing = rows.find(r => normalizeSubject(r.subject) === normalizeSubject(subj));

  try {
    if (existing) {
      // Already answered. Keep the fuller version rather than growing the record
      // without bound — a subject asked twenty times should not be twenty essays.
      if (text.length <= existing.knowledge.length) return existing.recordId;
      await fmUpdateRecord(FM_ARTIST_BIO_LAYOUT, existing.recordId, {
        Titbits: text,
        Suggestion_Note: `${existing.note}\nUpdated ${stamp} — asked again: "${String(question).slice(0, 120)}"`.slice(-900),
      });
      bustSubjects();
      return existing.recordId;
    }

    const res = await fmCreateRecord(FM_ARTIST_BIO_LAYOUT, {
      Subject: subj,
      Titbits: text,
      // Artist_Name deliberately blank: that is what makes this a subject entry
      // rather than a bio, and it keeps it out of the artist name index.
      Suggestion_Note: `Maddie's own note, ${stamp}${source ? ` (${source})` : ''} — from: "${String(question).slice(0, 120)}". Internal resource, not shown to visitors.`,
    });
    bustSubjects();
    return res?.recordId || null;
  } catch (err) {
    console.warn('[shop-knowledge] save failed for', subj, '—', err?.message || err);
    return null;
  }
}
