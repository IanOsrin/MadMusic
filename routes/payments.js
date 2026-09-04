import { Router } from 'express';
import { sendTokenEmail, sendSubscriptionWelcomeEmail, sendTrialEmail, emailTransporter } from '../lib/email.js';
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
  findTrialTokenByEmail, findTrialTokenInFM, revokeToken
} from '../lib/token-store.js';
import { wasAccountDeleted } from '../lib/account-delete.js';
import { pendingPaymentsCache, processedWebhookEventsCache } from '../cache.js';
import { isStrictEmail } from '../lib/validators.js';
import { bumpTaster } from '../lib/taster-stats.js';
import { SUBSCRIPTION_DAYS_MIN, SUBSCRIPTION_DAYS_MAX } from '../lib/constants.js';

const router = Router();

const pendingPayments = pendingPaymentsCache;
const processedWebhookEvents = processedWebhookEventsCache;

/**
 * Clamp a "days" value claimed by an external system (Paystack metadata,
 * Telkom callback, etc.) to a safe range. Anything outside the bounds is
 * coerced toward the fallback. Defends against forged or replayed metadata
 * minting absurdly long tokens.
 */
function clampDays(rawDays, fallback = 7) {
  const n = Number.parseInt(rawDays, 10);
  if (!Number.isFinite(n)) return fallback;
  if (n < SUBSCRIPTION_DAYS_MIN) return SUBSCRIPTION_DAYS_MIN;
  if (n > SUBSCRIPTION_DAYS_MAX) return SUBSCRIPTION_DAYS_MAX;
  return n;
}

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

    if (!isStrictEmail(email)) {
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
    const APP_BASE = (process.env.APP_URL || process.env.APP_BASE_URL || '').replace(/\/$/, '');
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
    // Don't log the full payload — it contains the customer email (PII).
    console.log(`[MASS] Paystack initialize: plan=${plan} amount=${selectedPlan.amount} source=${source === 'mobile' ? 'mobile' : 'desktop'}`);

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

// ABUSE FIX 2026-08-27: the token used to come back in the HTTP response, so
// the email was never verified — any invented address minted a fresh trial on
// screen. And the one-per-email check only read the JSON file, which does not
// survive every deploy, so even the SAME email could re-claim. Now: dedupe
// checks FileMaker (the durable memory) as well, and the token travels ONLY
// via the trial email — claiming a trial requires a mailbox you control.
router.post('/trial', async (req, res) => {
  try {
    const { email } = req.body;

    if (!isStrictEmail(email)) {
      return res.status(400).json({ ok: false, error: 'Valid email is required' });
    }

    const normalisedEmail = email.trim().toLowerCase();

    // Email-only delivery makes a working transporter a hard requirement —
    // refusing loudly beats minting tokens nobody can receive.
    if (!emailTransporter) {
      console.error('[MASS] Trial refused — email transporter not configured (EMAIL_USER/EMAIL_PASS)');
      return res.status(503).json({ ok: false, error: 'Trial signup is temporarily unavailable. Please try again later.' });
    }

    const existing = await findTrialTokenByEmail(normalisedEmail);
    if (existing) {
      console.log(`[MASS] Trial blocked (JSON) — already issued to ${normalisedEmail}`);
      return res.status(409).json({ ok: false, error: 'A free trial has already been used for this email address.' });
    }

    try {
      const inFM = await findTrialTokenInFM(normalisedEmail);
      if (inFM) {
        console.log(`[MASS] Trial blocked (FM) — already issued to ${normalisedEmail}`);
        return res.status(409).json({ ok: false, error: 'A free trial has already been used for this email address.' });
      }
      // Deleting an account scrubs the email off the token row, so the check
      // above can no longer see it — without this, "delete account, sign up
      // again" would be an unlimited trial generator. The row keeps a one-way
      // fingerprint of the mailbox for exactly this purpose.
      if (await wasAccountDeleted(normalisedEmail)) {
        console.log('[MASS] Trial blocked (deleted account fingerprint)');
        return res.status(409).json({ ok: false, error: 'A free trial has already been used for this email address.' });
      }
    } catch (err) {
      // FM outage: degrade to the JSON-only check rather than blocking signups.
      console.error('[MASS] FM trial-dedupe lookup failed — JSON-only check in effect:', err?.message || err);
    }

    const token = await createAccessToken(TRIAL_DAYS, '7-day free trial', normalisedEmail, 'trial');

    try {
      await sendTrialEmail(normalisedEmail, token.code);
    } catch (err) {
      // Undelivered token would block this email's retry forever — roll it back.
      await revokeToken(token.code, 'trial email delivery failed');
      return res.status(502).json({ ok: false, error: 'We could not send the email. Please check the address and try again.' });
    }

    console.log(`[MASS] Trial token issued: ${token.code} → ${normalisedEmail} (delivered by email)`);

    // Funnel attribution (optional, client-supplied): a trial that started from
    // a taster landing (/?t=… under a YouTube video) counts against its
    // campaign in the cookie-free stats. Fire-and-forget; never blocks.
    const via = req.body?.via;
    if (via && typeof via === 'object') {
      bumpTaster({ kind: 'trial', campaign: via.campaign, track: via.t }).catch(() => {});
    }

    // Deliberately NO token in the response.
    res.json({ ok: true, sent: true });
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

    if (!isStrictEmail(email)) {
      return res.status(400).json({ ok: false, error: 'Valid email is required' });
    }

    const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || '';
    if (!PAYSTACK_SECRET_KEY) {
      return res.status(503).json({ ok: false, error: 'Payment system not configured' });
    }

    const APP_BASE    = (process.env.APP_URL || process.env.APP_BASE_URL || '').replace(/\/$/, '');
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

    // Don't log the full payload — it contains the customer email (PII).
    console.log(`[MASS] Subscription initialize: plan=${PAYSTACK_SUBSCRIPTION_PLAN.code} amount=${planAmount} source=${source === 'mobile' ? 'mobile' : 'desktop'}`);
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

    const verifyStatus = data.data?.status;
    if (verifyStatus !== 'success') {
      pendingPayments.delete(reference);
      // Async bank authorization (e.g. FNB in-app approval) leaves the charge
      // 'pending'/'ongoing' when the browser returns — that is NOT a failure.
      // The webhook delivers the token once the bank confirms, so show "pending"
      // (and rely on the emailed token) rather than a false "failed".
      if (verifyStatus === 'pending' || verifyStatus === 'ongoing') {
        console.log(`[MASS] Payment ${reference} still ${verifyStatus} (awaiting bank auth) — webhook will finalise`);
        return res.redirect(`${mobileCallback ? '/mobile.html' : '/'}?payment=pending&reason=bank_auth`);
      }
      console.warn(`[MASS] Payment verification failed for ${reference}: status=${verifyStatus}`);
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
        // Fire-and-forget: never block the post-payment redirect on email.
        Promise.resolve(sendSubscriptionWelcomeEmail(email, token.code, PAYSTACK_SUBSCRIPTION_PLAN.label)).catch((err) =>
          console.error(`[MASS] ⚠️  SUBSCRIPTION EMAIL FAILED. ref=${reference} token=${token.code} email=${email} error=${err?.message || err}`));
      }
      console.log(`[MASS] Subscription checkout complete: ${reference} → token ${token.code}`);
    } else {
      // ── One-time purchase ─────────────────────────────────────────────────
      const planId = metadata.plan_id;
      const days   = clampDays(metadata.days, 7);
      token = await createAccessToken(days, `Paystack purchase: ${planId} (${email}, ref: ${reference})`, email);
      // Fire-and-forget: the token is already returned in the redirect URL, so a
      // slow/failing email must not delay or hang the user's return to the app.
      Promise.resolve(sendTokenEmail(email, token.code, days)).catch((err) =>
        console.error(`[MASS] ⚠️  TOKEN EMAIL FAILED. ref=${reference} token=${token.code} email=${email} error=${err?.message || err}`));
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

    // Defence-in-depth: if anything has parsed the body upstream (the global
    // express.json mount, or a future middleware misconfig), rawBody won't be
    // a Buffer/string and HMAC can't be computed over the original bytes.
    // Reject hard — never trust a webhook that we can't cryptographically
    // verify.
    if (!Buffer.isBuffer(rawBody) && typeof rawBody !== 'string') {
      console.error('[MASS] Paystack webhook: rawBody is not Buffer/string — likely a middleware ordering bug');
      return res.status(400).json({ error: 'Webhook body must be raw bytes' });
    }

    if (!verifyPaystackWebhook(rawBody, signature)) {
      console.warn('[MASS] Paystack webhook signature verification failed');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    let event;
    try {
      event = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody);
    } catch {
      console.warn('[MASS] Paystack webhook: signature verified but body is not valid JSON');
      return res.status(400).json({ error: 'Malformed JSON body' });
    }

    // ── Event-level idempotency ───────────────────────────────────────────────
    // Paystack retries unacknowledged webhooks for up to ~72h. We dedupe on
    // event.id (or fall back to event.event + data.reference + data.id when
    // the top-level id is missing on older shapes). Once we've successfully
    // processed an event, replays are a no-op.
    const eventKey =
      event.id ?? `${event.event || 'unknown'}::${event.data?.reference || ''}::${event.data?.id || ''}`;
    if (processedWebhookEvents.has(eventKey)) {
      console.log(`[MASS] Paystack webhook ${eventKey} already processed, acking`);
      return res.sendStatus(200);
    }

    const eventType = event.event;
    // Helper: mark this event as fully handled, then ack. Anything that
    // throws BEFORE ack() runs leaves the event un-marked, so Paystack will
    // retry. Anything that has ack()'d will be deduped on retry.
    const ack = () => {
      processedWebhookEvents.set(eventKey, { at: Date.now(), eventType });
      return res.sendStatus(200);
    };

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
        return ack();
      }

      const token = await createSubscriptionToken(subscriptionCode, planCode, email, billingDays);
      try {
        await sendSubscriptionWelcomeEmail(email, token.code, PAYSTACK_SUBSCRIPTION_PLAN.label);
      } catch (err) {
        console.error(`[MASS] ⚠️  SUBSCRIPTION EMAIL FAILED. sub=${subscriptionCode} token=${token.code} email=${email} error=${err?.message || err}`);
      }
      console.log(`[MASS] Webhook subscription.create: token ${token.code} created for sub ${subscriptionCode}`);
      return ack();
    }

    // ── subscription.disable (cancelled or all retries exhausted) ─────────────
    if (eventType === 'subscription.disable') {
      const subscriptionCode = event.data?.subscription_code;
      if (subscriptionCode) {
        await disableSubscriptionToken(subscriptionCode, 3); // 3-day grace period
        console.log(`[MASS] Webhook subscription.disable: grace period set for sub ${subscriptionCode}`);
      }
      return ack();
    }

    // ── charge.success ────────────────────────────────────────────────────────
    if (eventType !== 'charge.success') {
      return ack(); // Unhandled event type — ack and ignore (so Paystack doesn't retry)
    }

    const paymentData      = event.data;
    const reference        = paymentData.reference;
    const subscriptionCode = paymentData.subscription_code || null;

    if (!reference) {
      console.warn('[MASS] Paystack webhook missing reference');
      return ack();
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
      return ack();
    }

    // One-time charge.success (no subscription_code)
    if (pendingPayments.has(reference)) {
      console.log(`[MASS] Webhook: payment ${reference} already processed via callback`);
      return ack();
    }

    const metadata = paymentData.metadata || {};

    // ── Download purchase ─────────────────────────────────────────────────────
    if (metadata.payment_type === 'download') {
      await handleDownloadWebhook(paymentData, reference);
      return ack();
    }

    const days   = clampDays(metadata.days, 7);
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
    return ack();
  } catch (err) {
    console.error('[MASS] Paystack webhook error:', err);
    res.sendStatus(500);
  }
});

export default router;
