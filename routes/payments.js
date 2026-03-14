import { Router } from 'express';
import { sendTokenEmail } from '../lib/email.js';
import { paystackRequest, verifyPaystackWebhook, PAYSTACK_PLANS } from '../lib/paystack.js';
import { createAccessToken } from '../store.js';
import { pendingPaymentsCache } from '../cache.js';

const router = Router();

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
    const { email, plan, source } = req.body;

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

    // Use APP_URL from env to avoid host-header injection via X-Forwarded-Host.
    // Fall back to Express's req.protocol + req.get('host'), which already
    // respects the trust-proxy setting configured in server.js.
    const APP_BASE = (process.env.APP_URL || '').replace(/\/$/, '');
    const callbackBase = APP_BASE
      ? `${APP_BASE}/api/payments/callback`
      : `${req.protocol}://${req.get('host')}/api/payments/callback`;
    const callbackUrl = source === 'mobile'
      ? `${callbackBase}?source=mobile`
      : callbackBase;

    const data = await paystackRequest('POST', '/transaction/initialize', {
      email: email.trim().toLowerCase(),
      amount: selectedPlan.amount,
      currency: 'ZAR',
      callback_url: callbackUrl,
      metadata: {
        plan_id: plan,
        plan_label: selectedPlan.label,
        days: selectedPlan.days,
        source: source === 'mobile' ? 'mobile' : 'desktop'
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

  // Detect mobile source from a query param passed through the Paystack flow
  // (Paystack preserves query params on the callback_url)
  const mobileCallback = req.query.source === 'mobile';

  if (!reference) {
    return res.redirect(`${mobileCallback ? '/mobile.html' : '/'}?payment=error&reason=missing_reference`);
  }

  try {
    const existing = pendingPayments.get(reference);
    if (existing) {
      const base = mobileCallback ? '/mobile.html' : '/';
      if (existing.processing) {
        console.log(`[MASS] Payment callback already in progress for ${reference}, redirecting to pending`);
        return res.redirect(`${base}?payment=pending&reason=processing`);
      }
      console.log(`[MASS] Payment callback duplicate for ${reference}, returning existing token ${existing.tokenCode}`);
      return res.redirect(`${base}?payment=success&token=${encodeURIComponent(existing.tokenCode)}`);
    }

    // Mark as in-progress immediately to block concurrent requests for the same reference
    pendingPayments.set(reference, { processing: true, timestamp: Date.now() });

    const data = await paystackRequest('GET', `/transaction/verify/${encodeURIComponent(reference)}`);

    if (data.data?.status !== 'success') {
      pendingPayments.delete(reference);
      console.warn(`[MASS] Payment verification failed for ${reference}: status=${data.data?.status}`);
      return res.redirect(`${mobileCallback ? '/mobile.html' : '/'}?payment=failed&reason=not_successful`);
    }

    const metadata = data.data.metadata || {};
    const planId = metadata.plan_id;
    const days = Number.parseInt(metadata.days) || 7;
    const email = data.data.customer?.email || 'unknown';

    const token = await createAccessToken(days, `Paystack purchase: ${planId} (${email}, ref: ${reference})`, email);

    sendTokenEmail(email, token.code, days)?.catch(err => {
      console.error(`[MASS] ⚠️  TOKEN EMAIL FAILED — customer may not have received token. ref=${reference} token=${token.code} email=${email} error=${err?.message || err}`);
    });

    pendingPayments.set(reference, {
      tokenCode: token.code,
      timestamp: Date.now()
    });

    console.log(`[MASS] Payment successful: ${reference} → token ${token.code} (${days} days)`);

    const successBase = mobileCallback ? '/mobile.html' : '/';
    res.redirect(`${successBase}?payment=success&token=${encodeURIComponent(token.code)}`);
  } catch (err) {
    console.error(`[MASS] Payment callback error for ${reference}:`, err);
    res.redirect(`${mobileCallback ? '/mobile.html' : '/'}?payment=error&reason=verification_failed`);
  }
});

// Note: raw body parsing for this route is handled globally in server.js
// (app.use('/api/payments/webhook', express.raw(...))), so no need to repeat it here.
router.post('/webhook', async (req, res) => {
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
    const days = Number.parseInt(metadata.days) || 7;
    const email = paymentData.customer?.email || 'unknown';
    const planId = metadata.plan_id || 'unknown';

    const token = await createAccessToken(days, `Paystack webhook: ${planId} (${email}, ref: ${reference})`, email);

    sendTokenEmail(email, token.code, days)?.catch(err => {
      console.error(`[MASS] ⚠️  TOKEN EMAIL FAILED — customer may not have received token. ref=${reference} token=${token.code} email=${email} error=${err?.message || err}`);
    });

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
