/**
 * routes/featured-editorial.js — Editorial hero CMS endpoint (ported from v3.1).
 *
 * Reads from the FM `API_Hero_Featured` layout, SWR-cached (60 s TTL) so the
 * request path NEVER blocks on FileMaker. FM outage → last good value; cold
 * miss failure → graceful `{ source: 'fallback', items: [] }` so the frontend
 * falls back to new-release artwork slides.
 *
 * Feature flag: EDITORIAL_HERO_ENABLED=true  (default OFF — the FM layout may
 * not exist yet; see docs/banners.md §5).
 *
 * GET /api/featured-editorial?limit=6
 *   → { ok, source: 'live'|'fallback', items: [{ heroId, title, eyebrow,
 *        imageUrl, targetType, targetId, ctaLabel, order }] }
 */
import { Router } from 'express';
import { fmFindRecords } from '../fm-client.js';
import { FM_HERO_LAYOUT, HERO_TARGET_TYPES } from '../lib/fm-fields.js';
import { createSwrCache } from '../lib/swr-cache.js';

const router = Router();
const ENABLED = process.env.EDITORIAL_HERO_ENABLED === 'true';

async function fetchFromFm() {
  const result = await fmFindRecords(FM_HERO_LAYOUT, [{ Active: '1' }], { limit: 50 });
  const records = result?.data || []; // v2.1 fmFindRecords returns { ok, data, total }
  const today = new Date().toISOString().slice(0, 10);
  return records
    .filter((r) => isWithinDateWindow(r.fieldData || {}, today))
    .filter((r) => HERO_TARGET_TYPES.includes(String((r.fieldData || {}).Target_Type || '').toLowerCase()))
    .map(mapRecord)
    .filter((s) => s.title && s.imageUrl) // never ship a blank or imageless slide
    .sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
}

function isWithinDateWindow(fields, today) {
  const start = String(fields.Start_Date || '').trim();
  const end   = String(fields.End_Date || '').trim();
  if (start && toIso(start) > today) return false;
  if (end && toIso(end) < today) return false;
  return true;
}

// FM dates often arrive as MM/DD/YYYY; normalize to YYYY-MM-DD for comparison.
function toIso(d) {
  if (!d) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(d)) return d.slice(0, 10);
  const m = d.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return d;
}

function mapRecord(r) {
  const f = r.fieldData || {};
  return {
    heroId:     String(f.Hero_ID || r.recordId || ''),
    title:      String(f.Title || '').trim(),
    eyebrow:    String(f.Eyebrow || '').trim() || null,
    imageUrl:   String(f.Image_S3_URL || '').trim(),
    targetType: String(f.Target_Type || '').toLowerCase(),
    targetId:   String(f.Target_ID || '').trim(),
    ctaLabel:   String(f.CTA_Label || '').trim() || null,
    order:      Number.parseInt(f.Sort_Order, 10) || 999
  };
}

const heroSwr = createSwrCache({
  ttlMs: 60_000,
  max: 4,
  label: 'editorial-hero',
  name: 'editorial-hero',
  loader: () => fetchFromFm()
});

router.get('/featured-editorial', async (req, res) => {
  res.setHeader('Cache-Control', 'public, s-maxage=60, max-age=60, stale-while-revalidate=300');
  const limit = Math.max(1, Math.min(10, Number.parseInt(req.query.limit, 10) || 6));
  if (!ENABLED) return res.json({ ok: true, source: 'fallback', items: [] });
  try {
    const result = await heroSwr.get('default');
    const items = result.value || [];
    res.setHeader('X-Cache-State', result.state || 'miss');
    return res.json({
      ok: true,
      source: items.length ? 'live' : 'fallback',
      items: items.slice(0, limit)
    });
  } catch (err) {
    console.warn('[editorial-hero] fetch failed:', err.message);
    return res.json({ ok: true, source: 'fallback', items: [] });
  }
});

export default router;
