import { describe, it, expect } from 'vitest';
import { checkComment, checkDisplayName, COMMENT_MAX } from '../../lib/comment-filter.js';

// The timed-comment word filter (2026-10-12): whole words after undoing disguises, so innocent words
// that merely CONTAIN a bad one stay allowed.
describe('comment filter', () => {
  const ok = (s) => expect(checkComment(s).ok, s).toBe(true);
  const no = (s) => expect(checkComment(s).ok, s).toBe(false);

  it('allows ordinary comments, including innocent look-alikes', () => {
    ['This takes me back to 1986 🔥', 'Mahlathini is the king!!', 'Scunthorpe represent', 'assess the cocktail party',
      'Nigeria loves this', 'night time vibes', 'Classic. My mother danced to this at her wedding'].forEach(ok);
  });
  it('blocks profanity and slurs, disguised or not', () => {
    ['what the fuuuck', 'sh1t is hard', '$hit', 'f u c k this', 'n i g g a', 'niggas', 'you bitches', 'poes', 'cunts', 'fuk off'].forEach(no);
  });
  it('blocks links, empties and over-long comments', () => {
    ['visit www.spam.com', 'see https://x.io', 'buy at cheap.co.za', '   ', 'a'.repeat(COMMENT_MAX + 1)].forEach(no);
  });
  it('tidies whitespace', () => expect(checkComment('  so   good \n now ').text).toBe('so good now'));
  it('checks display names', () => {
    expect(checkDisplayName('Thabo M').ok).toBe(true);
    expect(checkDisplayName('DJ_Sbu').ok).toBe(true);
    expect(checkDisplayName('x').ok).toBe(false);
    expect(checkDisplayName('fuckboy').ok).toBe(false);
    expect(checkDisplayName('<script>').ok).toBe(false);
  });
});
