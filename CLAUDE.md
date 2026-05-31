# MadMusic — agent guide

Node/Express music-streaming app backed by FileMaker. Entry: `cluster.js` → `server.js`.
Routes in `routes/`, shared libs in `lib/`, frontend in `public/`.

Run tests before and after changes:
- `npm test` — backend + frontend unit/integration (vitest)
- `npm run test:visual` — Playwright (boots a dummy-cred server; no prod FileMaker)

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
