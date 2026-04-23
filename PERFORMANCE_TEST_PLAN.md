# Performance Pass — Local Test Plan

All performance work is in place. Because you've asked not to deploy yet,
this is a checklist to run **locally** before shipping. Work top-to-bottom.

---

## 0. Boot sanity

```bash
cd ~/Desktop/madmusicV2.1
npm install                # in case lru-cache is newer than lockfile
node server.js             # or your usual start script
```

Expect to see (stderr, ordered by jittered delay):

```
[Featured]          Prewarming...
[Trending]          Prewarming...
[New Releases]      Prewarming...
[G100]              Prewarming...
[Public Playlists]  Prewarming...
[Genres]            Prewarming...
```

Then each should log `✓ warmed in Xms` (success) or `✗ failed` (investigate).
With clustering, every worker should run its own prewarm (jittered 0-2 s
apart) — confirm by counting `[Featured] Prewarming` lines against worker
count.

- [ ] All 6 warmers report `✓ warmed`
- [ ] No unhandled promise rejections in the log
- [ ] Every worker runs prewarm (not just worker 0)

---

## 1. SWR behaviour — cold → fresh → stale

The target is: the *user* never waits on the upstream round-trip after
warm-up.

For each of these endpoints, cold hit populates, repeat hit is instant,
`?refresh=1` forces a miss:

| Endpoint                               | Expected cold ms | Expected warm ms |
|----------------------------------------|------------------|------------------|
| `GET /api/featured-albums?limit=20`    | 1000–2000        | <30              |
| `GET /api/new-releases?limit=50`       | 1000–2000        | <30              |
| `GET /api/g100?limit=100`              | 1000–2000        | <30              |
| `GET /api/trending?limit=5`            | 2000–5000        | <30              |
| `GET /api/public-playlists`            | 500–1500         | <30              |
| `GET /api/public-playlists?name=Chill` | 500–2000         | <30              |
| `GET /api/genres`                      | 15000–20000 \*   | <30              |

\* cold only on the very first call after starting from a cold cache —
the prewarmer should already have primed this.

Inspect `X-Cache-State` on the response:

```bash
curl -sI http://localhost:3000/api/featured-albums?limit=20 | grep -i cache
# X-Cache-State: fresh   ← warm hit
# X-Cache-State: stale   ← served from stale while background refresh runs
# X-Cache-State: miss    ← cold load
```

- [ ] Every warm hit returns `X-Cache-State: fresh`
- [ ] After TTL expires (or ?refresh=1), next hit returns `stale` or `miss`
      — **but still returns in <100 ms** if a stale value exists
- [ ] Background refresh updates the cache (next hit returns `fresh` again)

---

## 2. Search / explore regressions

Verify existing behaviour still works after the logger + year-field
refactors.

```bash
curl -s 'http://localhost:3000/api/search?q=Beethoven&limit=10' | jq '.items|length'
curl -s 'http://localhost:3000/api/search?genre=Jazz&limit=10' | jq '.items|length'
curl -s 'http://localhost:3000/api/explore?start=1970&end=1979&limit=50' | jq '.items|length'
```

- [ ] `/search?q=...` returns items for a known album artist
- [ ] `/search?genre=Jazz` returns only jazz entries (post-filter check)
- [ ] `/explore?start=1970&end=1979` returns records — then check server
      log to confirm `cachedYearField` fast-path kicks in on the second
      call (only ONE `tryYearField` attempt should run)
