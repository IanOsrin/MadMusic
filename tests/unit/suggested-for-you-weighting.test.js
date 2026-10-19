/**
 * "Suggested for You" weighting (Ian, 2026-10-19). A listener's rail led with
 * the children's music she played in July while she now plays Afrikaans rock,
 * and her rock seeds brought a 1970 folk revue. Two guards:
 *   - recent listening leads: a play halves in weight every 30 days;
 *   - a suggestion in the genre of the album that led to it keeps its full
 *     score, one in a genre she plays anyway keeps most, others less.
 */
import { describe, it, expect } from 'vitest'
import { listenWeight, HALF_LIFE_DAYS } from '../../lib/listening-profile.js'
import { genreKey, genreFactor } from '../../lib/semantic-index.js'

describe('listenWeight', () => {
  it('halves every 30 days', () => {
    expect(HALF_LIFE_DAYS).toBe(30)
    expect(listenWeight(0)).toBe(1)
    expect(listenWeight(30)).toBeCloseTo(0.5)
    expect(listenWeight(90)).toBeCloseTo(0.125)
  })

  it('a month of recent plays outweighs the same plays three months back', () => {
    expect(10 * listenWeight(5)).toBeGreaterThan(4 * 10 * listenWeight(95))
  })

  it('never counts a future-stamped play above 1', () => {
    expect(listenWeight(-3)).toBe(1)
  })
})

describe('genreKey', () => {
  it('joins the catalogue spellings of one genre', () => {
    expect(genreKey('Afro-folk')).toBe(genreKey('Afro-Folk'))
    expect(genreKey('Afro Folk')).toBe('afrofolk')
    expect(genreKey('')).toBe('')
    expect(genreKey(null)).toBe('')
  })
})

describe('genreFactor', () => {
  const plays = new Set(['pop', 'rock', 'maskandi'])
  it('same genre as the seed keeps the full score', () => {
    expect(genreFactor('rock', 'rock', plays)).toBe(1)
  })
  it('a genre the listener plays anyway keeps most of it', () => {
    expect(genreFactor('maskandi', 'afrofolk', plays)).toBe(0.85)
  })
  it('an unrelated genre is marked down the most', () => {
    expect(genreFactor('folk', 'pop', plays)).toBe(0.7)
  })
  it('a missing genre is neutral, not punished as unrelated', () => {
    expect(genreFactor('', 'pop', plays)).toBe(0.85)
    expect(genreFactor('pop', '', plays)).toBe(0.85)
  })
})
