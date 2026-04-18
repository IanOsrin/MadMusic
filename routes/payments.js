import { Router } from 'express';
import { sendTokenEmail, sendSubscriptionWelcomeEmail, sendTrialEmail } from '../lib/email.js';
import {
  paystackRequest, verifyPaystackWebhook,
  PAYSTACK_PLANS, PAYSTACK_SUBSCRIPTION_PLAN, SUBSCRIPTION_INTERVAL_DAYS,
  getSubscriptionPlanAmount
} from '../lib/paystack.js';
import { handleDownloadWebhook } from './download.js';
import {
  createAccessToken,
  createSubscriptionToken, renewSubscriptionToken,
  disableSubscriptionToken, findSubscriptionToken,
  findTrialTokenByEmail
} from '../lib/token-store.js';
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

// Subscription plan details (used by the UI to show the subscription option)
router.get('/subscription-plan', (req, res) => {
  res.json({
    ok: true,
    plan: {
      code:     PAYSTACK_SUBSCRIPTION_PLAN.code,
      label:    PAYSTACK_SUBSCRIPTION_PLAN.label,
      interval: PAYSTACK_SUBSCRIPTION_PLAN.interval,
      display:  PAYSTACK_SUBSCRIPTION_PLAN.display
    }
  });
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

    const paystackPayload = {
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
    };
    console.log(`[MASS] Paystack initialize payload:`, JSON.stringify(paystackPayload));

    const data = await paystackRequest('POST', '/transaction/initialize', paystackPayload);

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

// ── Free trial ────────────────────────────────────────────────────────────────
// Issues a 7-day trial token directly — no payment required.
const TRIAL_DAYS = 7;

router.post('/trial', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return res.status(400).json({ ok: false, error: 'Valid email is required' });
    }

    const normalisedEmail = email.trim().toLowerCase();

    const existing = await findTrialTokenByEmail(normalisedEmail);
    if (existing) {
      console.log(`[MASS] Trial blocked — already issued to ${normalisedEmail}`);
      return res.status(409).json({ ok: false, error: 'A free trial has already been used for this email address.' });
    }

    const token = await createAccessToken(TRIAL_DAYS, '7-day free trial', normalisedEmail, 'trial');

    // Fire-and-forget — don't block the response on email delivery
    sendTrialEmail(normalisedEmail, token.code);

    console.log(`[MASS] Trial token issued: ${token.code} → ${normalisedEmail}`);
    res.json({ ok: true, token: token.code });
  } catch (err) {
    console.error('[MASS] Trial token creation failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to create trial token' });
  }
});

