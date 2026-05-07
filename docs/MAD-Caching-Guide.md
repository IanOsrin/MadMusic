# MAD Caching Guide
Generated: 2026-04-23T16:37:45Z UTC

Layers At A Glance
- Server caches: in-memory LRU + SWR.
- HTTP headers: controls browser/CDN caching.
- Browser (Chrome): honors headers; DevTools can bypass.
- Render/CDN: caches only cacheable public responses.

Server Caches (cache.js)
- searchCache: 1h TTL (updateAgeOnGet=true).
- exploreCache: 1h TTL.
- albumCache: 1h TTL.
- tokenValidationCache: 25h TTL (auth only; no content).
- streamRecordLRU: 30m TTL.
- playlistImageLRU: bounded, no TTL.
- pendingPaymentsCache: 1h TTL.
- randomSongsPoolCache: 60s TTL.
- containerUrlCache: 30m TTL.
- trackRecordCache: 10m TTL.

SWR Wrapper (lib/swr-cache.js)
- Miss: synchronously load, store, return.
- Fresh (<ttlMs): return cached immediately.
- Stale (>=ttlMs): return stale immediately; refresh in background.
- Dedupe concurrent misses/refreshes per key.
- Hard TTL on underlying LRU typically ~3x soft TTL.

Routes Using SWR
- /api/trending (routes/catalog/trending.js): soft TTL 24h; returns 'fresh' or 'stale' quickly; adds X-Cache-State.
- /api/featured-albums, /api/new-releases, /api/g100-albums: SWR-wrapped; respond with no-store but SWR serves fast.

HTTP Caching Policy (server.js)
- All /api/*: private, no-store in production; stricter no-store in development.
- HTML (/ and *.html): no-store (deploys take effect immediately).
- Static assets via express.static:
  - Hashed or '.min.' files: public, max-age=31536000, immutable (1 year).
  - Images/video/fonts: public, max-age=604800 (7 days).
  - Other JS/CSS (non-hashed) prod: public, max-age=3600, must-revalidate (1 hour).
- Deploy stamp: server rewrites '?v=' on JS/CSS per boot to bust browser caches after deploys.

Media Proxy (/api/container) (routes/stream.js)
- Mirrors key headers (Content-Type, ETag, Last-Modified, etc.).
- Audio:
  - S3-origin (content-hashed): public, max-age=31536000, immutable.
  - FM-origin: public, max-age=86400 (1 day).
- Images:
  - S3-origin: public, max-age=31536000, immutable.
  - FM-origin: public, max-age=604800, stale-while-revalidate=2592000.

Client-Side (public/js)
- No service worker registered.
- In-memory page-session caches (e.g., trending items) avoid refetch on view switches.
- Some fetches use cache: 'no-cache' and forced reloads when auth state changes.

Who’s The Culprit?
- If DevTools 'Disable cache' still shows stale data: likely server SWR/LRU.
- Static assets not updating: check that '?v=' changed after deploy; otherwise browser/CDN may serve old asset.
- Artwork/audio cached too long: confirm if S3-origin (intentional 1y) or FM-origin (7d + S-W-R).
- CDN involvement: headers like Age, Via, CF-Cache-Status indicate CDN caching.

Diagnosis Checklist
- Browser:
  - Enable 'Disable cache' in DevTools and hard-reload.
  - Inspect Cache-Control, ETag, Last-Modified, Age, Via headers.
- API JSON:
  - /api/trending returns X-Cache-State: fresh|stale|miss.
  - Force one-off refresh with '?refresh=1' where supported.
  - Admin-only: GET /api/cache/stats to inspect fill levels.
- Media:
  - For /api/container redirects to S3: expect 1y immutable.
  - For FM images: expect 7d + 30d stale-while-revalidate.

Tuning Knobs
- SWR/LRU:
  - Reduce TRENDING_CACHE_TTL_MS (e.g., 6h) for faster churn.
  - Adjust LRU TTLs in cache.js for search/explore/album/trackRecord.
  - Expose refresh=1 on more endpoints if needed.
- Media:
  - Lower FM image/audio max-age if content changes frequently.
  - Consider appending FM modId/version to image URLs to force revalidation.
- Static:
  - Keep 1y immutable on hashed assets; rely on deploy stamp to bust.

Handy Endpoints/Headers
- GET /api/cache/stats — overview of LRU + SWR caches.
- POST /api/cache/flush?cache=all — flush content caches (requires X-Admin-Key).
- /api/trending — X-Cache-State header shows freshness.
- server.js — static cache policy and deploy-stamp HTML rewriting.
- routes/stream.js — media proxy cache policy.

Code Pointers
- cache.js — LRU instances and TTLs.
- lib/swr-cache.js — SWR implementation and registry.
- routes/catalog/trending.js — SWR usage and TTL env.
- routes/catalog/featured.js — SWR usage with no-store responses.
- routes/stream.js — container proxy and cache headers.
- server.js — global API/HTML/static Cache-Control rules.

Notes
- API responses are generally no-store; if they look stale it is due to server-side SWR/LRU returning cached data by design.
- Static JS/CSS assets use long caching but are bust automatically on deploy via the server-injected '?v=' stamp.
