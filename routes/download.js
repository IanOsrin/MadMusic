/**
 * routes/download.js — Per-track paid download endpoints.
 * No streaming access token required — open to anyone.
 * Purchases are identified by Paystack reference stored in FileMaker.
 *
 * POST /api/download/initiate  { trackId, trackRecordId, email } → { ok, authorization_url, reference }
 * GET  /api/download/callback  ?reference=                       → redirects to /?download=success&ref=...
 * GET  /api/download/file      ?ref=                             → proxied audio file
 */

import { Router }   from 'express';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  fmFindRecords,
  fmCreateRecord,
  fmGetRecordById,
  fmUpdateRecord,
  safeFetch
} from '../fm-client.js';
import {
  FM_LAYOUT,
  AUDIO_FIELD_CANDIDATES
} from '../lib/fm-fields.js';
import { paystackRequest } from '../lib/paystack.js';
import { isStrictEmail, fmExactMatch } from '../lib/validators.js';
import { sendDownloadLinkEmail, sendBasketLinksEmail } from '../lib/email.js';
import { requireAdminKey } from './admin.js';

const router = Router();

const FM_DOWNLOADS_LAYOUT = process.env.FM_DOWNLOADS_LAYOUT || 'API_Download_Purchases';

// How long a purchase reference can be used to fetch the file. Defends against
// a leaked `ref` (it rides in URLs) being replayed indefinitely.
const DOWNLOAD_LINK_TTL_HOURS = Number.parseFloat(process.env.DOWNLOAD_LINK_TTL_HOURS || '48') || 48;

// A link is dead after this many COMPLETED downloads (Ian, 2026-08-25: 3 —
// covers phone+computer+retry while making sharing pointless; counting only
// completed streams keeps mail-scanner prefetches from burning uses).
const DOWNLOAD_MAX_USES = Number.parseInt(process.env.DOWNLOAD_MAX_USES || '3', 10) || 3;

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolveAudioUrl(fieldData) {
  for (const field of AUDIO_FIELD_CANDIDATES) {
    const val = fieldData?.[field];
    if (val && typeof val === 'string' && val.startsWith('http')) return val;
  }
  return null;
}

/**
 * The purchase for a reference — and, since a basket pays once for several
 * tracks, optionally the one FOR A GIVEN TRACK. Every item of a basket shares
 * the Paystack reference but keeps its own record, so each track keeps its own
 * download allowance and its own counter.
 */
async function findPurchaseByRef(reference, trackRecordId = null) {
  const result = await fmFindRecords(FM_DOWNLOADS_LAYOUT, [
    { Paystack_Reference: fmExactMatch(reference), Status: fmExactMatch('complete') }
  ], { limit: 100 });
  if (!result.ok || result.data.length === 0) return null;
  const rows = result.data;
  const pick = trackRecordId
    ? rows.find(r => String(r.fieldData['TrackRecordID'] || '').trim() === String(trackRecordId).trim())
    : rows[0];                    // no track asked for: the single-track case, unchanged
  if (!pick) return null;
  const fd = pick.fieldData;
  fd.__recordId = pick.recordId;   // for the download counter
  return fd;
}

/** Every purchase sharing a reference — the whole basket. */
async function findPurchasesByRef(reference) {
  const result = await fmFindRecords(FM_DOWNLOADS_LAYOUT, [
    { Paystack_Reference: fmExactMatch(reference), Status: fmExactMatch('complete') }
  ], { limit: 100 });
  if (!result.ok) return [];
  return result.data.map(r => ({ ...r.fieldData, __recordId: r.recordId }));
}

async function fetchTrackRecord(recordId) {
  const record = await fmGetRecordById(FM_LAYOUT, recordId);
  if (!record) return null;
  return record.fieldData || null;
}

// Candidate timestamp fields on the purchase record. The FM map does not document
// an explicit Created/Paid field on API_Download_Purchases, so we probe the common
// names. Returns ms-epoch or null if none is present/parseable.
// CreationTimestamp is the pinned field (added to API_Download_Purchases
// 2026-08-25, populated on all records, FM "MM/DD/YYYY HH:MM:SS" — parseable);
// the rest remain as fallbacks.
const PURCHASE_TS_FIELD_CANDIDATES = [
  'CreationTimestamp',
  'Created', 'Created_At', 'CreatedTimestamp', 'Creation_Timestamp',
  'Date_Created', 'Timestamp', 'Paid_At', 'Paid', 'Purchase_Date', 'Date'
];

