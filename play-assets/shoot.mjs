/**
 * play-assets/shoot.mjs — Play Store phone screenshots from the live mobile app.
 *
 * The app is a Capacitor wrapper around musicafricadirect.com/mobile, so the
 * live site IS the app: shooting it is shooting the product, not a mock-up.
 *
 * Emulated at Pixel 5 with its real 2.75x pixel ratio, which yields ~1080x2000
 * — Play wants 320-3840px, 9:16, and a browser-pane screenshot (331px wide)
 * would have to be upscaled into mush.
 */
import { chromium, devices } from 'playwright'

const pixel = devices['Pixel 5']
// Shot list. Library and Search are EMPTY for a new user ("No playlists yet"),
// which is the worst thing a store listing can show — so the deep screens are
// content pages reached by tapping, not the bare tabs.
const browser0 = null
const browser = await chromium.launch()
const ctx = await browser.newContext({ ...pixel, isMobile: true, hasTouch: true })
const page = await ctx.newPage()

// 'networkidle' never settles here — the app keeps connections open (audio,
// analytics), so wait for the DOM and then for real content to appear.
await page.goto('https://musicafricadirect.com/mobile', { waitUntil: 'domcontentloaded', timeout: 90000 })
await page.waitForTimeout(6000)

// Cookie banner: choose the essential-only option, and do it ONCE — the choice
// persists for the rest of the context, so later shots are already clean.
const essential = page.getByRole('button', { name: /essential only/i })
if (await essential.count()) { await essential.first().click(); await page.waitForTimeout(800) }

// Guest-mode nudges never appear for a signed-in app user, and naming an
// outside purchase route is what Play's anti-steering policy forbids.
const hideGuest = () => page.addStyleTag({ content: '#guest-pill,#guest-paywall{display:none !important}' })

async function shoot(name) {
  await hideGuest()
  await page.waitForTimeout(500)
  const out = `play-assets/screens/${name}.png`
  await page.screenshot({ path: out })
  console.log('  wrote', out)
}

// The bottom bar — its buttons carry .tab-button inside #bottom-tabs. Matching
// on text alone hits hidden duplicates (a #browse-back button and an offscreen
// section header both read "Browse") and Playwright waits forever on them.
async function tapTab(text, waitMs = 3000) {
  // bottom-tabs is a CLASS, and each button holds an icon plus its label, so
  // an anchored full-string match never fits — filter on the label as substring.
  await page.locator('.bottom-tabs .tab-button', { hasText: text }).first().click({ timeout: 10000 })
  await page.waitForTimeout(waitMs)
}

// Anything else on screen: restrict to what is actually visible.
async function tap(text, waitMs = 3000) {
  const el = page.getByText(new RegExp('^\\s*' + text + '\\s*$', 'i')).locator('visible=true').first()
  await el.scrollIntoViewIfNeeded({ timeout: 8000 })
  await el.click({ timeout: 8000 })
  await page.waitForTimeout(waitMs)
}

await hideGuest()
await shoot('01-home')

await tapTab('Browse')
await shoot('02-browse')

// A collection page — the archive is the product, so show it full of covers.
try { await tap('Gallo 100', 4000); await shoot('03-gallo100') }
catch (e) { console.log('  (Gallo 100 unavailable:', e.message.split('\n')[0], ')') }

// Back to Browse, then Themes — the other way into the catalogue.
try { await tapTab('Browse'); await tap('Themes', 4000); await shoot('04-themes') }
catch (e) { console.log('  (Themes unavailable:', e.message.split('\n')[0], ')') }

await browser.close()
