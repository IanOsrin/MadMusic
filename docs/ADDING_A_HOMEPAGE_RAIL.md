# Adding a homepage rail — checklist

The reference implementations are **New Releases** (`newReleasesSection`) and **Singles** (`singlesSection`). A "rail" is a horizontal-scroll row on the home page (`view-albums` in `public/app.html`) driven by a FileMaker checkbox/flag on the `API_Album_Songs` layout.

Each rail touches **four** places. Miss any one and the rail either won't load, won't show, won't survive search-mode, or won't get pre-warmed. The Singles rail debug took longest because of step 3 — front-end auth — which is easy to forget.

> **Naming convention used below:** replace `RAIL` with the camelCase name (`singles`, `newReleases`), `RAIL_VALUE` with the FM stored value (usually `"Yes"`), and `RAIL_FIELD` with the field on `Tape Files` (e.g. `singles`). The field **must be placed on the `API_Album_Songs` layout in FileMaker** or the Data API can't see it.

---

## 1. Back end — route + SWR cache

**File:** `routes/catalog/featured.js`

1. Add a TTL constant near the top:
   ```js
   const RAIL_TTL_MS = parsePositiveInt(process.env.RAIL_CACHE_TTL_MS, 10 * 60 * 1000);
   ```
2. Add field candidates (probe related-field + base-field spellings):
   ```js
   const RAIL_FIELD_CANDIDATES = ['Tape Files::RAIL_FIELD', 'RAIL_FIELD', 'Tape Files::Rail_Field', 'Rail_Field'];
   const RAIL_VALUE            = 'Yes';
   ```
3. Add a `tryRailField` + `fetchRailRecords` pair modelled on `trySinglesField` / `fetchSinglesRecords` (lines ~144-180). Decide your filter set:
   - **One card per track (singles-style):** `recordIsVisible && hasValidAudio && hasValidArtwork`, no dedupe.
   - **One card per album (new-releases-style):** filter `recordIsVisible` only, then dedupe by `artist|album` in the SWR loader.
4. Add a `createSwrCache` block modelled on `singlesSwr` / `newReleasesSwr`.
5. Add the loader to `featuredWarmers` so the cluster prewarm step primes it.
6. Add the route handler — copy the Singles handler verbatim, swap names. **Do not add a `limit` cap unless the rail genuinely needs one** (Singles is uncapped; New Releases caps at 100 because the row is dedup'd to albums and the UI doesn't want 1000 cards).

---

## 2. Server config

**File:** `server.js`

Three lines, all easy to miss:

1. **Auth skip-list** (~line 219) — add `'/rail'` so unauthenticated callers can hit `/api/rail`:
   ```js
   const skipPaths = [..., '/rail', ...];
   ```
2. **Expensive limiter** (~line 193) — add `/api/rail` to the rate-limit list.
3. **Prewarm** (~line 666):
   ```js
   prewarm('Rail', featuredWarmers.rail, 3500);
   ```

---

## 3. Front-end auth client — ⚠️ easy to miss

**File:** `public/js/auth.js`

`window.fetch` is monkey-patched. It has its own `publicEndpoints` array (lines ~76-92) that **mirrors** the server's skip-list. If you forget to add `/api/rail` here, the inline rail loader is rejected client-side before any token exists, the section never unhides, and the server logs show no request because it never left the browser.

Add the new endpoint:
```js
const publicEndpoints = [
  ...,
  '/api/rail',
];
```

Symptom of forgetting this step: console shows `[Access Token] Blocking API call without token: /api/rail` and `[Rail] load failed: API call attempted before access token was ready`. The backend logs are silent.

---

## 4. Front-end UI

**File:** `public/app.html`

Insert immediately after the previous rail's `</section>` (keeps DOM order matching visual order on `view-albums`).

1. **Section markup** — copy `singlesSection` (lines ~529-544). Keep `hidden` attribute so the rail stays invisible if the API returns no items.
2. **Scoped `<style>`** — copy `.mad-single-card` block (lines ~545-551), rename class.
3. **Inline IIFE loader** — copy the Singles `<script>` block (lines ~552-616). Drop `?limit=N` from the fetch unless you want a cap. The loader must:
   - Set `section.hidden = false` only when `items.length > 0`.
   - Call `window.MADPlayer.itemsStore.set(id, item)` **before** `playSong(id)` in the click handler — `playSong` early-returns on `!itemsStore.has(id)`.
4. **Search-mode toggle** (~line 5063) — add the new section to the `updateHeadings` IIFE so it hides during search:
   ```js
   var railSection = document.getElementById('railSection');
   ...
   if (railSection) railSection.style.display = isSearch ? 'none' : '';
   ```

---

## 5. Verify

Restart the server (route changes don't hot-reload — `node cluster.js`), hard-reload the browser, then:

```bash
curl -s "http://localhost:3000/api/rail?refresh=1" | python3 -c "import json,sys; d=json.load(sys.stdin); print('ok:',d['ok'],'total:',d['total'])"
```

- `404` → step 1 didn't land (stale process or wrong file).
- `{"ok":true,"items":[]}` → field/value/filters don't match — see Step 3 in `SINGLES_RAIL_HANDOFF.md` for the FileMaker probe scripts.
- `{"ok":true,"items":[...]}` → back end is fine. If the rail still doesn't appear, you skipped section 3 (auth.js) or section 4 step 4 (search-mode toggle).

In a headless browser (or DevTools) the rail is healthy when:
- `document.getElementById('railSection').hidden === false`
- `getComputedStyle(railSection).display !== 'none'`
- `document.getElementById('railContainer').children.length === items.length`
- Network shows `/api/rail` returning 200 (not blocked client-side).

---

## Quick reference — files to edit, in order

| # | File | What |
|---|------|------|
| 1 | `routes/catalog/featured.js` | TTL, candidates, fetch fn, SWR cache, warmer entry, route handler |
| 2 | `server.js` | auth skip-list, rate limiter, prewarm |
| 3 | `public/js/auth.js` | `publicEndpoints` array |
| 4 | `public/app.html` | section markup, `<style>`, IIFE loader, `updateHeadings` toggle |

If you do these in this order — and don't skip step 3 — the rail works first try.