function purchaseTimestampMs(fieldData) {
  for (const field of PURCHASE_TS_FIELD_CANDIDATES) {
    const raw = fieldData?.[field];
    if (raw === undefined || raw === null || raw === '') continue;
    const ms = Date.parse(String(raw));
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

// Reject a leaked/replayed ref once the purchase is older than the TTL window.
// Guarded: if no timestamp field is present/parseable we log and ALLOW so a
// schema gap never blocks a legitimate download. TODO: confirm the actual
// timestamp field name on API_Download_Purchases and pin it here.
function isPurchaseFresh(fieldData) {
  const ms = purchaseTimestampMs(fieldData);
  if (ms === null) {
    console.warn('[DOWNLOAD] No parseable purchase timestamp — skipping recency check (allowing download)');
    return true;
  }
  const ageHours = (Date.now() - ms) / (60 * 60 * 1000);
  return ageHours <= DOWNLOAD_LINK_TTL_HOURS;
}

// ── POST /api/download/initiate ───────────────────────────────────────────────
// Body: { trackId, trackRecordId, email }

router.post('/initiate', async (req, res) => {
  const { trackId, trackRecordId, email } = req.body;

  if (!trackId || !trackRecordId || !isStrictEmail(email)) {
    return res.status(400).json({ ok: false, error: 'trackId, trackRecordId and a valid email are required' });
  }

  try {
    const fieldData = await fetchTrackRecord(trackRecordId);
    if (!fieldData) {
      return res.status(404).json({ ok: false, error: 'Track not found' });
    }

    const price = parseFloat(fieldData['Download_Price'] || fieldData['DownloadPrice'] || 0);
    if (!price || price <= 0) {
      return res.status(400).json({ ok: false, error: 'This track is not available for purchase' });
    }

    const amountCents = Math.round(price * 100);
    const trackName   = fieldData['Track Name'] || fieldData['Title'] || fieldData['Song Name'] || 'Track';

    const APP_BASE    = (process.env.APP_URL || '').replace(/\/$/, '');
    const callbackUrl = APP_BASE
      ? `${APP_BASE}/api/download/callback`
      : `${req.protocol}://${req.get('host')}/api/download/callback`;

    const data = await paystackRequest('POST', '/transaction/initialize', {
      email:        email.trim().toLowerCase(),
      amount:       amountCents,
      currency:     'ZAR',
      callback_url: callbackUrl,
      metadata: {
        payment_type:   'download',
        trackId,
        trackRecordId,
        trackName,
        price
      }
    });

    console.log(`[DOWNLOAD] Payment initialized: ${data.data.reference} — "${trackName}" for ${email}`);
    return res.json({
      ok:                true,
      authorization_url: data.data.authorization_url,
      reference:         data.data.reference
    });
  } catch (err) {
    console.error('[DOWNLOAD] Initiate error:', err.message);
    return res.status(500).json({ ok: false, error: 'Failed to initialize payment' });
  }
});

// ── POST /api/download/basket/initiate ────────────────────────────────────────
// Body: { items: [trackRecordId, …], email }
//
// Paying per track was the thing stopping people buying more than one (Ian,
// 2026-09-21). The basket is ONE Paystack transaction for the lot; everything
// after the payment stays per track — a record each, a link each, three
// downloads each — so a failed download costs one track, not the purchase.
const BASKET_MAX_ITEMS = 50;

router.post('/basket/initiate', async (req, res) => {
  const { items, email } = req.body || {};
  if (!Array.isArray(items) || !items.length) {
    return res.status(400).json({ ok: false, error: 'items are required' });
  }
  if (!isStrictEmail(email)) {
    return res.status(400).json({ ok: false, error: 'a valid email is required' });
  }
  const ids = [...new Set(items.map(String).map(s => s.trim()).filter(Boolean))].slice(0, BASKET_MAX_ITEMS);

  try {
    // Price every track from FileMaker, never from the browser: the basket the
    // customer sees is a convenience, the price is ours.
    const priced = [];
    const rejected = [];
    for (const id of ids) {
      const fieldData = await fetchTrackRecord(id);
      if (!fieldData) { rejected.push({ trackRecordId: id, reason: 'not found' }); continue; }
      const price = parseFloat(fieldData['Download_Price'] || fieldData['DownloadPrice'] || 0);
      if (!price || price <= 0) { rejected.push({ trackRecordId: id, reason: 'not for sale' }); continue; }
      priced.push({
        trackRecordId: id,
        name: fieldData['Track Name'] || fieldData['Title'] || fieldData['Song Name'] || 'Track',
        artist: fieldData['Track Artist'] || fieldData['Album Artist'] || '',
        price,
      });
    }
    if (!priced.length) {
      return res.status(400).json({ ok: false, error: 'None of these tracks are available for purchase', rejected });
    }

    const total = priced.reduce((sum, i) => sum + i.price, 0);
    const APP_BASE = (process.env.APP_URL || '').replace(/\/$/, '');
    const callbackUrl = APP_BASE
      ? `${APP_BASE}/api/download/callback`
      : `${req.protocol}://${req.get('host')}/api/download/callback`;

    const data = await paystackRequest('POST', '/transaction/initialize', {
      email: email.trim().toLowerCase(),
      amount: Math.round(total * 100),
      currency: 'ZAR',
      callback_url: callbackUrl,
      metadata: {
        payment_type: 'download_basket',
        count: priced.length,
        // Names ride along so the receipt and the email read properly even if a
        // track record changes between paying and fulfilment.
        items: priced.map(i => ({ id: i.trackRecordId, n: i.name.slice(0, 80), a: (i.artist || '').slice(0, 60), p: i.price })),
      },
    });

    console.log(`[DOWNLOAD] Basket initialized: ${data.data.reference} — ${priced.length} tracks, R${total.toFixed(2)} for ${email}`);
    return res.json({
      ok: true,
      authorization_url: data.data.authorization_url,
      reference: data.data.reference,
      items: priced,
      total,
      rejected,
    });
  } catch (err) {
    console.error('[DOWNLOAD] Basket initiate error:', err.message);
    return res.status(500).json({ ok: false, error: 'Failed to initialize payment' });
  }
});

/**
 * Record a paid basket: one purchase row per track, all sharing the reference.
 * Idempotent — the callback and the webhook both land here, and whichever
 * arrives second writes nothing.
 */
async function recordBasket(metadata, reference, email) {
  const items = (metadata.items || []).map(i => ({
    trackRecordId: String(i.id || ''), name: i.n || 'Track', artist: i.a || '', price: Number(i.p) || 0,
  })).filter(i => i.trackRecordId);
  if (!items.length) return { items: [], created: 0 };

  const already = await findPurchasesByRef(reference);
  const have = new Set(already.map(p => String(p['TrackRecordID'] || '').trim()));
  let created = 0;
  for (const item of items) {
    if (have.has(item.trackRecordId)) continue;
    await fmCreateRecord(FM_DOWNLOADS_LAYOUT, {
      TrackRecordID: item.trackRecordId,
      Amount_Paid: item.price,
      Currency: 'ZAR',
      Paystack_Reference: reference,
      Email: email,
      Status: 'complete',
    });
    created++;
  }
  if (created) {
    console.log(`[DOWNLOAD] Basket recorded: ${created} track(s) ref=${reference} email=${email}`);
    sendBasketLinksEmail(email, items, reference);   // fire-and-forget
  }
  return { items, created };
}

// ── GET /api/download/callback ────────────────────────────────────────────────

router.get('/callback', async (req, res) => {
  const { reference } = req.query;
  if (!reference) return res.redirect('/?download=error&reason=missing_reference');

  try {
    const data     = await paystackRequest('GET', `/transaction/verify/${encodeURIComponent(reference)}`);
    const tx       = data.data;
    const metadata = tx?.metadata || {};

    const isBasket = metadata.payment_type === 'download_basket';
    if (tx?.status !== 'success' || (metadata.payment_type !== 'download' && !isBasket)) {
      console.warn(`[DOWNLOAD] Callback: unexpected status/type for ${reference}`);
      return res.redirect('/?download=error&reason=verification_failed');
    }

    if (isBasket) {
      const email = tx.customer?.email || '';
      const { items } = await recordBasket(metadata, reference, email);
      // The reference stays out of the browser URL — it is a bearer token for
      // /file. The page re-uses the copy the basket kept when it initiated.
      return res.redirect(`/?download=basket&count=${items.length}`);
    }

    const { trackId, trackRecordId, trackName, price } = metadata;
    const email = tx.customer?.email || '';

    // Idempotent — only write once
    const existing = await findPurchaseByRef(reference);
    if (!existing) {
      await fmCreateRecord(FM_DOWNLOADS_LAYOUT, {
        TrackRecordID:      trackId,
        Amount_Paid:        price,
        Currency:           'ZAR',
        Paystack_Reference: reference,
        Email:              email,
        Status:             'complete'
      });
      console.log(`[DOWNLOAD] Purchase recorded: "${trackName}" ref=${reference} email=${email}`);
      sendDownloadLinkEmail(email, trackName, reference);   // fire-and-forget
    }

    // Do NOT include the Paystack reference in the browser-facing URL — it is a
    // replayable bearer token for /file. The frontend re-uses it from its own
    // initiate() response if it needs to fetch the file.
    return res.redirect(`/?download=success&name=${encodeURIComponent(trackName || '')}&recordId=${encodeURIComponent(trackRecordId || '')}`);
  } catch (err) {
    console.error('[DOWNLOAD] Callback error:', err.message);
    return res.redirect('/?download=error&reason=server_error');
  }
});

// ── Recovery tokens ───────────────────────────────────────────────────────────
// When the Paystack return lands in a different tab/browser (common in mobile
// in-app browsers) the sessionStorage ref is gone even though the purchase is
// recorded. /recover lets the buyer restart the download with the email they
// paid with: purchase looked up server-side, and a SHORT-LIVED signed token is
// issued instead of re-exposing the long-TTL ref. Signed with AUTH_SECRET.
const RECOVER_TOKEN_TTL_MS = 15 * 60 * 1000;
// Secret precedence: a dedicated DOWNLOAD_LINK_SECRET, else the Paystack
// secret (always present where payments work, server-side only). Never mint
// with an empty key — the token could never verify.
const RECOVER_SECRET = process.env.DOWNLOAD_LINK_SECRET || process.env.AUTH_SECRET || process.env.PAYSTACK_SECRET_KEY || '';

function signRecoverToken(reference) {
  const payload = Buffer.from(JSON.stringify({ r: reference, e: Date.now() + RECOVER_TOKEN_TTL_MS }))
    .toString('base64url');
  const mac = createHmac('sha256', RECOVER_SECRET).update(payload).digest('base64url');
  return `${payload}.${mac}`;
}

function verifyRecoverToken(token) {
  const [payload, mac] = String(token || '').split('.');
  if (!payload || !mac || !RECOVER_SECRET) return null;
  const expect = createHmac('sha256', RECOVER_SECRET).update(payload).digest('base64url');
  if (mac.length !== expect.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null;
  try {
    const { r, e } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!r || !Number.isFinite(e) || Date.now() > e) return null;
    return r;
  } catch { return null; }
}

// ── POST /api/download/recover ────────────────────────────────────────────────
// Body: { trackRecordId, email } → { ok, token } when a fresh completed
// purchase by that email for that track exists. Auth = email + track +
// freshness window; the token expires in 15 minutes and embeds the reference.

router.post('/recover', async (req, res) => {
  if (!RECOVER_SECRET) {
    console.error('[DOWNLOAD] Recover disabled: no DOWNLOAD_LINK_SECRET/PAYSTACK_SECRET_KEY configured');
    return res.status(500).json({ ok: false, error: 'Download recovery is not available right now — please contact support with your payment receipt' });
  }
  const { trackRecordId, email } = req.body || {};
  if (!trackRecordId || !isStrictEmail(email)) {
    return res.status(400).json({ ok: false, error: 'trackRecordId and a valid email are required' });
  }
  try {
    // Purchases store the site-facing trackId; the return URL carries the FM
    // recordId — bridge via the track record's recid field.
    const fieldData = await fetchTrackRecord(trackRecordId);
    if (!fieldData) return res.status(404).json({ ok: false, error: 'Track not found' });
    const trackId = String(fieldData['recid'] || trackRecordId);

    const result = await fmFindRecords(FM_DOWNLOADS_LAYOUT, [
      { TrackRecordID: fmExactMatch(trackId), Email: fmExactMatch(email.trim()), Status: fmExactMatch('complete') }
    ]);
    const purchases = (result?.data || []).map(r => r.fieldData).filter(isPurchaseFresh);
    if (!purchases.length) {
      console.warn(`[DOWNLOAD] Recover: no fresh purchase for track ${trackId} / ${email}`);
      return res.status(404).json({ ok: false, error: 'No recent purchase found for that email' });
    }
    purchases.sort((a, b) => (purchaseTimestampMs(b) || 0) - (purchaseTimestampMs(a) || 0));
    const reference = purchases[0]['Paystack_Reference'];
    if (!reference) return res.status(500).json({ ok: false, error: 'Purchase record is missing its reference' });
    console.log(`[DOWNLOAD] Recover: issued token for ref=${reference} (track ${trackId})`);
    return res.json({ ok: true, token: signRecoverToken(reference) });
  } catch (err) {
    console.error('[DOWNLOAD] Recover error:', err.message);
    return res.status(500).json({ ok: false, error: 'Could not recover the download' });
  }
});

// ── GET /api/download/file ────────────────────────────────────────────────────
// ?ref=PAYSTACK_REFERENCE  — verified against FM purchase record
// ?t=SIGNED_TOKEN          — 15-minute recovery token from /recover

router.get('/file', async (req, res) => {
  let { ref } = req.query;
  if (!ref && req.query.t) {
    ref = verifyRecoverToken(req.query.t);
    if (!ref) return res.status(403).json({ ok: false, error: 'This download link has expired — request a new one' });
  }
  if (!ref) return res.status(400).json({ ok: false, error: 'ref is required' });

  try {
    // `track` picks one item out of a basket. Old links carry no track and
    // still resolve to their single purchase, so nothing already emailed breaks.
    const purchase = await findPurchaseByRef(ref, req.query.track || null);
    if (!purchase) {
      return res.status(403).json({ ok: false, error: 'No valid purchase found for this reference' });
    }

    // Reject stale/leaked references — a download link is only valid for a window.
    if (!isPurchaseFresh(purchase)) {
      return res.status(403).json({ ok: false, error: 'This download link has expired' });
    }

    // Dead after DOWNLOAD_MAX_USES completed downloads.
    const usedCount = Number.parseInt(purchase['Download_Count'], 10) || 0;
    if (usedCount >= DOWNLOAD_MAX_USES) {
      console.warn(`[DOWNLOAD] Limit reached for ref=${ref} (${usedCount}/${DOWNLOAD_MAX_USES})`);
      return res.status(403).json({ ok: false, error: 'This download link has reached its download limit — please contact support with your payment receipt' });
    }

    const trackRecordId = purchase['TrackRecordID'] || '';
    if (!trackRecordId) {
      return res.status(404).json({ ok: false, error: 'Track record ID missing from purchase' });
    }

    const fieldData = await fetchTrackRecord(trackRecordId);
    if (!fieldData) return res.status(404).json({ ok: false, error: 'Track not found' });

    const audioUrl = resolveAudioUrl(fieldData);
    if (!audioUrl) return res.status(404).json({ ok: false, error: 'Audio file not available' });

    const trackName = (fieldData['Track Name'] || fieldData['Title'] || fieldData['Song Name'] || 'track')
      .replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '_');
    const ext      = audioUrl.split('?')[0].split('.').pop() || 'mp3';
    const filename = `${trackName}.${ext}`;

    const s3Res = await safeFetch(audioUrl, {}, { timeoutMs: 30000 });
    if (!s3Res.ok) {
      console.error(`[DOWNLOAD] S3 fetch failed: ${s3Res.status}`);
      return res.status(502).json({ ok: false, error: 'Could not retrieve audio file' });
    }

    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', s3Res.headers.get('content-type') || 'audio/mpeg');
    const contentLength = s3Res.headers.get('content-length');
    if (contentLength) res.setHeader('Content-Length', contentLength);

    console.log(`[DOWNLOAD] Serving "${filename}" ref=${ref} (use ${usedCount + 1}/${DOWNLOAD_MAX_USES})`);
    await pipeline(Readable.fromWeb(s3Res.body), res);
    // Count only COMPLETED downloads — pipeline resolving means the whole
    // file went out. Fire-and-forget; a failed count must never break serving.
    if (purchase.__recordId) {
      fmUpdateRecord(FM_DOWNLOADS_LAYOUT, purchase.__recordId, { Download_Count: usedCount + 1 })
        .catch(err => console.error(`[DOWNLOAD] Could not bump Download_Count for ref=${ref}:`, err?.message || err));
    }
  } catch (err) {
    console.error('[DOWNLOAD] File serve error:', err.message);
    if (!res.headersSent) res.status(500).json({ ok: false, error: 'Download failed' });
  }
});

// ── POST /api/download/resend-email (admin) ──────────────────────────────────
// Support tool: re-send the download-link email for a recorded purchase.
// Body: { reference } — X-Admin-Key required.

router.post('/resend-email', requireAdminKey, async (req, res) => {
  const { reference } = req.body || {};
  if (!reference) return res.status(400).json({ ok: false, error: 'reference is required' });
  try {
    const purchase = await findPurchaseByRef(reference);
    if (!purchase) return res.status(404).json({ ok: false, error: 'No purchase found for that reference' });
    const email = purchase['Email'];
    if (!email) return res.status(404).json({ ok: false, error: 'Purchase has no email on record' });
    let trackName = 'your track';
    try {
      const t = await fetchTrackRecord(purchase['TrackRecordID']);
      if (t) trackName = t['Track Name'] || t['Title'] || t['Song Name'] || trackName;
    } catch { /* name is garnish */ }
    await sendDownloadLinkEmail(email, trackName, reference);
    console.log(`[DOWNLOAD] Resend: link email for ref=${reference} → ${email}`);
    return res.json({ ok: true, sentTo: email, trackName });
  } catch (err) {
    console.error('[DOWNLOAD] Resend error:', err.message);
    return res.status(500).json({ ok: false, error: 'Could not resend the email' });
  }
});

// ── Webhook handler (called from payments.js) ─────────────────────────────────

export async function handleDownloadWebhook(paymentData, reference) {
  const metadata = paymentData.metadata || {};
  const { trackId, trackName, price } = metadata;
  const email = paymentData.customer?.email || '';

  // A basket pays once for several tracks. The webhook is the safety net for
  // when the buyer never returns to the browser, so it must fulfil baskets too
  // — recordBasket is idempotent, so a callback that already ran costs nothing.
  if (metadata.payment_type === 'download_basket') {
    const { created, items } = await recordBasket(metadata, reference, email);
    console.log(`[DOWNLOAD] Webhook: basket ref=${reference} — ${created} of ${items.length} written`);
    return;
  }

  if (!trackId) {
    console.warn('[DOWNLOAD] Webhook: missing trackId in metadata');
    return;
  }

  const existing = await findPurchaseByRef(reference);
  if (existing) {
    console.log(`[DOWNLOAD] Webhook: purchase already recorded ref=${reference}`);
    return;
  }

  await fmCreateRecord(FM_DOWNLOADS_LAYOUT, {
    TrackRecordID:      trackId,
    Amount_Paid:        price || 0,
    Currency:           'ZAR',
    Paystack_Reference: reference,
    Email:              email,
    Status:             'complete'
  });
  console.log(`[DOWNLOAD] Webhook: purchase recorded "${trackName}" ref=${reference}`);
  sendDownloadLinkEmail(email, trackName, reference);   // fire-and-forget
}

export default router;
