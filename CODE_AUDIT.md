# MadMusic (MASS) — Code Audit Report
**Date:** 2026-03-13
**Scope:** All server-side source files (no changes made — analysis only)
**Files reviewed:** server.js, store.js, helpers.js, cache.js, fm-client.js, cluster.js, routes/access.js, routes/admin.js, routes/catalog.js, routes/library.js, routes/payments.js, routes/playlists.js, routes/stream.js, scripts/generate-access-token.js, scripts/smoke.js, scripts/remove-emails-from-playlists.js

---

## 1. DUPLICATE CODE

These are cases where identical or near-identical logic appears in more than one file. Each is a candidate for consolidation.

### D1 — `generateTokenCode` duplicated in `store.js` and `scripts/generate-access-token.js`
Both files contain byte-for-byte the same function. If the token format ever changes, the script will silently diverge from the runtime.
- `store.js` lines 269–278
- `scripts/generate-access-token.js` lines 82–94

### D2 — `loadTokens` / `saveTokens` duplicated in `scripts/generate-access-token.js`
The script implements its own minimal versions of `loadAccessTokens` and `saveAccessTokens` from `store.js`. They do not use the atomic temp-file rename that `store.js` uses, so the script can corrupt `access-tokens.json` on a crash mid-write.
- `scripts/generate-access-token.js` lines 96–113

### D3 — `FM_LAYOUT` constant defined in five separate files
Every file that touches FileMaker re-declares `const FM_LAYOUT = process.env.FM_LAYOUT || 'API_Album_Songs'` independently. If the default value needs changing it must be updated in five places.
- `helpers.js` line 15
- `catalog.js` line 15
- `playlists.js` line 14
- `stream.js` line 9
- `access.js` line 16

### D4 — `FM_STREAM_EVENTS_LAYOUT` declared in three files
Same pattern as D3.
- `helpers.js` line 16
- `catalog.js` line 16
- `access.js` line 16

### D5 — `FM_FEATURED_FIELD` / `FM_FEATURED_VALUE` and derived constants declared in two files
- `helpers.js` lines 17–19 (source of truth, these are also exported)
- `catalog.js` lines 21–32 (re-declares and re-derives `FEATURED_FIELD_BASE` and `FEATURED_FIELD_CANDIDATES`, identical logic to helpers.js lines 78–86)

### D6 — `PAYSTACK_PLANS` object defined in two files (identical)
Any pricing change must be applied in both places or they will diverge silently.
- `helpers.js` lines 55–59
- `payments.js` lines 9–13

### D7 — `parsePositiveInt` and `parseNonNegativeInt` duplicated
`fm-client.js` itself notes this: "Local helpers (same logic as server.js versions)".
- `helpers.js` lines 162–176 (exported)
- `fm-client.js` lines 11–21 (private, not exported)

### D8 — Nodemailer transporter created twice
A singleton `emailTransporter` is created at module load in `helpers.js` (lines 43–50) and `sendTokenEmail` uses it. But `playlists.js` (lines 344–354) creates a *brand-new* transporter inside the route handler on every single share-email request, duplicating the configuration and bypassing the singleton.

### D9 — `normalizeEmail` defined as local helper in `store.js` AND exported from `helpers.js`
`store.js` line 18 has its own private copy. It should import the one from `helpers.js`.

### D10 — `normalizeShareId` defined as local helper in `store.js` AND exported from `helpers.js`
Same situation as D9. `store.js` line 19.

### D11 — `SERVER_START_TIME` defined in both `server.js` and `admin.js`
`admin.js` line 6 creates its own `const SERVER_START_TIME = Date.now()`. This records the time the router module was first loaded, which is *later* than the actual server start. The health endpoint's uptime will always be slightly under-reported.
- `server.js` line 33
- `admin.js` line 6

### D12 — `fmBase` URL computed in both `fm-client.js` and `stream.js`
`stream.js` constructs its own `fmBase` string (line 12) from raw env vars instead of importing the one already computed in `fm-client.js` (line 128). If FM_HOST or FM_DB change format this has to be maintained in two places.

