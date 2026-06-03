# MAD Banners — Editorial Hero & Promo Banner Spec

Status: v1 · 2026-06-03 · Owner: Server Dev
Applies to: home hero carousel (`#heroBanner`), G100 banner, future promo slots.

## 1. The problem this spec solves

The v2.1 hero pulled square album artwork (≈600×600) and stretched it across a
~1450×360 banner with `background-size: cover` — random cropping, upscale blur,
distortion. Banners must never crop unpredictably or upscale beyond source
resolution.

## 2. Image classes

| Class | Aspect | Master size | Max file | Use |
|---|---|---|---|---|
| **Editorial hero** | 16:9 | 1600×900 JPEG, sRGB | 500 KB | Designed slides via FM `API_Hero_Featured` |
| **Fallback art** | 1:1 | whatever FM artwork gives | — | Auto slides from `/api/new-releases` |
| **Full-width promo** (G100 style) | free | 2400×560 PNG/JPEG | 800 KB | Static campaign strips |

S3 location for editorial masters: `s3://mass-music-audio-files/editorial/<short-name>.jpg`
(public-read prefix; same flow as album artwork — see v3.1 `docs/EDITORIAL-HERO-WORKFLOW.md`).

## 3. Rendering rules (enforced by CSS, not by hope)

1. **Container owns the shape.** Hero viewport is `aspect-ratio: 16/9` with
   `max-height: 420px` (desktop) / `min-height: 200px` (mobile). Never a fixed
   height that fights the image ratio.
2. **16:9 editorial images** render as `<img>` with `object-fit: cover;
   object-position: center` — safe because source and container share an
   aspect; effective crop ≈ 0.
3. **Square fallback art is never stretched.** Two-layer treatment:
   - back layer: same image, `object-fit: cover` + `filter: blur(28px) brightness(.55) saturate(1.1)`, scaled 1.15 to hide blur edges → ambient colour field
   - front layer: the artwork `object-fit: contain`, right-aligned card with shadow, fully sharp at native size (never upscaled past 1×: `max-height: 100%`)
   - text content occupies the left column over the gradient.
4. **No `background-image` for content imagery** — `<img>` only (lazy-loadable,
   error-handleable, no silent stretch).
5. **Gradient scrim** for text legibility: `linear-gradient(90deg, rgba(0,0,0,.72) 0%, rgba(0,0,0,.25) 55%, rgba(0,0,0,0) 100%)` over back layer, under content.
6. **`onerror` fallback** → hide slide, never show a broken image.
7. **Reduced motion**: `prefers-reduced-motion` disables autoplay.

## 4. Data contract

Primary: `GET /api/featured-editorial?limit=6` → `{ source: 'fm'|'fallback', items: [{ title, eyebrow, imageUrl, targetType: track|album|playlist|external, targetId, ctaLabel, sortOrder }] }`
- Served from FM layout `API_Hero_Featured` (fields: Title, Eyebrow, Image_S3_URL, Target_Type, Target_ID, CTA_Label, Sort_Order, Active, Start_Date, End_Date).
- SWR-cached 60 s — editorial changes go live within a minute; FM outage serves last good value. **Never a direct FM call on the request path.**
- Feature flag: `EDITORIAL_HERO_ENABLED` (default off until the FM layout exists). When off or empty → frontend falls back to `/api/new-releases` slides using the square-art treatment (rule 3).

## 5. Operational notes

- FM layout `API_Hero_Featured` does **not exist yet** (known deferred gap). The carousel ships working off fallback art on day one; flipping the env flag turns on editorial without a deploy beyond `.env`.
- Slide count: max 6. Autoplay dwell 6.5 s, manual nav resets the clock.
- Adding a slide = editorial task in FM, zero developer involvement (see workflow doc).
