# MadMusic — agent guide

Node/Express music-streaming app backed by FileMaker. Entry: `cluster.js` → `server.js`.
Routes in `routes/`, shared libs in `lib/`, frontend in `public/`.

Run tests before and after changes:
- `npm test` — backend + frontend unit/integration (vitest)
- `npm run test:visual` — Playwright (boots a dummy-cred server; no prod FileMaker)

## Required reading before building

- **`docs/FM-MAP.md`** — FileMaker layout/field/write-path map. Consult before ANY change
  that touches FM data paths. Hard rule (10k-concurrent-user target): every new read path
  goes through `lib/swr-cache.js` (SWR + concurrent dedup) — never a direct FM call on the
  request path. Writes are never cached.
- **`docs/banners.md`** — banner/hero image discipline + the `/api/featured-editorial`
  data contract. Any new banner or hero surface must follow its rendering rules
  (container owns the shape; square art never stretched — ambient blur + contain).
- Project-level skills in `.claude/skills/`: `mad-streamer-audit-context` (May 2026 audit,
  46 findings) and `mad-fm-dedup-pattern` (the SWR/dedup principle).

## Recent integrations (2026-06-03) — current state

1. **Editorial hero carousel** — `routes/featured-editorial.js` (ported from v3.1, SWR 60s,
   mounted in server.js, public path). Reads FM layout `API_Hero_Featured`, which **does not
   exist in FM yet** → feature-flagged `EDITORIAL_HERO_ENABLED` (default off). Frontend
   (`#heroBanner` in app.html + hero CSS in app.css) falls back to `/api/new-releases`
   slides using the ambient-blur treatment. Editorial slide actions: `track` → playSong,
   `external` → window.open; `album`/`playlist` targets are Phase 2 (no open-by-recordId
   path exists — wire before enabling such slides).
2. **Search: ONE live engine (2026-06-10)** — desktop search is the **`doSearch` override
   in `app.html`** (≈line 2200, wrapping the original `doSearch` defined in `app.min.js`;
   results applied via `window.run()`). It reads the unified box + hidden category fields
   (`#searchArtist`/`#searchAlbum`/`#searchTrack`) in `#view-albums` and owns the
   artist-query → two-column artist view behaviour (`openAlbumDirect`). The OTHER engine —
   discovery.js's `performSearch`/`renderSearchEnv`/`cueTrack`/`detectArtistMatch`, its
   `#searchInput` bar, the `#view-highlights` section, and the `.search-env*`/`.se-*` CSS —
   was confirmed unreachable (no nav item or `showView('highlights')` existed) and was
   **removed**. Don't reintroduce search logic in discovery.js; change `doSearch` instead.
   `renderAlbums()` still exists and serves the default (non-search) random view.
3. **Spacing pass** — `.section` margin 2.5rem, `.nr-grid` 1rem gap + scroll-snap +
   hover-shadow padding. Aesthetic only; don't regress these when touching rails.
4. **Guest preview mode (2026-07-05)** — ships dark behind `GUEST_PREVIEW_ENABLED`
   (default off). When on, token-less visitors browse freely and every play becomes
   the SERVER-clipped ~30 s stream `GET /api/preview/:recordId` (public;
   `routes/preview.js` + byte-cap parser `lib/mp3-preview.js` — no ffmpeg on the web
   service). A dismissible subscribe popup fires every 5 min (desktop: paymentOverlay
   + × via `body.guest-mode`; mobile: injected `guest-paywall` sheet in
   `js/mobile/auth.js`). Enforcement chokepoints — do not bypass: desktop
   `_PLAYER.playTrack` (app.html) and mobile `playTrack` (js/mobile/player.js) rewrite
   ALL guest playback to `/api/preview/`; a play without a recordId is refused, and
   ringtone buttons are suppressed for guests. Guards:
   `tests/frontend/guest-preview-frontend.test.js`, guest section in
   `mobile-invariants.test.js`, `tests/integration/preview-{route,ringfence}.test.js`.
   Feature flags are now injected into `<head>` (loadHtml) because auth.js decides
   gate-vs-guest synchronously at boot.

The MadMusicV3.1 source tree (reference for further ports: charts/SQLite ingest, admin
metrics, service worker, search intelligence) lives outside this repo — ask the user for
the current copy. v2.1 and v3.1 have drifted in BOTH directions (v2.1's access.js/payments.js
are newer); never merge files wholesale — port deliberately.

## Telkom is ring-fenced (2026-06-10)

Waiting on deliverables from Telkom (webhook secret/signature scheme, IP ranges).
`TELKOM_ENABLED` (default **off**) 404s all `/api/telkom/*` before auth and keeps the
webhook paths out of the auth skip-list. `routes/telkom.js` is untouched but has known
open findings (listed next to the flag in server.js) that MUST be fixed before enabling.
Guard test: `tests/integration/telkom-ringfence.test.js`. Don't wire anything to Telkom
routes or remove the fence without the user's say-so.

## Frontend layout (no build step)

There is **no bundler**. HTML files are served as-is and contain inline `<script>` blocks.
`public/app.min.js` is hand-maintained (not minified, not generated). Shared field/format
helpers live in `public/js/helpers.js` as `window.MADHelpers`.

