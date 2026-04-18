/**
 * routes/telkom.js — Telkom PartnerHUB webhook endpoints
 *
 * Receives subscription lifecycle notifications from Telkom SDP and
 * manages access tokens + API_Users records accordingly.
 *
 * Endpoints:
 *   POST /api/telkom/subscription  — subscription status change notifications
 *   POST /api/telkom/billing       — billing event notifications
 */

import { Router } from 'express';
import { fmFindRecords, fmCreateRecord, fmUpdateRecord } from '../fm-client.js';
import { createAccessToken, findTelkomToken, disableSubscriptionToken } from '../lib/token-store.js';

const router = Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Generate a unique activation token code (reuses existing token generation).
 * Returns a 30-day access token tied to this MSISDN.
 */
async function createTelkomToken(msisdn, subscriptionId, nextBillingAt) {
  const billingDays = nextBillingAt
    ? Math.ceil((new Date(nextBillingAt) - new Date()) / (1000 * 60 * 60 * 24))
    : 30;

  const days  = Math.max(billingDays, 1);
  const notes = `Telkom subscription (msisdn: ${msisdn}, sub_id: ${subscriptionId})`;

  const token = await createAccessToken(days, notes, null, 'telkom');
  return token;
}

/**
 * Find or create an API_Users record for this MSISDN.
 * Returns the FileMaker recordId and current fieldData.
 */
async function findOrCreateUser(msisdn) {
  const layout = process.env.FM_USERS_LAYOUT || 'API_Users';

  try {
    const result = await fmFindRecords(layout, [{ 'msisdn': `==${msisdn}` }], { limit: 1 });
    if (result?.data?.length) {
      return { recordId: result.data[0].recordId, fields: result.data[0].fieldData };
    }
  } catch (err) {
    // No record found — create one below
  }

  // Create new user record for this Telkom subscriber
  const newRecord = await fmCreateRecord(layout, {
    'msisdn':            msisdn,
    'subscription_type': 'telkom',
    'telkom_status':     'PENDING',
    'CreatedAt':         new Date().toISOString()
  });

  return { recordId: newRecord.recordId, fields: { msisdn, subscription_type: 'telkom' } };
}

/**
 * Update the API_Users record with the latest Telkom subscription state.
 */
async function updateUserStatus(recordId, subscriptionId, status, nextBillingAt) {
  const layout = process.env.FM_USERS_LAYOUT || 'API_Users';
  const fields = {
    'telkom_subscription_id': String(subscriptionId),
    'telkom_status':           status
  };
  if (nextBillingAt) {
    // Store as date string FM can parse
    fields['next_billing_at'] = nextBillingAt.split('T')[0];
  }
  await fmUpdateRecord(layout, recordId, fields);
}

// ── Subscription Notification ─────────────────────────────────────────────────

/**
 * POST /api/telkom/subscription
 *
 * Telkom sends this when subscription status changes:
 * NEW_SUBSCRIPTION, ACTIVATED, SUSPENDED, CANCELLED, EXPIRED
 *
 * We must respond with 2xx. If we don't, Telkom retries every 30 min for 6 hours.
 * On NEW_SUBSCRIPTION we return an activation_link in the response body.
 */
