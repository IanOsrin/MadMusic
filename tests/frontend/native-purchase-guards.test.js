/**
 * Google Play forbids buying digital goods inside an Android app through
 * anything but Play Billing. The app loads the LIVE mobile site, so every
 * purchase surface has to be withheld by the page itself when it detects the
 * Capacitor shell — there is no separate native build to strip.
 *
 * Three surfaces, each found the hard way: the Buy Access buttons (handled
 * 2026-08-13); the ringtone editor, which sells a ringtone for R1.50 via
 * Paystack and was MISSED by that pass, shipping reachable in the Android build
 * until 2026-09-02; and the "Access Token Required" gate in main.js, whose Buy
 * Access button carries NO id and so slipped past the id-based stylesheet rule
 * entirely — spotted 2026-09-03 in the first iOS simulator run, where the gate
 * renders because GUEST_PREVIEW is off locally. Production never showed it,
 * which is exactly why a stylesheet of ids is not enough on its own.
 *
 * Hence the last test: every Buy Access surface in the mobile modules must be
 * guarded at the point it is BUILT, not merely hidden after the fact.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const mobile = readFileSync(join(process.cwd(), 'public/mobile.html'), 'utf8')
const moduleDir = join(process.cwd(), 'public/js/mobile')

describe('native app purchase guards', () => {
  it('stamps html.native-app when running inside Capacitor', () => {
    expect(mobile).toMatch(/Capacitor\.isNativePlatform\(\)/)
    expect(mobile).toMatch(/classList\.add\(['"]native-app['"]\)/)
  })

  for (const id of ['buy-access-btn', 'guest-paywall-buy', 'mobileRingtoneBtn']) {
    it(`hides #${id} in the native shell`, () => {
      // The rule must carry !important: updateRingtoneBtn sets an INLINE
      // display, which a plain stylesheet declaration would lose to.
      const rule = new RegExp(`html\\.native-app[^{]*#${id}[^{]*\\{[^}]*display:\\s*none\\s*!important`, 's')
      const grouped = new RegExp(`#${id}[^{]*\\{[^}]*display:\\s*none\\s*!important`, 's')
      expect(rule.test(mobile) || grouped.test(mobile)).toBe(true)
    })
  }

  it('does not even build the ringtone href in the native shell', () => {
    const fn = mobile.slice(mobile.indexOf('function updateRingtoneBtn'))
      .slice(0, mobile.slice(mobile.indexOf('function updateRingtoneBtn')).indexOf('\n    }'))
    expect(fn).toMatch(/native-app/)
    // the guard must precede the href assignment, or it does nothing
    expect(fn.indexOf('native-app')).toBeLessThan(fn.indexOf('btn.href ='))
  })

  it('never renders a Buy Access button unguarded in the mobile modules', () => {
    const offenders = []
    for (const file of readdirSync(moduleDir).filter(f => f.endsWith('.js'))) {
      readFileSync(join(moduleDir, file), 'utf8').split('\n').forEach((line, i) => {
        // Only markup that builds a button — not the buyAccess() function itself,
        // its import, or the click wiring.
        if (!/<button[^>]*>\s*Buy Access/.test(line)) return
        if (!line.includes('isNativeApp()')) offenders.push(`${file}:${i + 1}`)
      })
    }
    expect(offenders).toEqual([])
  })
})
