/**
 * lib/paystack.js — Paystack client and plan definitions.
 * No dependencies on other app modules (env vars + node:crypto only).
 */

import { createHmac } from 'node:crypto';
import { safeFetch } from '../fm-client.js';

// ── Config ───────────────────────────────────────────────────────────────────
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || '';
const PAYSTACK_BASE_URL   = 'https://api.paystack.co';

// ── One-time plans — single source of truth ───────────────────────────────────
export const PAYSTACK_PLANS = {
  '1-day':  { amount: 500,   label: '1 Day Access',  days: 1,  display: 'R5'  },
  '7-day':  { amount: 2000,  label: '7 Day Access',  days: 7,  display: 'R20' },
  '30-day': { amount: 5000,  label: '30 Day Access', days: 30, display: 'R50' }
};

// ── Subscription plan ─────────────────────────────────────────────────────────
export const PAYSTACK_SUBSCRIPTION_PLAN = {
  code:     process.env.PAYSTACK_SUBSCRIPTION_PLAN_CODE || 'PLN_ezhggydgyrllxir',
  label:    'Monthly Subscription',
  interval: 'monthly',
  display:  process.env.PAYSTACK_SUBSCRIPTION_DISPLAY  || 'Monthly',
  // Amount in kobo/cents — set via env var or fetched from Paystack at runtime
  amount:   process.env.PAYSTACK_SUBSCRIPTION_AMOUNT
            ? parseInt(process.env.PAYSTACK_SUBSCRIPTION_AMOUNT, 10)
            : null
};

// Cache for plan amount fetched from Paystack (avoids repeated API calls)
let _cachedPlanAmount = null;

/**
 * Returns the subscription plan's amount in Paystack's lowest currency unit.
 * Uses PAYSTACK_SUBSCRIPTION_AMOUNT env var if set, otherwise fetches from
 * Paystack's plan API and caches the result.
 */
export async function getSubscriptionPlanAmount() {
  if (PAYSTACK_SUBSCRIPTION_PLAN.amount) return PAYSTACK_SUBSCRIPTION_PLAN.amount;
  if (_cachedPlanAmount) return _cachedPlanAmount;
  const data = await paystackRequest('GET', `/plan/${PAYSTACK_SUBSCRIPTION_PLAN.code}`);
  _cachedPlanAmount = data.data.amount;
  return _cachedPlanAmount;
}

// Maps Paystack interval strings to days (used when extending subscription expiry)
export const SUBSCRIPTION_INTERVAL_DAYS = {
  daily:      2,   // +1 buffer
  weekly:     8,
  monthly:    31,
  biannually: 185,
  annually:   366
};

// ── API client ────────────────────────────────────────────────────────────────

export async function paystackRequest(method, endpoint, body) {
  if (!PAYSTACK_SECRET_KEY) {
    throw new Error('PAYSTACK_SECRET_KEY not configured');
  }
  const url     = `${PAYSTACK_BASE_URL}${endpoint}`;
  const options = {
    method,
    headers: {
      'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}`,
      'Content-Type':  'application/json'
    },
    timeout: 30000
  };
  if (body) options.body = JSON.stringify(body);
  const response = await safeFetch(url, options);
  let data;
  try {
    data = await response.json();
  } catch (parseErr) {
    const text = await response.text().catch(() => '(unreadable)');
    console.error(`[Paystack] Non-JSON response (${response.status}):`, text);
    throw new Error(`Paystack API error: ${response.status} ${response.statusText}`);
  }
  if (!response.ok) {
    console.error(`[Paystack] API error ${response.status}:`, JSON.stringify(data));
    throw new Error(`Paystack API error: ${data.message || response.statusText}`);
  }
  return data;
}

export function verifyPaystackWebhook(rawBody, signature) {
  if (!PAYSTACK_SECRET_KEY || !signature) return false;
  const hash = createHmac('sha512', PAYSTACK_SECRET_KEY)
    .update(rawBody)
    .digest('hex');
  return hash === signature;
}
