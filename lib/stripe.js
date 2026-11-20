/**
 * lib/stripe.js — Stripe Checkout, side by side with Paystack (Ian, 2026-11-20:
 * "change our payment gateway from Paystack to Stripe ... first test it on the staging site").
 *
 * THE SWITCH: PAYMENT_GATEWAY=stripe (plus STRIPE_SECRET_KEY) sends every NEW checkout to
 * Stripe. Anything else — including no setting at all, which is what live has — keeps Paystack,
 * byte for byte. The Paystack webhook stays mounted whatever the switch says: customers who
 * subscribed through Paystack keep renewing through Paystack.
 *
 * HOW STRIPE MAPS ONTO THE PAYSTACK FLOW
 *   Paystack reference         → Checkout Session id (cs_…). It is the "reference" everywhere:
 *                                the callback's ?reference=, the download bearer key, FM rows.
 *   Paystack subscription_code → Stripe subscription id (sub_…), written into the code's Notes.
 *   Paystack plan code         → 'stripe:mad-monthly' / 'stripe:mixer' (tokenTypeForPlan reads it).
 *   charge.success (first)     → checkout.session.completed (+ async_payment_succeeded)
 *   invoice.update (renewal)   → invoice.paid with billing_reason 'subscription_cycle'
 *   subscription.disable       → customer.subscription.deleted
 *
 * Prices stay in our code (inline price_data, ZAR) so nothing has to be set up as products in the
 * Stripe dashboard. Stripe's own Adaptive Pricing (a dashboard switch) can show visitors abroad
 * their own currency on the checkout page; we still price in rand.
 */
import Stripe from 'stripe';

export const STRIPE_PLAN_MAD = 'stripe:mad-monthly';
export const STRIPE_PLAN_MIXER = 'stripe:mixer';

const secret = () => String(process.env.STRIPE_SECRET_KEY || '').trim();

/** 'stripe' only when asked for AND a key is there — a half-set switch must never break checkout. */
export function activeGateway() {
  const want = String(process.env.PAYMENT_GATEWAY || '').trim().toLowerCase();
  return want === 'stripe' && secret() ? 'stripe' : 'paystack';
}
export const stripeActive = () => activeGateway() === 'stripe';

/** Checkout Session ids are how a Stripe return is told apart from a Paystack one. */
export const isStripeReference = (ref) => /^cs_(test|live)_[A-Za-z0-9]+$/.test(String(ref || ''));

let _client = null;
let _clientKey = '';
export function stripeClient() {
  const key = secret();
  if (!key) throw new Error('STRIPE_SECRET_KEY not configured');
  if (!_client || _clientKey !== key) {
    _client = new Stripe(key, { maxNetworkRetries: 2, timeout: 30000 });
    _clientKey = key;
  }
  return _client;
}
/** Tests swap in a fake client. */
export function _setStripeClientForTests(fake) { _client = fake; _clientKey = secret(); }

