/**
 * lib/paystack.js — Paystack client and plan definitions.
 * No dependencies on other app modules (env vars + node:crypto only).
 */

import { createHmac } from 'node:crypto';
import { safeFetch } from '../fm-client.js';

// ── Config ───────────────────────────────────────────────────────────────────
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || '';
const PAYSTACK_BASE_URL   = 'https://api.paystack.co';

// ── Plans — single source of truth ───────────────────────────────────────────
export const PAYSTACK_PLANS = {
  '1-day':  { amount: 500,   label: '1 Day Access',  days: 1,  display: 'R5'  },
  '7-day':  { amount: 2000,  label: '7 Day Access',  days: 7,  display: 'R20' },
  '30-day': { amount: 5000,  label: '30 Day Access', days: 30, display: 'R50' }
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
  const data     = await response.json();
  if (!response.ok) {
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
