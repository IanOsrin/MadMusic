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
import {
  fmFindRecords,
  fmCreateRecord,
  fmGetRecordById,
  safeFetch
} from '../fm-client.js';
import {
  FM_LAYOUT,
  AUDIO_FIELD_CANDIDATES
} from '../lib/fm-fields.js';
import { paystackRequest } from '../lib/paystack.js';

const router = Router();

const FM_DOWNLOADS_LAYOUT = process.env.FM_DOWNLOADS_LAYOUT || 'API_Download_Purchases';

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolveAudioUrl(fieldData) {
  for (const field of AUDIO_FIELD_CANDIDATES) {
    const val = fieldData?.[field];
    if (val && typeof val === 'string' && val.startsWith('http')) return val;
  }
  return null;
}

async function findPurchaseByRef(reference) {
  const result = await fmFindRecords(FM_DOWNLOADS_LAYOUT, [
    { Paystack_Reference: `==${reference}`, Status: 'complete' }
  ], { limit: 1 });
  if (!result.ok || result.data.length === 0) return null;
  return result.data[0].fieldData;
}

async function fetchTrackRecord(recordId) {
  const record = await fmGetRecordById(FM_LAYOUT, recordId);
  if (!record) return null;
  return record.fieldData || null;
}

// ── POST /api/download/initiate ───────────────────────────────────────────────
// Body: { trackId, trackRecordId, email }

router.post('/initiate', async (req, res) => {
  const { trackId, trackRecordId, email } = req.body;

  if (!trackId || !trackRecordId || !email || !email.includes('@')) {
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

// ── GET /api/download/callback ────────────────────────────────────────────────

router.get('/callback', async (req, res) => {
  const { reference } = req.query;
  if (!reference) return res.redirect('/?download=error&reason=missing_reference');

  try {
    const data     = await paystackRequest('GET', `/transaction/verify/${encodeURIComponent(reference)}`);
    const tx       = data.data;
    const metadata = tx?.metadata || {};

    if (tx?.status !== 'success' || metadata.payment_type !== 'download') {
      console.warn(`[DOWNLOAD] Callback: unexpected status/type for ${reference}`);
      return res.redirect('/?download=error&reason=verification_failed');
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
    }

    return res.redirect(`/?download=success&ref=${encodeURIComponent(reference)}&name=${encodeURIComponent(trackName || '')}&recordId=${encodeURIComponent(trackRecordId || '')}`);
  } catch (err) {
    console.error('[DOWNLOAD] Callback error:', err.message);
    return res.redirect('/?download=error&reason=server_error');
  }
});

// ── GET /api/download/file ────────────────────────────────────────────────────
// ?ref=PAYSTACK_REFERENCE  — verified against FM purchase record

router.get('/file', async (req, res) => {
  const { ref } = req.query;
  if (!ref) return res.status(400).json({ ok: false, error: 'ref is required' });

  try {
    const purchase = await findPurchaseByRef(ref);
    if (!purchase) {
      return res.status(403).json({ ok: false, error: 'No valid purchase found for this reference' });
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

    console.log(`[DOWNLOAD] Serving "${filename}" ref=${ref}`);
    await pipeline(Readable.fromWeb(s3Res.body), res);
  } catch (err) {
    console.error('[DOWNLOAD] File serve error:', err.message);
    if (!res.headersSent) res.status(500).json({ ok: false, error: 'Download failed' });
  }
});

// ── Webhook handler (called from payments.js) ─────────────────────────────────

export async function handleDownloadWebhook(paymentData, reference) {
  const metadata = paymentData.metadata || {};
  const { trackId, trackRecordId, trackName, price } = metadata;
  const email = paymentData.customer?.email || '';

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
}

export default router;
