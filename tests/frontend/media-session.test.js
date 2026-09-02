/**
 * Lock-screen playback controls (navigator.mediaSession).
 *
 * Without these a locked phone gives a MUSIC app no controls at all — the most
 * conspicuous gap in a web-wrapped player, and the thing Apple looks for when
 * deciding whether an app is more than a website in a frame.
 *
 * Static guards, in the spirit of mobile-invariants: the Playwright net does
 * not exercise mobile playback, and nothing here can be caught by a screenshot.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const player = readFileSync(join(process.cwd(), 'public/js/mobile/player.js'), 'utf8')
const main   = readFileSync(join(process.cwd(), 'public/js/mobile/main.js'), 'utf8')

describe('media session', () => {
  it('sets metadata when a track starts', () => {
    expect(player).toMatch(/updateMediaSession\(\)/)
    const fn = player.slice(player.indexOf('export async function playTrack'))
    expect(fn.slice(0, fn.indexOf('export function setArtwork'))).toMatch(/updateMediaSession\(\)/)
  })

  it('registers the transport actions', () => {
    for (const a of ['play', 'pause', 'previoustrack', 'nexttrack']) {
      expect(player).toMatch(new RegExp(`set\\('${a}'`))
    }
  })

  it('does NOT register stop', () => {
    // iOS shows a stop button in place of pause when 'stop' is handled, which
    // reads as "quit" and loses the queue.
    expect(player).not.toMatch(/set\('stop'/)
  })

  it('guards every mediaSession call', () => {
    // Support is uneven across WebViews and individual setActionHandler calls
    // throw for unimplemented actions — an unguarded one takes the player down.
    expect(player).toMatch(/'mediaSession' in navigator/)
    expect(player).toMatch(/try \{ navigator\.mediaSession\.setActionHandler/)
  })

  it('mirrors playbackState from the audio element, not from intent', () => {
    // Playback can start or stop from the lock screen, a headset or an autoplay
    // block; the widget must not claim otherwise.
    expect(player).toMatch(/audio\.addEventListener\('play', sync\)/)
    expect(player).toMatch(/audio\.addEventListener\('pause', sync\)/)
  })

  it('refuses to set a position with non-finite numbers', () => {
    // A still-loading or live stream reports NaN, and passing that throws.
    expect(player).toMatch(/isFinite\(audio\.duration\)/)
    expect(player).toMatch(/isFinite\(audio\.currentTime\)/)
  })

  it('is initialised once at startup and updated on timeupdate', () => {
    expect(main).toMatch(/initMediaSession\(\)/)
    expect(main).toMatch(/updateMediaSessionPosition\(\)/)
  })
})
