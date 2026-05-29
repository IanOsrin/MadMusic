# Artwork resize — one-shot S3 derivative generator

Your album artwork is stored at the Ingrooves **3000×3000** master spec, but the app
renders it in ~150px cards and ~600px detail views. That means the home page can ship
tens of megabytes of artwork to paint thumbnails. This tool generates small **WebP**
derivatives once, so the app can serve those instead. Masters are never touched.

```
artwork/GMVi4460.jpg            (master, 3000×3000, ~1–4 MB — left untouched)
artwork/resized/GMVi4460_300.webp  (cards/rails, ~15–30 KB)
artwork/resized/GMVi4460_800.webp  (album detail / now-playing, ~80–120 KB)
```

## 0. Measure first (decide if it's even worth it)

Check a few masters' size and dimensions before committing to a full run:

```bash
curl -sI "https://mass-music-audio-files.s3.eu-north-1.amazonaws.com/artwork/GMVi4460.jpg" | grep -i content-length
# dimensions, if you have ImageMagick:  curl -s <url> | identify -
```

If they're genuinely 1 MB+ / 3000px, this is your single biggest front-end speed win.
If they're already small/right-sized, stop here — it's not worth it.

## 1. Install

```bash
cd scripts/artwork-resize
npm install            # pulls sharp + @aws-sdk/client-s3 + p-limit (heavy, intentionally isolated from the app)
```

Run this **off** the 512 MB Render box (your Mac or a throwaway VM). Decoding a 3000²
JPEG needs ~36 MB of bitmap per image; doing it on the app server would OOM.

## 2. Credentials

Standard AWS chain — set in the shell before running:

```bash
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
export AWS_REGION=eu-north-1
# or: export AWS_PROFILE=your-profile
```

The identity needs `s3:ListBucket`, `s3:GetObject`, `s3:PutObject` on `mass-music-audio-files`.

## 3. Dry run → smoke test → full run

```bash
npm run dry      # lists what WOULD be generated for 10 images, writes nothing
npm run smoke    # actually generates derivatives for 10 images — eyeball quality in the browser
npm run          # ...then the full bucket
# (full run with regeneration of everything: node resize-artwork.mjs --force)
```

Eyeball a couple of the `_300.webp` and `_800.webp` outputs before the full run. The full
run is idempotent — it skips images whose derivatives already exist, so it's safe to stop
and resume. ~60k images at concurrency 8 is roughly 1–2 hours and a few dollars of S3 ops.

Config knobs (env): `ART_SIZES=300,800`, `ART_QUALITY=80`, `ART_CONCURRENCY=8`, `ART_PREFIX=artwork/`, `ART_BUCKET=...`.

## 4. Turn it on in the app

The app already knows how to serve the derivatives — it's gated behind an env flag so you
can flip it on **only after** the batch has finished, and flip it off instantly to roll back.

```
# in the app's environment (Render), once the batch is complete:
ARTWORK_THUMBS=true
```

When `ARTWORK_THUMBS=true`, the catalogue **rail** endpoints (`featured-albums`,
`releases/latest`, `new-releases`, `singles`, `g100-albums`) rewrite each record's
`Artwork_S3_URL` / `Tape Files::Artwork_S3_URL` to the `_300.webp` derivative before
responding. Because the front-end (including the compiled `app.min.js` card grids) reads
that field directly, no front-end change is needed — the smaller image flows through
automatically. Set it back to `false` to revert with zero code changes.

### Extending coverage (Claude Code, with the repo open)

The rail rewrite lives in one place — `cloneRecordsForLimit()` in
`routes/catalog/featured.js`, using `thumbArtworkUrl()` from `lib/track.js`. To cover the
other surfaces that also read `Artwork_S3_URL`, apply the same rewrite (guarded by the same
`ARTWORK_THUMBS` flag) to the item-mapping in:

- `routes/catalog/search.js` (`/search`, `/explore`) — use `_300` for result cards.
- `routes/catalog/trending.js` (`/trending`) — `_300`.
- `routes/catalog/discovery.js` (`/random-songs`, `/album`) — `_300` for lists; the
  album-detail hero can use `thumbArtworkUrl(url, 800)`.

`thumbArtworkUrl(url, size)` returns the input unchanged for anything that isn't a master
`/artwork/*.jpg|png` URL (so FM container URLs, already-resized URLs, etc. pass through
safely), which makes it safe to apply liberally.

### Optional: belt-and-braces front-end fallback

Server-side rewriting is clean but assumes every derivative exists. If you'd rather guard
against the odd missing derivative, have card `<img>` tags carry the master as a fallback:

```html
<img src="<thumb url>" data-master="<master url>"
     onerror="if(this.dataset.master&&this.src!==this.dataset.master){this.src=this.dataset.master}else{this.src='/img/default-album.svg'}">
```

(The bundle-rendered grids would need this added in the bundle source; the inline rails in
`app.html` can adopt it directly.)

## Alternative: skip the batch entirely (edge resizing)

If you'd rather not generate/store derivatives, put **Cloudflare Image Resizing** (or
CloudFront + a resize function) in front of the bucket and request `?width=300&format=auto`.
It transforms on first hit and caches at the edge — same payoff, no batch job, no extra
storage — at the cost of adding that dependency. Either approach pairs with the same
`thumbArtworkUrl()` choke point (it'd just append a query string instead of swapping the path).

## Rollback

- App: set `ARTWORK_THUMBS=false` (instant; serves masters again).
- Storage: the masters were never modified; delete the `artwork/resized/` prefix if you
  want to start over.