router.post('/subscription', async (req, res) => {
  const body = req.body;

  console.log('[Telkom] Subscription notification received:', JSON.stringify(body));

  const {
    subscription_id,
    user_msisdn,
    status_name,
    next_billing_at,
    svc_name
  } = body;

  if (!user_msisdn || !subscription_id) {
    console.warn('[Telkom] Missing required fields in notification');
    return res.status(400).json({ ok: false, error: 'Missing user_msisdn or subscription_id' });
  }

  const msisdn = String(user_msisdn);
  const status = String(status_name || '').toUpperCase();

  try {
    // Find or create the API_Users record for this subscriber
    const { recordId, fields } = await findOrCreateUser(msisdn);

    if (status === 'ACTIVATED' || status === 'NEW_SUBSCRIPTION') {
      // Create a new access token valid until next billing date
      const token = await createTelkomToken(msisdn, subscription_id, next_billing_at);

      // Update API_Users with active status and token info
      await updateUserStatus(recordId, subscription_id, 'ACTIVE', next_billing_at);

      // Build the activation link — user clicks this to access MAD Streamer
      const baseUrl        = process.env.APP_BASE_URL || 'https://musicafricadirect.com';
      const activationLink = `${baseUrl}/activate?token=${token.code}&msisdn=${msisdn}`;

      console.log(`[Telkom] Activated subscriber ${msisdn} — token ${token.code}, link: ${activationLink}`);

      // Return activation link so Telkom can include it in their Welcome SMS
      return res.status(200).json({
        ok:              true,
        activation_link: activationLink,
        token_code:      token.code
      });
    }

    if (status === 'SUSPENDED') {
      await updateUserStatus(recordId, subscription_id, 'SUSPENDED', next_billing_at);

      // Disable their active token
      const existingToken = await findTelkomToken(msisdn);
      if (existingToken) {
        await disableSubscriptionToken(existingToken.code);
        console.log(`[Telkom] Suspended token ${existingToken.code} for ${msisdn}`);
      }

      return res.status(200).json({ ok: true, status: 'SUSPENDED' });
    }

    if (status === 'CANCELLED' || status === 'EXPIRED') {
      await updateUserStatus(recordId, subscription_id, status, null);

      const existingToken = await findTelkomToken(msisdn);
      if (existingToken) {
        await disableSubscriptionToken(existingToken.code);
        console.log(`[Telkom] Disabled token ${existingToken.code} for ${msisdn} (${status})`);
      }

      return res.status(200).json({ ok: true, status });
    }

    // Unknown status — acknowledge receipt so Telkom doesn't retry
    console.warn(`[Telkom] Unhandled status: ${status}`);
    return res.status(200).json({ ok: true, status: 'acknowledged' });

  } catch (err) {
    console.error('[Telkom] Error processing subscription notification:', err);
    // Still return 200 to prevent Telkom retry storm — log for manual review
    return res.status(200).json({ ok: true, status: 'queued' });
  }
});

// ── Billing Notification ──────────────────────────────────────────────────────

/**
 * POST /api/telkom/billing
 *
 * Telkom sends this on successful billing events (renewals).
 * We extend the subscriber's token to cover the new billing period.
 */
router.post('/billing', async (req, res) => {
  const body = req.body;

  console.log('[Telkom] Billing notification received:', JSON.stringify(body));

  const { user_msisdn, subscription_id, next_billing_at } = body;

  if (!user_msisdn) {
    return res.status(400).json({ ok: false, error: 'Missing user_msisdn' });
  }

  const msisdn = String(user_msisdn);

  try {
    const { recordId } = await findOrCreateUser(msisdn);

    // Update next billing date on user record
    await updateUserStatus(recordId, subscription_id, 'ACTIVE', next_billing_at);

    // Extend their token to cover the new billing period
    const existingToken = await findTelkomToken(msisdn);
    if (existingToken && next_billing_at) {
      const newExpiry = new Date(next_billing_at);
      console.log(`[Telkom] Extending token ${existingToken.code} for ${msisdn} to ${newExpiry.toISOString()}`);
      // Token extension logic — update FM and cache
      const layout = process.env.FM_TOKENS_LAYOUT || 'API_Access_Tokens';
      const fmResult = await fmFindRecords(layout, [{ 'Token_Code': `==${existingToken.code}` }], { limit: 1 });
      if (fmResult?.data?.length) {
        const fmExp = `${newExpiry.getMonth() + 1}/${newExpiry.getDate()}/${newExpiry.getFullYear()} 00:00:00`;
        await fmUpdateRecord(layout, fmResult.data[0].recordId, { 'Expiration_Date': fmExp });
      }
    } else if (!existingToken) {
      // No token found — create a fresh one (recovery scenario)
      await createTelkomToken(msisdn, subscription_id, next_billing_at);
      console.log(`[Telkom] Created fresh token for ${msisdn} on renewal (no existing token found)`);
    }

    return res.status(200).json({ ok: true, status: 'renewed' });

  } catch (err) {
    console.error('[Telkom] Error processing billing notification:', err);
    return res.status(200).json({ ok: true, status: 'queued' });
  }
});

export default router;
