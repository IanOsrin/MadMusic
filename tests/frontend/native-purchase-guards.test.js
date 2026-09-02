/**
 * Google Play forbids buying digital goods inside an Android app through
 * anything but Play Billing. The app loads the LIVE mobile site, so every
 * purchase surface has to be withheld by the page itself when it detects the
 * Capacitor shell — there is no separate native build to strip.
 *
 * Two surfaces, found the hard way: the Buy Access buttons (handled 2026-08-13)
 * and the ringtone editor, which sells a ringtone for R1.50 via Paystack and
 * was MISSED by that pass — it shipped reachable in the Android build until
 * 2026-09-02. These assertions exist so a third one cannot appear unnoticed.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const mobile = readFileSync(join(process.cwd(), 'public/mobile.html'), 'utf8')

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
})
