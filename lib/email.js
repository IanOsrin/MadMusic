/**
 * lib/email.js — Nodemailer singleton and transactional email helpers.
 * No dependencies on other app modules (env vars only).
 */

import nodemailer from 'nodemailer';

// ── Config ───────────────────────────────────────────────────────────────────
const EMAIL_HOST = process.env.EMAIL_HOST || 'smtp.ionos.com';
const EMAIL_PORT = Number.parseInt(process.env.EMAIL_PORT) || 587;
const EMAIL_USER = process.env.EMAIL_USER || '';
const EMAIL_PASS = process.env.EMAIL_PASS || '';
const EMAIL_FROM = process.env.EMAIL_FROM || EMAIL_USER;

// ── Singleton transporter ─────────────────────────────────────────────────────
// Exported so other modules (e.g. routes/playlists.js) can reuse the same
// connection pool rather than creating a new transporter per request (fixes D8).
export const emailTransporter = (EMAIL_USER && EMAIL_PASS)
  ? nodemailer.createTransport({
      host:   EMAIL_HOST,
      port:   EMAIL_PORT,
      secure: EMAIL_PORT === 465,
      auth:   { user: EMAIL_USER, pass: EMAIL_PASS }
    })
  : null;

// ── Token delivery ────────────────────────────────────────────────────────────

export function sendTokenEmail(customerEmail, tokenCode, days) {
  if (!emailTransporter) {
    console.log('[MASS] Email transporter not configured — skipping token email');
    return;
  }
  if (!customerEmail || customerEmail === 'unknown') {
    console.log('[MASS] No customer email available — skipping token email');
    return;
  }

  const planLabel = days === 1 ? '1 Day' : `${days} Days`;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px;">
      <h2 style="color: #1a1a1a; margin-bottom: 8px;">Your Mass Music Access Token</h2>
      <p style="color: #555; margin-bottom: 24px;">Thank you for your purchase! Here is your access token:</p>
      <div style="background: #f4f4f4; border-radius: 8px; padding: 20px; text-align: center; margin-bottom: 24px;">
        <span style="font-size: 28px; font-weight: bold; letter-spacing: 2px; color: #1a1a1a;">${tokenCode}</span>
      </div>
      <p style="color: #555;"><strong>Plan:</strong> ${planLabel} Access</p>
      <p style="color: #555; margin-bottom: 24px;">Enter this token on the Mass Music app to activate your streaming access.</p>
      <hr style="border: none; border-top: 1px solid #ddd; margin: 24px 0;" />
      <p style="color: #999; font-size: 12px;">If you did not make this purchase, please ignore this email.</p>
    </div>
  `;

  return emailTransporter.sendMail({
    from:    EMAIL_FROM,
    to:      customerEmail,
    subject: `Your Mass Music Access Token: ${tokenCode}`,
    html
  }).then(() => {
    console.log(`[MASS] Token email sent to ${customerEmail}`);
  }).catch(err => {
    console.error(`[MASS] Failed to send token email to ${customerEmail}:`, err?.message || err);
    throw err; // re-throw so callers can react
  });
}

// ── Trial welcome ─────────────────────────────────────────────────────────────

export function sendTrialEmail(customerEmail, tokenCode) {
  if (!emailTransporter) {
    console.log('[MASS] Email transporter not configured — skipping trial email');
    return;
  }
  if (!customerEmail || customerEmail === 'unknown') {
    console.log('[MASS] No customer email available — skipping trial email');
    return;
  }

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px;">
      <h2 style="color: #1a1a1a; margin-bottom: 8px;">Your 7-Day Free Trial</h2>
      <p style="color: #555; margin-bottom: 24px;">Welcome to Mass Music! Here is your free trial access token:</p>
      <div style="background: #f4f4f4; border-radius: 8px; padding: 20px; text-align: center; margin-bottom: 24px;">
        <span style="font-size: 28px; font-weight: bold; letter-spacing: 2px; color: #1a1a1a;">${tokenCode}</span>
      </div>
      <p style="color: #555;"><strong>Plan:</strong> 7-Day Free Trial</p>
      <p style="color: #555; margin-bottom: 24px;">Your token has been activated automatically. If you ever need it again, enter it on the Mass Music app to restore your access.</p>
      <hr style="border: none; border-top: 1px solid #ddd; margin: 24px 0;" />
      <p style="color: #999; font-size: 12px;">If you did not request this trial, please ignore this email.</p>
    </div>
  `;

  return emailTransporter.sendMail({
    from:    EMAIL_FROM,
    to:      customerEmail,
    subject: `Your Mass Music Free Trial Token: ${tokenCode}`,
    html
  }).then(() => {
    console.log(`[MASS] Trial email sent to ${customerEmail}`);
  }).catch(err => {
    console.error(`[MASS] Failed to send trial email to ${customerEmail}:`, err?.message || err);
  });
}

// ── Subscription welcome ───────────────────────────────────────────────────────

export function sendSubscriptionWelcomeEmail(customerEmail, tokenCode, planLabel) {
  if (!emailTransporter) {
    console.log('[MASS] Email transporter not configured — skipping subscription welcome email');
    return;
  }
  if (!customerEmail || customerEmail === 'unknown') {
    console.log('[MASS] No customer email available — skipping subscription welcome email');
    return;
  }

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px;">
      <h2 style="color: #1a1a1a; margin-bottom: 8px;">Welcome to Mass Music!</h2>
      <p style="color: #555; margin-bottom: 16px;">
        Your <strong>${planLabel || 'Monthly Subscription'}</strong> is now active.
        Use the token below to log in — keep it somewhere safe, you won't need to enter it again
        on this device.
      </p>
      <div style="background: #f4f4f4; border-radius: 8px; padding: 20px; text-align: center; margin-bottom: 24px;">
        <span style="font-size: 28px; font-weight: bold; letter-spacing: 2px; color: #1a1a1a;">${tokenCode}</span>
      </div>
      <p style="color: #555; margin-bottom: 8px;">
        Your access renews automatically each billing cycle. If your subscription is ever cancelled
        you will retain access until the end of the current period.
      </p>
      <hr style="border: none; border-top: 1px solid #ddd; margin: 24px 0;" />
      <p style="color: #999; font-size: 12px;">If you did not sign up for this subscription, please ignore this email.</p>
    </div>
  `;

  return emailTransporter.sendMail({
    from:    EMAIL_FROM,
    to:      customerEmail,
    subject: `Your Mass Music Subscription is Active`,
    html
  }).then(() => {
    console.log(`[MASS] Subscription welcome email sent to ${customerEmail}`);
  }).catch(err => {
    console.error(`[MASS] Failed to send subscription welcome email to ${customerEmail}:`, err?.message || err);
    throw err;
  });
}
