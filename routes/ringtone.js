/**
 * routes/ringtone.js — Ringtone purchase payment flow (R1.50 via Paystack).
 *
 * POST /api/ringtone/initiate   { src, name, artist, artwork, startSec, durationSec, email }
 *                               → { ok, authorization_url, reference }
 *
 * GET  /api/ringtone/callback   ?reference=
 *                               → verify Paystack, record in FM, redirect to /ringtone?paid=REF&...
 *
 * GET  /api/ringtone/verify     ?ref=
 *                               → { ok, valid } — called by the frontend after redirect
 *
 * FM layout: FM_RINGTONE_LAYOUT env var (defaults to FM_DOWNLOADS_LAYOUT, then
 * 'API_Ringtone_Purchases').  Fields expected: Paystack_Reference, Email,
 * Amount_Paid, Currency, Status, TrackRecordID.
 */

import { Router } from 'express';
import { fmCreateRecord, fmFindRecords } from '../fm-client.js';
import { paystackRequest } from '../lib/paystack.js';
import { isStrictEmail, fmExactMatch } from '../lib/validators.js';

const router = Router();

const RINGTONE_PRICE_ZAR   = 1.5;
const RINGTONE_PRICE_CENTS = 150; // Paystack uses cents (ZAR)

const FM_RINGTONE_LAYOUT =
  process.env.FM_RINGTONE_LAYOUT ||
  process.env.FM_DOWNLOADS_LAYOUT ||
  'API_Ringtone_Purchases';

// How long a purchase reference can be used to verify the ringtone. Defends
// against a leaked `ref` (it rides in URLs) being replayed indefinitely.
const DOWNLOAD_LINK_TTL_HOURS = Number.parseFloat(process.env.DOWNLOAD_LINK_TTL_HOURS || '48') || 48;

// ── Helpers ──────────────────────────────────────────────────────────────────

async function findRingtonePurchase(reference) {
  try {
    const result = await fmFindRecords(FM_RINGTONE_LAYOUT, [
      { Paystack_Reference: fmExactMatch(reference), Status: 'complete' }
    ], { limit: 1 });
    if (!result.ok || !result.data?.length) return null;
    return result.data[0].fieldData;
  } catch {
    return null;
  }
}

// Candidate timestamp fields on the purchase record. The FM map does not document
// an explicit Created/Paid field on API_Ringtone_Purchases, so we probe the common
// names. Returns ms-epoch or null if none is present/parseable.
const PURCHASE_TS_FIELD_CANDIDATES = [
  'Created', 'Created_At', 'CreatedTimestamp', 'Creation_Timestamp',
  'Date_Created', 'Timestamp', 'Paid_At', 'Paid', 'Purchase_Date', 'Date'
];

// Reject a leaked/replayed ref once the purchase is older than the TTL window.
// Guarded: if no timestamp field is present/parseable we log and ALLOW so a
// schema gap never blocks a legitimate verification. TODO: confirm the actual
// timestamp field name on API_Ringtone_Purchases and pin it here.
function isPurchaseFresh(fieldData) {
  for (const field of PURCHASE_TS_FIELD_CANDIDATES) {
    const raw = fieldData?.[field];
    if (raw === undefined || raw === null || raw === '') continue;
    const ms = Date.parse(String(raw));
    if (Number.isFinite(ms)) {
      const ageHours = (Date.now() - ms) / (60 * 60 * 1000);
      return ageHours <= DOWNLOAD_LINK_TTL_HOURS;
    }
  }
  console.warn('[RINGTONE] No parseable purchase timestamp — skipping recency check (allowing verify)');
  return true;
}

// ── POST /api/ringtone/initiate ───────────────────────────────────────────────

