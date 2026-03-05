import express from 'express';
import { Router } from 'express';
import { createHmac } from 'node:crypto';
import { sendTokenEmail, paystackRequest, verifyPaystackWebhook } from '../helpers.js';
import { createAccessToken } from '../store.js';
import { pendingPaymentsCache } from '../cache.js';

const router = Router();

const PAYSTACK_PLANS = {
  '1-day':  { amount: 500,   label: '1 Day Access',  days: 1,  display: 'R5' },
  '7-day':  { amount: 2000,  label: '7 Day Access',  days: 7,  display: 'R20' },
  '30-day': { amount: 5000,  label: '30 Day Access', days: 30, display: 'R50' }
};

const pendingPayments = pendingPaymentsCache;

router.get('/plans', (req, res) => {
  const plans = Object.entries(PAYSTACK_PLANS).map(([key, plan]) => ({
    id: key,
    label: plan.label,
    days: plan.days,
    display: plan.display,
    amount: plan.amount
  }));
  res.json({ ok: true, plans });
});

router.post('/initialize', async (req, res) => {
  try {
    const { email, plan } = req.body;

    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return res.status(400).json({ ok: false, error: 'Valid email is required' });
    }

    const selectedPlan = PAYSTACK_PLANS[plan];
    if (!selectedPlan) {
      return res.status(400).json({ ok: false, error: 'Invalid plan. Choose: 1-day, 7-day, or 30-day' });
    }

    const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || '';
    if (!PAYSTACK_SECRET_KEY) {
      return res.status(503).json({ ok: false, error: 'Payment system not configured' });
    }

    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const callbackUrl = `${protocol}://${host}/api/payments/callback`;

    const data = await paystackRequest('POST', '/transaction/initialize', {
      email: email.trim().toLowerCase(),
      amount: selectedPlan.amount,
      currency: 'ZAR',
      callback_url: callbackUrl,
      metadata: {
        plan_id: plan,
        plan_label: selectedPlan.label,
        days: selectedPlan.days
      }
    });

    console.log(`[MASS] Payment initialized: ${data.data.reference} (${plan}, ${email})`);

    res.json({
      ok: true,
      authorization_url: data.data.authorization_url,
      reference: data.data.reference
    });
  } catch (err) {
    console.error('[MASS] Payment initialization failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to initialize payment' });
  }
});

router.get('/callback', async (req, res) => {
  const { reference } = req.query;

  if (!reference) {
    return res.redirect('/?payment=error&reason=missing_reference');
  }

  try {
    if (pendingPayments.has(reference)) {
      const existing = pendingPayments.get(reference);
      console.log(`[MASS] Payment callback duplicate for ${reference}, returning existing token ${existing.tokenCode}`);
      return res.redirect(`/?payment=success&token=${encodeURIComponent(existing.tokenCode)}`);
    }

    const data = await paystackRequest('GET', `/transaction/verify/${encodeURIComponent(reference)}`);

    if (!data.data || data.data.status !== 'success') {
      console.warn(`[MASS] Payment verification failed for ${reference}: status=${data.data?.status}`);
      return res.redirect(`/?payment=failed&reason=not_successful`);
    }

    if (pendingPayments.has(reference)) {
      const existing = pendingPayments.get(reference);
      return res.redirect(`/?payment=success&token=${encodeURIComponent(existing.tokenCode)}`);
    }

    const metadata = data.data.metadata || {};
    const planId = metadata.plan_id;
    const days = parseInt(metadata.days) || 7;
    const email = data.data.customer?.email || 'unknown';

    const token = await createAccessToken(days, `Paystack purchase: ${planId} (${email}, ref: ${reference})`, email);

    sendTokenEmail(email, token.code, days);

    pendingPayments.set(reference, {
      tokenCode: token.code,
      timestamp: Date.now()
    });

    console.log(`[MASS] Payment successful: ${reference} → token ${token.code} (${days} days)`);

    res.redirect(`/?payment=success&token=${encodeURIComponent(token.code)}`);
  } catch (err) {
    console.error(`[MASS] Payment callback error for ${reference}:`, err);
    res.redirect(`/?payment=error&reason=verification_failed`);
  }
});

router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const rawBody = req.body;
    const signature = req.headers['x-paystack-signature'];

    if (!verifyPaystackWebhook(rawBody, signature)) {
      console.warn('[MASS] Paystack webhook signature verification failed');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const event = JSON.parse(rawBody.toString());

    if (event.event !== 'charge.success') {
      return res.sendStatus(200);
    }

    const paymentData = event.data;
    const reference = paymentData.reference;

    if (!reference) {
      console.warn('[MASS] Paystack webhook missing reference');
      return res.sendStatus(200);
    }

    if (pendingPayments.has(reference)) {
      console.log(`[MASS] Webhook: payment ${reference} already processed via callback`);
      return res.sendStatus(200);
    }

    const metadata = paymentData.metadata || {};
    const days = parseInt(metadata.days) || 7;
    const email = paymentData.customer?.email || 'unknown';
    const planId = metadata.plan_id || 'unknown';

    const token = await createAccessToken(days, `Paystack webhook: ${planId} (${email}, ref: ${reference})`, email);

    sendTokenEmail(email, token.code, days);

    pendingPayments.set(reference, {
      tokenCode: token.code,
      timestamp: Date.now()
    });

    console.log(`[MASS] Webhook: payment ${reference} → token ${token.code} (${days} days)`);

    res.sendStatus(200);
  } catch (err) {
    console.error('[MASS] Paystack webhook error:', err);
    res.sendStatus(500);
  }
});

export default router;