// ── Prices (cents, ZAR) ───────────────────────────────────────────────────────
// The MAD monthly plan: Paystack reads its amount from the Paystack plan; Stripe has no plan of
// ours to read, so it comes from STRIPE_MONTHLY_AMOUNT, else PAYSTACK_SUBSCRIPTION_AMOUNT, else
// R29.99 (what the live site shows as "R29.99/Month").
export function madMonthlyAmount() {
  for (const v of [process.env.STRIPE_MONTHLY_AMOUNT, process.env.PAYSTACK_SUBSCRIPTION_AMOUNT]) {
    const n = Number.parseInt(v, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 2999;
}

const SUBSCRIPTIONS = {
  [STRIPE_PLAN_MAD]:   { name: 'MAD — Monthly Subscription', amount: () => madMonthlyAmount() },
  // R99/month, the same as the Paystack Mad Mixer plan (lib/paystack.js PAYSTACK_MIXER_PLAN.amount).
  [STRIPE_PLAN_MIXER]: { name: 'Mad Mixer — Monthly',       amount: () => 9900 },
};

// ── Checkout ──────────────────────────────────────────────────────────────────

/**
 * Open a Stripe Checkout page. Returns { url, reference } — the same two things Paystack's
 * /transaction/initialize gives the routes, so each route's answer to the browser is unchanged.
 *
 * successUrl must carry `{CHECKOUT_SESSION_ID}` (Stripe fills it in) as ?reference=.
 * metadata values must be strings ≤ 500 chars; callers keep them small.
 */
export async function createOneOffCheckout({ email, amountCents, name, metadata, successUrl, cancelUrl }) {
  const session = await stripeClient().checkout.sessions.create({
    mode: 'payment',
    customer_email: email,
    line_items: [{
      quantity: 1,
      price_data: { currency: 'zar', unit_amount: Math.round(amountCents), product_data: { name: String(name || 'MAD').slice(0, 120) } },
    }],
    metadata: stringify(metadata),
    payment_intent_data: { metadata: stringify(metadata) },
    success_url: successUrl,
    cancel_url: cancelUrl,
  });
  return { url: session.url, reference: session.id };
}

export async function createSubscriptionCheckout({ email, planCode, metadata, successUrl, cancelUrl }) {
  const plan = SUBSCRIPTIONS[planCode];
  if (!plan) throw new Error(`Unknown Stripe subscription plan ${planCode}`);
  // The email rides on the subscription too: customer.subscription.deleted carries no address,
  // and the email is what finds the customer's code in FileMaker.
  const meta = stringify({ ...metadata, payment_type: 'subscription', plan_code: planCode, email });
  const session = await stripeClient().checkout.sessions.create({
    mode: 'subscription',
    customer_email: email,
    line_items: [{
      quantity: 1,
      price_data: {
        currency: 'zar',
        unit_amount: plan.amount(),
        recurring: { interval: 'month' },
        product_data: { name: plan.name },
      },
    }],
    metadata: meta,
    subscription_data: { metadata: meta },
    success_url: successUrl,
    cancel_url: cancelUrl,
  });
  return { url: session.url, reference: session.id };
}

// Stripe metadata: at most 50 keys, each value at most 500 characters. A basket's item list is
// longer than that, so a long value is split over `key__0`, `key__1`, … and joined on the way back.
const META_CHUNK = 490;
export function stringify(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (v == null) continue;
    const text = typeof v === 'string' ? v : JSON.stringify(v);
    if (text.length <= 500) { out[k] = text; continue; }
    for (let i = 0, n = 0; i < text.length; i += META_CHUNK, n++) out[`${k}__${n}`] = text.slice(i, i + META_CHUNK);
  }
  if (Object.keys(out).length > 50) throw new Error('Too much to send to Stripe in one payment');
  return out;
}

/** Undo stringify for the few values the routes read back as numbers/objects. */
export function readMetadata(md) {
  const out = {};
  const chunks = {};
  for (const [k, v] of Object.entries(md || {})) {
    const m = /^(.+)__(\d+)$/.exec(k);
    if (m) (chunks[m[1]] ||= [])[Number(m[2])] = v; else out[k] = v;
  }
  for (const [k, parts] of Object.entries(chunks)) out[k] = parts.join('');
  for (const k of ['days', 'price', 'startSec', 'durationSec', 'count']) {
    if (out[k] != null && out[k] !== '') { const n = Number(out[k]); if (Number.isFinite(n)) out[k] = n; }
  }
  if (typeof out.items === 'string') { try { out.items = JSON.parse(out.items); } catch { out.items = []; } }
  return out;
}

// ── Verify a return (the callbacks) ───────────────────────────────────────────

/**
 * A Checkout Session in the shape the callbacks already work with (Paystack's verify answer):
 *   { status: 'success'|'pending'|'failed', reference, email, metadata, isSubscription,
 *     subscriptionCode, planCode, interval, amountCents }
 */
export async function verifyCheckout(reference) {
  const s = await stripeClient().checkout.sessions.retrieve(reference);
  return normaliseSession(s);
}

export function normaliseSession(s) {
  const metadata = readMetadata(s.metadata);
  const paid = s.status === 'complete' && (s.payment_status === 'paid' || s.payment_status === 'no_payment_required');
  // complete + unpaid = a delayed payment method still clearing (Stripe then sends
  // checkout.session.async_payment_succeeded) — "pending", like Paystack's bank approval.
  const status = paid ? 'success' : (s.status === 'complete' || s.status === 'open') ? 'pending' : 'failed';
  const subscriptionCode = typeof s.subscription === 'string' ? s.subscription : (s.subscription?.id || null);
  return {
    status,
    reference: s.id,
    email: String(s.customer_details?.email || s.customer_email || metadata.email || '').trim() || null,
    metadata,
    isSubscription: s.mode === 'subscription',
    subscriptionCode,
    planCode: metadata.plan_code || (s.mode === 'subscription' ? STRIPE_PLAN_MAD : null),
    interval: 'monthly',
    amountCents: s.amount_total ?? null,
  };
}

// ── Webhook ───────────────────────────────────────────────────────────────────

/** Signature-checked event, or null. Needs the raw body bytes (mounted raw in server.js). */
export function constructStripeEvent(rawBody, signature) {
  const whsec = String(process.env.STRIPE_WEBHOOK_SECRET || '').trim();
  if (!whsec || !signature || rawBody == null) return null;
  if (!Buffer.isBuffer(rawBody) && typeof rawBody !== 'string') return null;
  try {
    // Signature checking needs no API key; use a client if there is one, else a keyless instance.
    const s = secret() ? stripeClient() : new Stripe('sk_test_unused');
    return s.webhooks.constructEvent(rawBody, signature, whsec);
  } catch (err) {
    console.warn('[Stripe] webhook signature check failed:', err?.message || err);
    return null;
  }
}

/**
 * What a paid subscription invoice tells us, across API versions (the subscription moved from
 * invoice.subscription to invoice.parent.subscription_details in 2025).
 */
export function readInvoice(inv) {
  const details = inv?.parent?.subscription_details || inv?.subscription_details || null;
  const sub = details?.subscription ?? inv?.subscription ?? null;
  const md = details?.metadata || inv?.lines?.data?.[0]?.metadata || {};
  const paidAtSec = inv?.status_transitions?.paid_at;
  return {
    email: String(inv?.customer_email || md.email || '').trim().toLowerCase() || null,
    subscriptionCode: typeof sub === 'string' ? sub : (sub?.id || null),
    planCode: md.plan_code || STRIPE_PLAN_MAD,
    billingReason: inv?.billing_reason || null,
    reference: inv?.id || null,
    paidAt: paidAtSec ? new Date(paidAtSec * 1000).toISOString() : null,
    paid: inv?.status === 'paid' || inv?.paid === true,
  };
}