router.post('/initiate', async (req, res) => {
  const { src, name, artist, artwork, startSec, durationSec, email } = req.body;

  if (!isStrictEmail(email)) {
    return res.status(400).json({ ok: false, error: 'Valid email address required' });
  }
  if (!src || typeof src !== 'string') {
    return res.status(400).json({ ok: false, error: 'Audio source required' });
  }

  const clampedStart = Math.max(0, Number(startSec) || 0);
  const clampedDur   = Math.min(30, Math.max(1, Number(durationSec) || 30));

  try {
    const APP_BASE    = (process.env.APP_URL || '').replace(/\/$/, '');
    const callbackUrl = APP_BASE
      ? `${APP_BASE}/api/ringtone/callback`
      : `${req.protocol}://${req.get('host')}/api/ringtone/callback`;

    const data = await paystackRequest('POST', '/transaction/initialize', {
      email:        email.trim().toLowerCase(),
      amount:       RINGTONE_PRICE_CENTS,
      currency:     'ZAR',
      callback_url: callbackUrl,
      metadata: {
        payment_type: 'ringtone',
        src,
        name:        name    || '',
        artist:      artist  || '',
        artwork:     artwork || '',
        startSec:    clampedStart,
        durationSec: clampedDur
      }
    });

    console.log(`[RINGTONE] Payment initiated: ${data.data.reference} — "${name}" for ${email}`);
    return res.json({
      ok:                true,
      authorization_url: data.data.authorization_url,
      reference:         data.data.reference
    });
  } catch (err) {
    console.error('[RINGTONE] Initiate error:', err.message);
    return res.status(500).json({ ok: false, error: 'Failed to initialize payment' });
  }
});

// ── GET /api/ringtone/callback ────────────────────────────────────────────────

router.get('/callback', async (req, res) => {
  const { reference } = req.query;
  if (!reference) return res.redirect('/ringtone?error=missing_reference');

  try {
    const data     = await paystackRequest('GET', `/transaction/verify/${encodeURIComponent(reference)}`);
    const tx       = data.data;
    const metadata = tx?.metadata || {};

    if (tx?.status !== 'success' || metadata.payment_type !== 'ringtone') {
      console.warn(`[RINGTONE] Callback: unexpected status/type for ${reference}`);
      return res.redirect('/ringtone?error=payment_failed');
    }

    const email      = tx.customer?.email || '';
    const { src, name, artist, artwork, startSec, durationSec } = metadata;

    // Idempotent — only write once
    const existing = await findRingtonePurchase(reference);
    if (!existing) {
      try {
        await fmCreateRecord(FM_RINGTONE_LAYOUT, {
          Paystack_Reference: reference,
          Email:              email,
          Amount_Paid:        RINGTONE_PRICE_ZAR,
          Currency:           'ZAR',
          Status:             'complete',
          TrackRecordID:      name || '' // track name for record-keeping
        });
        console.log(`[RINGTONE] Purchase recorded: "${name}" ref=${reference} email=${email}`);
      } catch (fmErr) {
        // FM write failure is non-fatal — log and proceed so the user gets their download
        console.error('[RINGTONE] FM record write failed (non-fatal):', fmErr.message);
      }
    }

    // Redirect back to the ringtone page with the original params. Do NOT include
    // the Paystack reference — it is a replayable bearer token for /verify.
    const params = new URLSearchParams();
    params.set('download', 'success');
    params.set('src',    src    || '');
    params.set('name',   name   || '');
    params.set('artist', artist || '');
    if (artwork) params.set('artwork', artwork);
    params.set('start', String(Number(startSec)    || 0));
    params.set('dur',   String(Number(durationSec) || 30));

    return res.redirect(`/ringtone?${params.toString()}`);
  } catch (err) {
    console.error('[RINGTONE] Callback error:', err.message);
    return res.redirect('/ringtone?error=server_error');
  }
});

// ── GET /api/ringtone/verify ──────────────────────────────────────────────────

router.get('/verify', async (req, res) => {
  const { ref } = req.query;
  if (!ref) return res.status(400).json({ ok: false, error: 'ref required' });

  try {
    const purchase = await findRingtonePurchase(ref);
    if (!purchase) {
      return res.status(403).json({ ok: false, valid: false, error: 'No valid purchase found' });
    }
    // Reject stale/leaked references — a verify link is only valid for a window.
    if (!isPurchaseFresh(purchase)) {
      return res.status(403).json({ ok: false, valid: false, error: 'This link has expired' });
    }
    return res.json({ ok: true, valid: true });
  } catch (err) {
    console.error('[RINGTONE] Verify error:', err.message);
    return res.status(500).json({ ok: false, error: 'Verification failed' });
  }
});

export default router;
