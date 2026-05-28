/**
 * lib/constants.js — Time-unit constants and other small shared values.
 *
 * All time durations in the codebase should be expressed in milliseconds in
 * memory (Node-native), and converted to seconds only when persisting to
 * FileMaker or to Paystack metadata. This avoids the historical mix of
 * hours/seconds/ms that caused token-duration bugs.
 */

export const SECOND_MS = 1000;
export const MINUTE_MS = 60 * SECOND_MS;
export const HOUR_MS   = 60 * MINUTE_MS;
export const DAY_MS    = 24 * HOUR_MS;

// Token / OTP / cache cap-stones — single source of truth.
export const EMAIL_OTP_TTL_MS        = 10 * MINUTE_MS;
export const EMAIL_OTP_MAX_ATTEMPTS  = 5;
export const TOKEN_VALIDATION_TTL_MS = 5 * MINUTE_MS;
export const TOKEN_STALE_GRACE_MS    = 24 * HOUR_MS;

// Subscription token max duration. Paystack metadata can claim any "days"
// value; we clamp it here so a forged or replayed webhook can't mint a
// 100-year token.
export const SUBSCRIPTION_DAYS_MIN = 1;
export const SUBSCRIPTION_DAYS_MAX = 400;