### D13 — Dynamic re-imports of already-static-imported modules in `server.js`
The `/api/shared-playlists/:shareId` handler (lines 279–280) dynamically `import()`s `helpers.js` and `store.js` even though both are already statically imported at the top of the file (lines 22–25). Node.js module cache means they still resolve correctly, but it's unnecessary noise and slightly misleading.

---

## 2. WEAKNESSES / BUGS

### W1 — `deduplicatedFetch` in `helpers.js` does not actually deduplicate (BUG)
`helpers.js` lines 178–190: `pendingRequests` is declared as `const pendingRequests = new Map()` **inside the function body**. A new, empty Map is created on every call, so the `pendingRequests.has(cacheKey)` check can never be true. The deduplication logic is completely inert. The function only works as a cache-read wrapper.

### W2 — `library.html` route references a file that does not exist
`server.js` line 315: `res.sendFile(path.join(PUBLIC_DIR, 'library.html'))`. The file listing confirms there is no `public/library.html`. On Linux (case-sensitive filesystem) this will throw a 404/ENOENT for every visit to `/library`.

### W3 — `paymentLimiter` and `expensiveLimiter` defined but never applied
`server.js` defines both rate-limiters (lines 136–146) but neither is ever passed to `app.use()` or a specific route. They are completely dead code. The payment endpoints and expensive search/explore endpoints have no stricter rate limit than the general 100 req/15min API limiter.

### W4 — Playlist image path has wrong case on Linux
`helpers.js` line 33: `path.join(PUBLIC_DIR, 'img', 'Playlists')` (capital P).
The actual directory on disk is `public/img/playlists/` (lowercase p). On macOS (case-insensitive) this works by accident. On Linux (production) every `resolvePlaylistImage()` call will fail to find any image, silently falling back to null.

### W5 — SSRF blocklist in `stream.js` is incomplete
The private IP check (lines 130–142) is a manual list of regex patterns. It does not cover:
- AWS metadata endpoint (169.254.169.254) — while this matches `169.254` it only checks `hostname.match(/^169\.254\./)` which is correct, but it doesn't check IPv6-mapped IPv4 addresses like `::ffff:169.254.169.254`.
- Cloud provider metadata endpoints via CNAME/DNS rebinding.
- Other RFC-1918 addresses not matching the patterns (e.g. `0.0.0.0`, `::1` other than the listed one).
A library like `is-in-subnet` or `ipaddr.js` would be more robust.

### W6 — HTML injection in playlist share email
`playlists.js` lines 355–404: The HTML email template interpolates `${senderLabel}`, `${playlistName}`, `${shareUrl}`, and `${trackCount}` directly without HTML-escaping. `senderLabel` comes from `recipientName` in the request body (user-supplied) or the sender's email. A malicious `recipientName` value containing `<script>` or other HTML could inject content into the email. `escapeHtml()` is already exported from `helpers.js` but is not used here.

### W7 — Concurrent write race conditions on JSON data files (multi-worker)
`cluster.js` can run up to 4 workers. Each worker uses the same file paths for `playlists.json`, `library.json`, and `access-tokens.json`. The atomic rename (`tmp` → file) guards against corruption within a single write, but two workers can both read the same stale file, both modify their in-memory copy, and both write — the second write silently overwrites the first. Playlist additions and library updates are susceptible to this.

### W8 — `parseInt` without radix in `payments.js`
Lines 119 and 173: `parseInt(metadata.days)`. Should be `parseInt(metadata.days, 10)`. Without the radix, strings like `"030"` could theoretically be misinterpreted (though Node.js typically defaults to base 10 for non-0x strings, it is still a lint warning and bad practice).

