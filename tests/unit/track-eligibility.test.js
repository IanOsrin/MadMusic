/**
 * The client's display rule: ISRC + UPC + cover, or it never renders.
 * Nothing is deleted from MadStreamer — this is a display filter, so a track
 * reappears the moment its codes are entered.
 *
 * It hides one song in five (13,829 of 67,328, measured before shipping), which
 * is why the flag and these guards exist.
 */
import { describe, it, expect } from 'vitest'
import { trackIsEligible, missingRequirements, ELIGIBILITY_ENABLED } from '../../lib/track-eligibility.js'

const full = {
  ISRC: 'ZAC110700032',
  UPC: '6009555110602',
  'Tape Files::Artwork_S3_URL': 'https://x.s3.amazonaws.com/artwork/GMVi1912.jpg',
}

describe('track eligibility', () => {
  it('is on by default — this is the requested behaviour, not an experiment', () => {
    expect(ELIGIBILITY_ENABLED).toBe(true)
  })

  it('passes a record with all three', () => {
    expect(trackIsEligible(full)).toBe(true)
  })

  for (const missing of ['ISRC', 'UPC']) {
    it(`rejects a record with no ${missing}`, () => {
      expect(trackIsEligible({ ...full, [missing]: '' })).toBe(false)
      expect(trackIsEligible({ ...full, [missing]: '   ' })).toBe(false)
    })
  }

  it('rejects a record with no cover', () => {
    expect(trackIsEligible({ ...full, 'Tape Files::Artwork_S3_URL': '' })).toBe(false)
  })

  it('rejects an artwork value that is not a real URL', () => {
    // A container path renders as a broken card — the thing the rule exists to
    // stop — so a truthy value is not enough.
    expect(trackIsEligible({ ...full, 'Tape Files::Artwork_S3_URL': 'image:/Gallo/cover.jpg' })).toBe(false)
  })

  it('accepts artwork from either the song or the album field', () => {
    const { 'Tape Files::Artwork_S3_URL': _drop, ...rest } = full
    expect(trackIsEligible({ ...rest, Artwork_S3_URL: 'https://x/y.jpg' })).toBe(true)
  })

  it('names what is missing, for the worklist', () => {
    expect(missingRequirements({})).toEqual(['isrc', 'upc', 'cover'])
    expect(missingRequirements({ ...full, ISRC: '' })).toEqual(['isrc'])
    expect(missingRequirements(full)).toEqual([])
  })
})

describe('the filter is wired where it must be', () => {
  it('rides on recordIsVisible, so every rail and the Postgres mirror inherit it', async () => {
    const { recordIsVisible } = await import('../../lib/fm-fields.js')
    expect(recordIsVisible(full)).toBe(true)
    expect(recordIsVisible({ ...full, ISRC: '' })).toBe(false)
  })

  it('is applied to public playlists, which do NOT call recordIsVisible on their own', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('../../routes/catalog/discovery.js', import.meta.url), 'utf8')
    const fn = src.slice(src.indexOf('async function loadPlaylistTracks'))
    expect(fn.slice(0, fn.indexOf('\n}'))).toMatch(/recordIsVisible/)
  })
})
