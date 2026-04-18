/**
 * routes/ringtone.js — Ringtone purchase payment flow (R5 via Paystack).
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

const router = Router();

const RINGTONE_PRICE_ZAR   = 5;
const RINGTONE_PRICE_CENTS = 500; // Paystack uses cents (ZAR)

const FM_RINGTONE_LAYOUT =
  process.env.FM_RINGTONE_LAYOUT ||
  process.env.FM_DOWNLOADS_LAYOUT ||
  'API_Ringtone_Purchases';

// ── Helpers ──────────────────────────────────────────────────────────────────

async function findRingtonePurchase(reference) {
  try {
    const result = await fmFindRecords(FM_RINGTONE_LAYOUT, [
      { Paystack_Reference: `==${reference}`, Status: 'complete' }
    ], { limit: 1 });
    if (!result.ok || !result.data?.length) return null;
    return result.data[0].fieldData;
  } catch {
    return null;
  }
}

// ── POST /api/ringtone/initiate ───────────────────────────────────────────────

router.post('/initiate', async (req, res) => {
  const { src, name, artist, artwork, startSec, durationSec, email } = req.body;

  if (!email || typeof email !== 'string' || !email.includes('@')) {
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

    // Redirect back to the ringtone page with paid reference + all original params
    const params = new URLSearchParams();
    params.set('paid',   reference);
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
    return res.json({ ok: true, valid: true });
  } catch (err) {
    console.error('[RINGTONE] Verify error:', err.message);
    return res.status(500).json({ ok: false, error: 'Verification failed' });
  }
});

export default router;