// ── Subscription checkout ─────────────────────────────────────────────────────
// Initialises a Paystack subscription checkout (uses plan code, not amount).
router.post('/subscribe', async (req, res) => {
  try {
    const { email, source } = req.body;

    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return res.status(400).json({ ok: false, error: 'Valid email is required' });
    }

    const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || '';
    if (!PAYSTACK_SECRET_KEY) {
      return res.status(503).json({ ok: false, error: 'Payment system not configured' });
    }

    const APP_BASE    = (process.env.APP_URL || '').replace(/\/$/, '');
    const callbackBase = APP_BASE
      ? `${APP_BASE}/api/payments/callback`
      : `${req.protocol}://${req.get('host')}/api/payments/callback`;
    const callbackUrl = `${callbackBase}?source=${source === 'mobile' ? 'mobile' : 'desktop'}&type=subscription`;

    const planAmount = await getSubscriptionPlanAmount();

    const paystackPayload = {
      email:        email.trim().toLowerCase(),
      amount:       planAmount,
      plan:         PAYSTACK_SUBSCRIPTION_PLAN.code,
      callback_url: callbackUrl,
      metadata: {
        payment_type: 'subscription',
        plan_code:    PAYSTACK_SUBSCRIPTION_PLAN.code,
        source:       source === 'mobile' ? 'mobile' : 'desktop'
      }
    };

    console.log(`[MASS] Subscription initialize payload:`, JSON.stringify(paystackPayload));
    const data = await paystackRequest('POST', '/transaction/initialize', paystackPayload);

    console.log(`[MASS] Subscription checkout initialized: ${data.data.reference} (${email})`);
    res.json({
      ok: true,
      authorization_url: data.data.authorization_url,
      reference:         data.data.reference
    });
  } catch (err) {
    console.error('[MASS] Subscription initialization failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to initialize subscription' });
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

    const metadata   = data.data.metadata || {};
    const email      = data.data.customer?.email || 'unknown';
    const isSubscription = metadata.payment_type === 'subscription' || !!data.data.plan;

    let token;

    if (isSubscription) {
      // ── Subscription payment ──────────────────────────────────────────────
      const subscriptionCode = data.data.subscription_code || null;
      const planCode         = data.data.plan || PAYSTACK_SUBSCRIPTION_PLAN.code;
      const interval         = data.data.plan_object?.interval || 'monthly';
      const billingDays      = SUBSCRIPTION_INTERVAL_DAYS[interval] || 31;

      // If the subscription_code is already in the system (webhook beat the callback), reuse the token
      let existing = subscriptionCode ? await findSubscriptionToken(subscriptionCode) : null;
      if (existing) {
        token = existing;
        console.log(`[MASS] Subscription callback: token already exists for sub ${subscriptionCode}`);
      } else {
        token = await createSubscriptionToken(subscriptionCode, planCode, email, billingDays);
        try {
          await sendSubscriptionWelcomeEmail(email, token.code, PAYSTACK_SUBSCRIPTION_PLAN.label);
        } catch (err) {
          console.error(`[MASS] ⚠️  SUBSCRIPTION EMAIL FAILED. ref=${reference} token=${token.code} email=${email} error=${err?.message || err}`);
        }
      }
      console.log(`[MASS] Subscription checkout complete: ${reference} → token ${token.code}`);
    } else {
      // ── One-time purchase ─────────────────────────────────────────────────
      const planId = metadata.plan_id;
      const days   = Number.parseInt(metadata.days, 10) || 7;
      token = await createAccessToken(days, `Paystack purchase: ${planId} (${email}, ref: ${reference})`, email);
      try {
        await sendTokenEmail(email, token.code, days);
      } catch (err) {
        console.error(`[MASS] ⚠️  TOKEN EMAIL FAILED. ref=${reference} token=${token.code} email=${email} error=${err?.message || err}`);
      }
      console.log(`[MASS] Payment successful: ${reference} → token ${token.code} (${days} days)`);
    }

    pendingPayments.set(reference, {
      tokenCode: token.code,
      timestamp: Date.now()
    });

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

    const eventType = event.event;

    // ── subscription.create ───────────────────────────────────────────────────
    if (eventType === 'subscription.create') {
      const sub   = event.data;
      const subscriptionCode = sub.subscription_code;
      const planCode         = sub.plan?.plan_code || PAYSTACK_SUBSCRIPTION_PLAN.code;
      const email            = sub.customer?.email || 'unknown';
      const interval         = sub.plan?.interval  || 'monthly';
      const billingDays      = SUBSCRIPTION_INTERVAL_DAYS[interval] || 31;

      // Idempotent — callback may have already created it
      const existing = await findSubscriptionToken(subscriptionCode);
      if (existing) {
        console.log(`[MASS] Webhook subscription.create: token already exists for sub ${subscriptionCode}`);
        return res.sendStatus(200);
      }

      const token = await createSubscriptionToken(subscriptionCode, planCode, email, billingDays);
      try {
        await sendSubscriptionWelcomeEmail(email, token.code, PAYSTACK_SUBSCRIPTION_PLAN.label);
      } catch (err) {
        console.error(`[MASS] ⚠️  SUBSCRIPTION EMAIL FAILED. sub=${subscriptionCode} token=${token.code} email=${email} error=${err?.message || err}`);
      }
      console.log(`[MASS] Webhook subscription.create: token ${token.code} created for sub ${subscriptionCode}`);
      return res.sendStatus(200);
    }

    // ── subscription.disable (cancelled or all retries exhausted) ─────────────
    if (eventType === 'subscription.disable') {
      const subscriptionCode = event.data?.subscription_code;
      if (subscriptionCode) {
        await disableSubscriptionToken(subscriptionCode, 3); // 3-day grace period
        console.log(`[MASS] Webhook subscription.disable: grace period set for sub ${subscriptionCode}`);
      }
      return res.sendStatus(200);
    }

    // ── charge.success ────────────────────────────────────────────────────────
    if (eventType !== 'charge.success') {
      return res.sendStatus(200); // Unhandled event type — ack and ignore
    }

    const paymentData      = event.data;
    const reference        = paymentData.reference;
    const subscriptionCode = paymentData.subscription_code || null;

    if (!reference) {
      console.warn('[MASS] Paystack webhook missing reference');
      return res.sendStatus(200);
    }

    // Subscription renewal: charge.success with a subscription_code
    if (subscriptionCode) {
      const existing = await findSubscriptionToken(subscriptionCode);
      if (existing) {
        // Renewal — extend expiry
        const interval    = paymentData.plan_object?.interval || 'monthly';
        const billingDays = SUBSCRIPTION_INTERVAL_DAYS[interval] || 31;
        await renewSubscriptionToken(subscriptionCode, billingDays);
        pendingPayments.set(reference, { tokenCode: existing.code, timestamp: Date.now() });
        console.log(`[MASS] Webhook charge.success (renewal): sub ${subscriptionCode} extended by ${billingDays} days`);
      } else {
        // First charge for this subscription — create token (fallback if subscription.create fires late)
        const planCode    = paymentData.plan || PAYSTACK_SUBSCRIPTION_PLAN.code;
        const email       = paymentData.customer?.email || 'unknown';
        const interval    = paymentData.plan_object?.interval || 'monthly';
        const billingDays = SUBSCRIPTION_INTERVAL_DAYS[interval] || 31;
        if (!pendingPayments.has(reference)) {
          const token = await createSubscriptionToken(subscriptionCode, planCode, email, billingDays);
          try {
            await sendSubscriptionWelcomeEmail(email, token.code, PAYSTACK_SUBSCRIPTION_PLAN.label);
          } catch (err) {
            console.error(`[MASS] ⚠️  SUBSCRIPTION EMAIL FAILED. sub=${subscriptionCode} token=${token.code} error=${err?.message || err}`);
          }
          pendingPayments.set(reference, { tokenCode: token.code, timestamp: Date.now() });
          console.log(`[MASS] Webhook charge.success (new sub): token ${token.code} for sub ${subscriptionCode}`);
        }
      }
      return res.sendStatus(200);
    }

    // One-time charge.success (no subscription_code)
    if (pendingPayments.has(reference)) {
      console.log(`[MASS] Webhook: payment ${reference} already processed via callback`);
      return res.sendStatus(200);
    }

    const metadata = paymentData.metadata || {};

    // ── Download purchase ─────────────────────────────────────────────────────
    if (metadata.payment_type === 'download') {
      await handleDownloadWebhook(paymentData, reference);
      return res.sendStatus(200);
    }

    const days   = Number.parseInt(metadata.days, 10) || 7;
    const email  = paymentData.customer?.email || 'unknown';
    const planId = metadata.plan_id || 'unknown';

    const token = await createAccessToken(days, `Paystack webhook: ${planId} (${email}, ref: ${reference})`, email);

    try {
      await sendTokenEmail(email, token.code, days);
    } catch (err) {
      console.error(`[MASS] ⚠️  TOKEN EMAIL FAILED. ref=${reference} token=${token.code} email=${email} error=${err?.message || err}`);
    }

    pendingPayments.set(reference, { tokenCode: token.code, timestamp: Date.now() });
    console.log(`[MASS] Webhook: payment ${reference} → token ${token.code} (${days} days)`);
  } catch (err) {
    console.error('[MASS] Paystack webhook error:', err);
    res.sendStatus(500);
  }
});

export default router;