- [ ] `/ai-search` still returns the 501 stub (we didn't touch it)

---

## 3. Container proxy cache headers

```bash
# FM-origin (auth'd) — should keep modest TTL
curl -sI 'http://localhost:3000/api/container?rid=XXXX&field=ArtworkField' \
  | grep -i cache-control
# expected: public, max-age=604800, stale-while-revalidate=2592000

# S3-origin image — should be year-long + immutable
curl -sI 'http://localhost:3000/api/container?u=https%3A//mybucket.s3.amazonaws.com/cover.jpg' \
  | grep -i cache-control
# expected: public, max-age=31536000, immutable
```

Note that S3 images are now *redirected* (302), not proxied, so the
header on the 302 itself is what matters — confirm it's the year-long
immutable value.

- [ ] FM-origin → 7-day TTL + SWR window
- [ ] S3-origin audio/image → `max-age=31536000, immutable`
- [ ] Range requests (seek) on FM audio still return 206 with correct
      `Content-Range`

---

## 4. N+1 elimination — trending/my-stats

The shared `trackRecordCache` means repeat calls for the same hot
tracks should not hit FM. Watch the log for FM round-trip noise.

```bash
# warm the cache
curl -s http://localhost:3000/api/trending?limit=20 >/dev/null
# second hit should be near-instant with NO [fm] GET /records/... lines
curl -s http://localhost:3000/api/trending?limit=20 >/dev/null

# cross-endpoint — same tracks served via a different endpoint
curl -s "http://localhost:3000/api/my-stats?token=XXXXX" >/dev/null
```

- [ ] Second `/trending` call produces zero FM `_find` or
      `fmGetRecordById` log lines for the track records
- [ ] `/my-stats` for a user whose top tracks overlap with /trending
      reuses cached track records (no FM fetch for those ids)

---

## 5. Admin endpoints — stats visibility

```bash
curl -s http://localhost:3000/api/admin/cache/stats | jq .
```

Should return:
- `content`: search, explore, album, containerUrl, trackRecord, playlistImage
- `sensitive`: tokenValidation, streamRecord, pendingPayments
- `swr`: array containing featured, newReleases, g100, trending, genres,
        publicPlaylistTracks, publicPlaylistList (names, sizes, ttls)

- [ ] `publicPlaylistsCache`, `trendingCache`, `genreCache`, `genreListCache`
      are **no longer** in the content list
- [ ] SWR array shows all 7 named SWR caches with correct `ttlMs`
- [ ] `fillPct` for SWR caches increases after endpoints are hit

```bash
# With your ADMIN_SECRET exported:
curl -s -X POST -H "X-Admin-Key: $ADMIN_SECRET" \
  "http://localhost:3000/api/admin/cache/flush?cache=featured"
# → { flushed: [{ name: 'featured', cleared: N, kind: 'swr' }], ... }

curl -s -X POST -H "X-Admin-Key: $ADMIN_SECRET" \
  "http://localhost:3000/api/admin/cache/flush?cache=all"
# → flushes BOTH the LRU content caches AND the SWR caches
```

- [ ] Flush by SWR name works
- [ ] Flush "all" returns entries with both `kind: 'lru'` and `kind: 'swr'`
- [ ] Sensitive caches (tokenValidation, pendingPayments) unchanged
      after `cache=all`

```bash
curl -s -H "X-Admin-Key: $ADMIN_SECRET" \
  http://localhost:3000/api/admin/health/detailed | jq .
```

- [ ] Response includes `swrCaches` array alongside `caches`

---

## 6. Logger gating

With no `DEBUG` env var:

```bash
DEBUG= node server.js 2>&1 | grep -iE 'search|explore|trending|featured'
```

Should show only warn/error noise, no debug lines on the hot path.

Then enable one tag:

```bash
DEBUG=search node server.js
```

- [ ] With `DEBUG=` unset → zero debug noise from search/explore/trending
- [ ] `DEBUG=search` → search debug lines appear; others stay quiet
- [ ] `DEBUG=*` (or `all`, `1`) → every module logs

---

## 7. Load / concurrency sanity (optional but worth it)

If you have `autocannon` or similar:

```bash
npx autocannon -c 50 -d 15 http://localhost:3000/api/featured-albums?limit=20
npx autocannon -c 50 -d 15 http://localhost:3000/api/trending?limit=5
```

After warm-up:
- [ ] p99 under ~50 ms on the featured/trending endpoints
- [ ] No FM queue build-up (check `/api/admin/health/detailed` →
      `filemaker.queueDepth` and `activeRequests`)
- [ ] `consecutive401s` stays at 0

---

## 8. Rollback cue

If anything looks wrong, the cleanest rollback is to revert four files:

- `lib/swr-cache.js` (new — delete to disable SWR entirely)
- `lib/logger.js` (new — delete to restore plain console logs)
- `lib/track-cache.js` (new)
- `cache.js` (restore the removed `publicPlaylistsCache`, `trendingCache`,
  `genreCache`, `genreListCache` exports)

All route files were edited non-destructively — their prior behaviour
is preserved; the SWR wrappers are additive.

---

## Sign-off

- [ ] All sections above ticked off locally
- [ ] Memory footprint after 10 min of traffic stays under your ceiling
      (check with `node --inspect` or `process.memoryUsage()`)
- [ ] Ready to deploy