### W9 — No security headers (CSP, X-Frame-Options, X-Content-Type-Options)
The server sets `Strict-Transport-Security` in production (server.js line 80) but does not set:
- `Content-Security-Policy`
- `X-Frame-Options`
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy`
- `Permissions-Policy`
These are standard hardening headers for any web application.

### W10 — ~~`/api/cache/stats` is unprotected~~ *(finding corrected after testing)*
`/api/cache/stats` sits under `/api/` and is NOT in the global token middleware's `skipPaths` list in `server.js`, so it already requires a valid access token. Live testing confirmed it correctly returns 403 without a token. No action needed.

### W11 — Verbose token validation logging leaks timing/session data
`helpers.js` lines 778–784 log the raw FM expiration date, UTC-adjusted time, and "time until expiry in hours" on every token validation. In a busy production environment this floods logs with sensitive data and can expose token lifetime information.

### W12 — `sendTokenEmail` is fire-and-forget; failures are silently swallowed
`payments.js` lines 124 and 179 call `sendTokenEmail(email, token.code, days)` without `await`. The function itself uses `.then().catch()` (helpers.js line 660). If email delivery fails, the user receives no notification of their purchased token. There is no retry, no admin alert, and no fallback delivery mechanism.

### W13 — Session timeout (15 min) does not align with token validation cache TTL (5 min)
`helpers.js` line 809: `sessionTimeoutMs = 15 * 60 * 1000`.
`server.js` line 172: `TOKEN_CACHE_TTL_MS = 5 * 60 * 1000`.
A cached token entry expires from the LRU cache at 5 minutes, triggering a fresh FM lookup. During that fresh lookup the session check re-reads `Current_Session_ID` from FM. This is correct behaviour, but the comment says the 25h LRU TTL in `cache.js` for `tokenValidationCache` covers the grace window — the 5-min freshness TTL lives inside the stored `expiresAt` field, not the LRU TTL. The interaction is subtle and the constants are spread across three files with no cross-reference.

### W14 — `fmBase` in `stream.js` is undefined when `FM_HOST` is not set
`stream.js` line 12: ``const fmBase = FM_HOST ? `${FM_HOST}/fmi/...` : ''``. If `FM_HOST` is falsy, `fmBase` is `''`. However on line 116, `requiresAuth = upstreamUrl.startsWith(FM_HOST)` — if `FM_HOST` is undefined, `String.prototype.startsWith(undefined)` throws a TypeError. This path is only reachable when `direct` is set without `rid+field`, but it is a latent runtime error.

### W15 — `fmGetAbsolute` in `fm-client.js` routes non-FM URLs through the FM request queue
`fm-client.js` line 296: when the URL does not start with `FM_HOST`, `fmSafeFetch` is still called, which `enqueueFmRequest`. This means Paystack API calls (which go through `safeFetch` in helpers.js but *not* through `fmSafeFetch`) bypass the queue, but any other non-FM URL passed to `fmGetAbsolute` would be rate-limited by the FM queue. This is likely unintentional for non-FM URLs.

---

## 3. REDUNDANCIES

### R1 — `morgan` package installed but never imported or used
`package.json` lists `"morgan": "^1.10.1"` as a dependency. There is no `import morgan` anywhere in the codebase. Morgan is a request-logging middleware; the project instead hand-rolls a logging middleware in `server.js` (lines 108–118) that duplicates what Morgan provides out of the box.

### R2 — `start` and `start:cluster` npm scripts are identical
`package.json`:
```
"start": "node cluster.js",
"start:cluster": "node cluster.js"
```
Both run the same command. One of them should be removed or differentiated.

### R3 — `cluster.js` computes `__filename` / `__dirname` but never uses `__dirname`
Lines 6–7 set up the ESM `__filename`/`__dirname` boilerplate but `cluster.js` never references `__dirname`. The two lines are unused.

### R4 — `app.min.js` and individual `public/js/*.js` files both exist
There is both a `public/app.min.js` (a bundle) and individual source files `public/js/auth.js`, `catalog.js`, `discovery.js`, `genre-filters.js`, `helpers.js`, `player.js`, `playlists.js`. It is not clear from `app.html` which set is actually served in production, or whether both are loaded. If `app.min.js` supersedes the individual files, the sources are dead weight (though useful for development).

### R5 — `escapeHtml` exported from `helpers.js` but not used server-side
`helpers.js` lines 1103–1113 define and export `escapeHtml`. A search of all routes confirms it is never called. It should either be used (e.g. in W6 above) or removed.

### R6 — `toCleanString` is a thin wrapper with limited value
`helpers.js` lines 1097–1101: `toCleanString(value)` returns `value` if it's a string, empty string if null/undefined, or `String(value)` otherwise. This is a two-liner that is used in only one place (`access.js`) and could be inlined.

### R7 — `resolvePlayableSrc` and `resolveArtworkSrc` share near-identical guard logic
Both functions (helpers.js lines 262–295) begin with identical "reject FileMaker container metadata format" checks (the `movie:`, `size:`, `moviemac:`, `moviewin:` test). This guard block could be extracted into a single shared helper.

### R8 — `firstNonEmpty` and `firstNonEmptyFast` both exist for the same purpose
`helpers.js` exports both `firstNonEmpty` (lines 354–363, simple loop) and `firstNonEmptyFast` (lines 387–401, uses a WeakMap field-map cache). The fast version supersedes the simple version, but both are still exported and `firstNonEmpty` is still used in some places. This creates inconsistency: some call sites get cached lookups, others don't.

### R9 — `normalizeRecordId` in `helpers.js` is a trim-only function used rarely
`helpers.js` lines 481–485: `normalizeRecordId` just trims the value to a string. It is essentially `String(value ?? '').trim()` and adds minimal value as a named function.

### R10 — Multiple identical `res.setHeader('Cache-Control', 'no-store')` calls in `library.js`
Every route handler in `library.js` (lines 9, 23, 54, 72, 101) sets the same `Cache-Control: no-store` header. This could be set once with a router-level middleware instead.

### R11 — `playlists.js` route handlers repeat `res.setHeader('Cache-Control', 'no-store')` on every handler
Same pattern as R10. Many of the playlist routes set the same no-store header individually.

---

## 4. ARCHITECTURAL OBSERVATIONS (not bugs, but worth noting)

### A1 — `helpers.js` is a God Module (1,184 lines, ~50 exports)
It mixes: FileMaker token validation, stream event logic, playlist business logic, email sending, Paystack payment helpers, cookie parsing, HTML escaping, timestamp formatting, and URL resolution. This makes it hard to unit-test any single concern and creates circular-import risk (helpers imports from fm-client, store, and cache — meaning any of those cannot import from helpers without creating a cycle).

### A2 — File-based JSON storage is not suitable for multi-worker deployment
As noted in W7, the JSON file storage (playlists, library, tokens) was designed for a single-process server but `cluster.js` runs multiple workers sharing the same files. For production resilience, a proper database or at minimum a Redis-backed store would remove the race-condition risk entirely.

### A3 — Token validation logging verbosity vs. production suitability
The `validateAccessToken` function logs ~8 debug lines on every token check. In a multi-worker production environment with many users, this will produce enormous log volumes. The logging should be gated behind `process.env.NODE_ENV !== 'production'` or a dedicated debug flag.

### A4 — No automated tests
`package.json` `test` script is `echo "Error: no test specified" && exit 1`. The smoke test (`scripts/smoke.js`) only checks `/api/health` and one search call. There are no unit tests for helpers, validators, token logic, or any route handler.

---

## SUMMARY TABLE

| ID  | Category     | Severity | File(s)                                          | Description                                              |
|-----|--------------|----------|--------------------------------------------------|----------------------------------------------------------|
| D1  | Duplicate    | Medium   | store.js, generate-access-token.js               | generateTokenCode duplicated                             |
| D2  | Duplicate    | Medium   | generate-access-token.js                         | loadTokens/saveTokens duplicate store.js without atomic write |
| D3  | Duplicate    | Low      | helpers, catalog, playlists, stream, access      | FM_LAYOUT re-declared in 5 files                         |
| D4  | Duplicate    | Low      | helpers, catalog, access                         | FM_STREAM_EVENTS_LAYOUT re-declared                      |
| D5  | Duplicate    | Low      | helpers.js, catalog.js                           | FM_FEATURED constants re-derived                         |
| D6  | Duplicate    | Medium   | helpers.js, payments.js                          | PAYSTACK_PLANS object duplicated                         |
| D7  | Duplicate    | Low      | helpers.js, fm-client.js                         | parsePositiveInt / parseNonNegativeInt duplicated        |
| D8  | Duplicate    | Medium   | helpers.js, playlists.js                         | Nodemailer transporter created twice                     |
| D9  | Duplicate    | Low      | store.js, helpers.js                             | normalizeEmail local copy in store.js                    |
| D10 | Duplicate    | Low      | store.js, helpers.js                             | normalizeShareId local copy in store.js                  |
| D11 | Duplicate    | Low      | server.js, admin.js                              | SERVER_START_TIME duplicated (admin time is wrong)       |
| D12 | Duplicate    | Low      | fm-client.js, stream.js                          | fmBase URL re-computed                                   |
| D13 | Redundancy   | Low      | server.js                                        | Dynamic re-import of already-static-imported modules     |
| W1  | Bug          | High     | helpers.js                                       | deduplicatedFetch pendingRequests map is always empty    |
| W2  | Bug          | High     | server.js                                        | /library route serves non-existent library.html          |
| W3  | Bug          | High     | server.js                                        | paymentLimiter and expensiveLimiter never applied        |
| W4  | Bug          | High     | helpers.js                                       | Playlist image path wrong case on Linux (Playlists vs playlists) |
| W5  | Security     | Medium   | routes/stream.js                                 | SSRF blocklist incomplete for edge-case IPs              |
| W6  | Security     | Medium   | routes/playlists.js                              | HTML injection in share email (unescaped user input)     |
| W7  | Bug          | High     | store.js + cluster.js                            | Multi-worker race condition on JSON file writes          |
| W8  | Quality      | Low      | routes/payments.js                               | parseInt without radix                                   |
| W9  | Security     | Medium   | server.js                                        | Missing CSP, X-Frame-Options, X-Content-Type-Options headers |
| W10 | Security     | Low      | routes/admin.js                                  | /api/cache/stats unprotected                             |
| W11 | Quality      | Low      | helpers.js                                       | Excessive token validation logging in production         |
| W12 | Bug          | Medium   | routes/payments.js + helpers.js                  | sendTokenEmail fire-and-forget; failures silently lost   |
| W13 | Quality      | Low      | server.js + helpers.js + cache.js                | Session timeout / cache TTL mismatch across 3 files      |
| W14 | Bug          | Medium   | routes/stream.js                                 | FM_HOST undefined causes TypeError in startsWith        |
| W15 | Quality      | Low      | fm-client.js                                     | Non-FM URLs unnecessarily routed through FM request queue |
| R1  | Redundancy   | Low      | package.json                                     | morgan dependency installed but never used               |
| R2  | Redundancy   | Low      | package.json                                     | start and start:cluster scripts are identical            |
| R3  | Redundancy   | Low      | cluster.js                                       | __dirname boilerplate set up but never used              |
| R4  | Redundancy   | Low      | public/                                          | app.min.js and individual JS files may both be loaded    |
| R5  | Redundancy   | Low      | helpers.js                                       | escapeHtml exported but never called                     |
| R6  | Redundancy   | Low      | helpers.js                                       | toCleanString thin wrapper, used in one place            |
| R7  | Redundancy   | Low      | helpers.js                                       | FM container metadata guard duplicated in two functions  |
| R8  | Redundancy   | Low      | helpers.js                                       | firstNonEmpty and firstNonEmptyFast both exist/used      |
| R9  | Redundancy   | Low      | helpers.js                                       | normalizeRecordId is a near-trivial one-liner             |
| R10 | Redundancy   | Low      | routes/library.js                                | Cache-Control: no-store set in every handler individually |
| R11 | Redundancy   | Low      | routes/playlists.js                              | Same Cache-Control repetition                            |
| A1  | Architecture | Medium   | helpers.js                                       | God module — should be split by concern                  |
| A2  | Architecture | High     | store.js + cluster.js                            | File-based storage unsafe for multi-worker cluster       |
| A3  | Architecture | Low      | helpers.js                                       | Token validation logs too verbose for production         |
| A4  | Architecture | High     | (none)                                           | No automated tests                                       |

**Total issues identified: 40**
- Duplicates: 13
- Bugs / Weaknesses: 15
- Redundancies: 11
- Architecture: 4 (informational)

---

*No code has been changed. This document is for planning purposes only.*