- **Desktop** (`/`, `/albums`, `/jukebox`, …) → `public/app.html`, which loads
  `js/helpers.js`, `js/player.js`, `js/discovery.js`, etc. **player.js owns playback**
  (`window.playSong`/`stopPlayback`, the single `<audio id="player">` via `_PLAYER`).
  `discovery.js` only renders rails and delegates playback to player.js.
- **`public/audio-lab.html` is LOCKED** — a pre-commit hook blocks commits touching it.
  Do not modify without the user explicitly unlocking it.

## Mobile (`/mobile` → `public/mobile.html`) — read before editing

`mobile.html` is a ~2,600-line file with inline global functions across several `<script>`
blocks (not modules; load order matters). It is a **standalone app**:

- It loads **none** of `app.min.js`/`player.js`/`discovery.js`. It has its **own** playback
  engine and its **own** `<audio id="audio">` (NOT `#player`). Do not assume desktop code runs here.
- It loads `js/helpers.js`; its field/format utilities are **thin delegations** to
  `window.MADHelpers` (`getFieldValue`, `getTitleField`, `getAlbumField`, `getGenreField`,
  `getArtistField`, `getAlbumArtist`, `hasValidAudio`). **Do not re-grow local copies** — that
  reintroduces divergence (a 5-field `hasValidAudio` copy once hid playable tracks).
  Mobile keeps `getArtworkUrl`/`getAudioUrl`/`getYearField`/`hasValidArtwork` local on purpose.

### Invariants (these have each caused a real bug — don't trip them)

1. **Album grouping keys must use `getAlbumArtist` (album-first), never `getArtistField`
   (track-first).** `getArtistField` prefers the *track* artist, so using it in a
   `album|||artist` grouping key splits a compilation (many track artists, one album) into
   one card per artist. Grouping/album-card → `getAlbumArtist`; track/now-playing display → `getArtistField`.

2. **Never store or trust absolute FileMaker streaming URLs** (`…?RCType=RCFileProcessor`).
   They are session-scoped and expire → 401 (raw *and* through the proxy). Saved playlist
   tracks did this and went blank/silent. **Re-resolve by `recordId`** at play time via
   `GET /api/track/:recordId/container` (returns fresh `url` + `artworkUrl`). The stable key
   is `recordId`; stored URLs are fallback only.

3. **`/api/container?u=…` needs `proxy=1` to STREAM bytes.** Without it the server
   302-redirects to the target (usually S3); a redirect to a CORS-less or auth-required host
   fails for `fetch()`/decode. `<img>`/`<audio>` can follow the redirect, but `fetch` (e.g. the
   ringtone editor) must use `proxy=1`.

4. **`state.playlistContext` is the now-playing queue** for the modal's prev/next buttons
   (`#prev-btn`/`#next-btn`). When you start playback from a list/feed, set it to the **whole
   list** with the right index — not a single track — or next/prev no-op.

### Test-net blind spot

Playwright screenshots and the structural tests do **not** exercise mobile *playback logic or
data flow*. The recent mobile bugs (grouping, ringtone, next/prev, stale URLs) all passed the
green net. **Verify mobile behavior changes by actually playing/clicking**, and add a static
guard in `tests/frontend/mobile-invariants.test.js` where you can.

## Native apps — `android/` and `ios/` (Capacitor)

Both are **live-URL wrappers**: `capacitor.config.json` points the web view at
`https://musicafricadirect.com/mobile`, so the apps update with every site deploy and only
native-shell changes need a store release. Two consequences that bite:

1. **A local site change is invisible to the app.** To test one, start the site locally, then
   temporarily set `server.url` to `http://localhost:3000/mobile` with `cleartext: true`, add
   `NSAppTransportSecurity:NSAllowsArbitraryLoads` to `ios/App/App/Info.plist` (iOS only),
   `npx cap sync ios`, rebuild — **and revert both afterwards**.
2. **Store policy is enforced by the PAGE, not by a native build.** Neither store permits
   buying digital goods outside its own billing, so every purchase surface must withhold
   itself when it detects the shell. `mobile.html` stamps `html.native-app` and hides three
   buttons by id; anything built in JS must ALSO check `isNativeApp()` at the point it is
   rendered — an id-based stylesheet cannot reach markup that carries no id, which is how the
   `main.js` token gate stayed reachable through two Play reviews.
   `tests/frontend/native-purchase-guards.test.js` is the guard. A free trial is not a
   purchase and stays.

Simulator build (no signing needed):

```
cd ios/App && xcodebuild -project App.xcodeproj -scheme App -sdk iphonesimulator \
  -configuration Debug -destination 'platform=iOS Simulator,name=iPhone 17' \
  -derivedDataPath <dir> CODE_SIGNING_ALLOWED=NO build
```

**Signing material is never in this repo** — it is public. The Android upload keystore lives
in `~/Documents/mad-android-signing/`; `android/.gitignore` blocks `keystore.properties`,
`*.keystore` and `*.jks`. Lose that folder and the app can never be updated again.

iOS specifics worth knowing: background audio needs BOTH `UIBackgroundModes: audio` and the
`AVAudioSession.setCategory(.playback)` call in `AppDelegate` — the plist key alone does not
survive a screen lock. Safe-area insets only report real values because `mobile.html` sets
`viewport-fit=cover`; `--header-height`/`--tab-bar-height` in `mobile.css` stay the bare
chrome heights and the insets are added on top, because several rules already add
`env(safe-area-inset-bottom)` themselves and folding it in would double-count.
