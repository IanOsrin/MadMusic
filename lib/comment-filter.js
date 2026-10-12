// lib/comment-filter.js — what a timed comment (or a display name) may not say (2026-10-12).
//
// A first line of defence, not the last: listeners can ⋮ Report anything that slips through, and the
// team hides comments in GalloIngest's Comments tab. It blocks slurs and strong profanity (English,
// Afrikaans, isiZulu) and links (spam). It works on WHOLE WORDS after undoing the usual disguises —
// letters swapped for digits/symbols (sh1t, $hit), letters repeated (fuuuck) or spaced out (f u c k) —
// so an innocent word that merely contains one ("Scunthorpe", "assess", "cocktail") is not blocked.
const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', '@': 'a', $: 's', '!': 'i', '|': 'i' };

// Matched anywhere inside a word (these never occur innocently inside other words).
const ANYWHERE = ['fuck', 'motherf', 'kafir', 'kafer', 'fagot'];
// Matched as a whole word, also with a plain English ending (-s, -es, -ed, -ing, -er, -a, -z) —
// 'cunt' and the n-word here, not above, or "Scunthorpe" and "Nigeria" would be blocked.
const WORDS = ['fuk', 'cunt', 'niger', 'niga', 'shit', 'bitch', 'whore', 'slut', 'dick', 'pusy', 'ashole', 'arsehole', 'fag', 'retard',
  'twat', 'wanker', 'poes', 'msunu', 'cock', 'penis', 'vagina', 'porn', 'rape', 'rapist'];
const ENDINGS = ['', 's', 'es', 'ed', 'ing', 'er', 'ers', 'a', 'as', 'z', 'y', 'ie', 'ies'];

/** lowercase, digits/symbols back to letters, every run of one letter collapsed to one */
function squash(word) {
  let s = '';
  for (const ch of word.toLowerCase()) s += LEET[ch] ?? ch;
  return s.replace(/[^a-z]/g, '').replace(/(.)\1+/g, '$1');
}

const LINK = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|co\.za|za|io|ly|me|app|link|xyz)\b)/i;

function hasBadWord(text) {
  const words = String(text).split(/\s+/).map(squash).filter(Boolean);
  const bad = (w) => ANYWHERE.some((a) => w.includes(a)) || WORDS.some((b) => ENDINGS.some((e) => w === b + e));
  if (words.some(bad)) return true;
  // spaced or dotted out: "f u c k", "s.h.i.t" — join runs of single letters and check again
  const singles = String(text).toLowerCase().match(/(?:\b[a-z0-9@$!]\b[\s._*-]*){3,}/g) || [];
  return singles.some((run) => bad(squash(run)));
}

export const COMMENT_MAX = 280;

/** { ok: true, text } — trimmed, collapsed whitespace — or { ok: false, error } */
export function checkComment(raw) {
  const text = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return { ok: false, error: 'Write something first.' };
  if (text.length > COMMENT_MAX) return { ok: false, error: `Keep it under ${COMMENT_MAX} characters.` };
  if (LINK.test(text)) return { ok: false, error: 'Links aren’t allowed in comments.' };
  if (hasBadWord(text)) return { ok: false, error: 'Please keep it friendly — that comment has language we don’t allow.' };
  return { ok: true, text };
}

/** Display names: 2–24 letters, digits, spaces and . _ - ' — and the same word rules. */
export function checkDisplayName(raw) {
  const name = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (name.length < 2 || name.length > 24) return { ok: false, error: 'Choose a name of 2 to 24 characters.' };
  if (!/^[\p{L}\p{N} ._'’-]+$/u.test(name)) return { ok: false, error: 'Names can use letters, numbers, spaces and . _ - only.' };
  if (LINK.test(name) || hasBadWord(name)) return { ok: false, error: 'Please choose another name.' };
  return { ok: true, name };
}
