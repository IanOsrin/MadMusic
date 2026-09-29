/**
 * lib/trial-links.js — the signed "Confirm my email" link for free trials.
 *
 * Shared by the trial sign-up (routes/payments.js) and the trial reminder emails
 * (lib/trial-reminders.js), so both mint exactly the link /api/payments/trial/confirm checks.
 * HMAC over the code with AUTH_SECRET: a code alone can't be confirmed by someone guessing it.
 */
import crypto from 'node:crypto';

export const APP_BASE_URL = () => (process.env.APP_URL || 'https://musicafricadirect.com').replace(/\/+$/, '');

export const trialConfirmSig = (code) => crypto.createHmac('sha256', process.env.AUTH_SECRET || '')
  .update(`trial-confirm:${code}`).digest('base64url').slice(0, 32);

export const trialConfirmUrl = (code) =>
  `${APP_BASE_URL()}/api/payments/trial/confirm?t=${encodeURIComponent(code)}&s=${trialConfirmSig(code)}`;
