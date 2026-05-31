# mobile.js split plan

Follow-up to the Phase-0 externalization (inline `<script>` → `public/js/mobile.js`,
2,143 lines). Goal: break the monolith into focused modules **without changing behavior**.

## The governing constraint

After the fetch-interceptor IIFE, the whole file is **one shared lexical scope**.
`state` (115 refs), `elements` (82 refs), `GENRES`, `DECADES`, `searchTimeout`, the drag
vars — all top-level `const`/`let` closed over by ~70 functions. Separate **classic**
`<script>` files do NOT share that scope, so the split's central decision is *how shared
state crosses file boundaries*.

**Decision: native ES modules** (`<script type="module">`), no bundler. Shared state lives
in `state.js` and is `import`ed (live object bindings — mutations are seen everywhere).
Rejected alternative: a `window.MM = {state, elements, …}` namespace with ~200 call-site
rewrites — higher churn, uglier, easier to typo into a silent break.

### What ESM changes (and the mitigations)

| Risk | Why | Mitigation |
|---|---|---|
| **Load order** — `type=module` is deferred; runs after the classic inline scripts in mobile.html parse | Fetch interceptor "must run FIRST", before the ringtone inline script's `fetch` | Keep `fetch-interceptor.js` a **classic** `<script src>` placed before everything; only the app graph is ESM |
| **No implicit globals** — modules don't leak `function foo(){}` onto `window` | Markup uses `onclick="loadG100()"` etc. (11 names) | `main.js` explicitly does `window.loadG100 = loadG100` for each; add a static test asserting every `on*="name("` in markup+templates is assigned in main.js |
| **`elements` built at eval time** via `getElementById` | Needs DOM present | Already fine: module is deferred, so DOM is parsed first (today it loads at end of body anyway) |

## Module map

Proposed dir `public/js/mobile/` (keeps `playlists.js` from clashing with the desktop
`public/js/playlists.js`). Line counts approximate, from the current inventory.

| Module | Functions / contents | ~lines |
|---|---|---|
| `fetch-interceptor.js` *(classic, loads first)* | the access-token fetch patch (current lines 1–30) | 30 |
| `data.js` | `GENRES`, `DECADES` (pure data) | 225 |
| `state.js` | `state`, `elements` objects | 80 |
| `util.js` | `showToast`, `formatTime`, `generateSessionId` | 25 |
| `fields.js` | `getFieldValue/getTitleField/getArtistField/getAlbumArtist/getAlbumField/getGenreField/getYearField/getArtworkUrl/getAudioUrl/hasValidAudio/hasValidArtwork`, `groupTracksByAlbum` | 120 |
| `auth.js` | `checkAuth, logout, updateAuthUI, setAccessToken, buyAccess` | 150 |
| `nav.js` | `switchTab, renderGenres, selectGenre, renderDecades, selectDecade, clear{Genre,Decade,All}Filter` | 135 |
| `cards.js` | `createAlbumCard, showAlbumTracksModal, createDiscoverTrackCard, showMobileArtistPrompt, createTrackCard` | 215 |
| `rails.js` *(optionally 3: newreleases/g100/discover)* | `loadNewReleases, renderNewReleases, loadG100, filterG100Albums, renderG100Albums, loadG100Playlists, renderG100Playlists, showG100PlaylistTracks, refreshDiscover, loadDiscover, renderDiscoverTracks, prefetchDiscoverAlbums, updateDiscoverBadgeCounts` | 560 |
| `search.js` | `search, renderSearchResults` | 48 |
| `playlists.js` | `loadPlaylists, renderPlaylists, showPlaylistTracks, playPlaylistTrack, createPlaylist, showAddToPlaylistModal, addTrackToPlaylist` | 210 |
| `player.js` | `closeModal, playTrack, setArtwork, updateFloatingPlayer, updatePlayerModal, updateProgress, sendStreamEvent` — the playback engine + now-playing modal | 305 |
| `main.js` *(entry)* | `init()`, the standalone DOM wiring, the bottom-of-file decade-in-discover/search listeners, and the `window.*` handler exposures | 120 |

Dependency direction (no problematic cycles; functions reference each other at call time,
which ESM handles): `data/state/util/fields` are leaves → `auth/nav/search` →
`cards` → `rails/playlists` → `player` ↔ `cards` (playTrack ⇄ card builders) → `main`.

## Phased sequence (each step behavior-preserving, ship one commit each)

The module-mode switch is the only scary part, so isolate it from the carving.

- **Phase 1 — go module-mode, no split yet.**
  Extract `fetch-interceptor.js` (classic, first). Flip mobile.html's tag to
  `<script type="module" src="/js/mobile/main.js">`; rename mobile.js → `mobile/main.js`
  unchanged except: append the `window.<handler> = <handler>` block for the 11 markup
  names. This isolates the timing + global-exposure risk with otherwise-identical code.
  *Verify: net + manually play a track, next/prev, tab-switch, every markup button.*

- **Phase 2 — carve leaves.** `data.js`, `util.js`, `state.js`, `fields.js`. Each: move
  the code, add `export`, add `import` in consumers. Lowest risk (no behavior, pure moves).

- **Phase 3 — carve features**, one per commit, leaf-ward to root:
  `auth → nav → search → playlists → cards → rails → player`. After each, `main.js` shrinks
  to wiring. Re-run net + manual playback every time (the net can't see playback).

- **Phase 4 — optional** split `rails.js` into three rail files if it still feels heavy.

## Verification per phase (net has a known blind spot for mobile playback)

1. `npx vitest run tests/frontend` + `npx playwright test` (incl. `mobile-next-prev`).
2. Add a static guard to `tests/frontend/mobile-invariants.test.js`: every `on*="NAME("`
   in mobile.html markup **and** in mobile/*.js template strings must have a matching
   `window.NAME =` in `main.js`. (Catches the silent dead-button failure mode.)
3. Register each new `mobile/*.js` in `extract-contract.js` `JS_MODULES` so its globals
   and element refs stay under the structural contract; regenerate baseline per change.
4. **Manual:** load `/mobile`, play a track, work next/prev, switch all tabs, run a
   ringtone, open a saved playlist (invariant #2: re-resolves by recordId).
