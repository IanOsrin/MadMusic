/**
 * lib/email.js — Nodemailer singleton and transactional email helpers.
 * No dependencies on other app modules (env vars only).
 */

import nodemailer from 'nodemailer';
import { escapeHtml } from './format.js';

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
      auth:   { user: EMAIL_USER, pass: EMAIL_PASS },
      // Never let a slow/hung SMTP server block a request path (e.g. the
      // post-payment callback redirect). Fail fast instead.
      connectionTimeout: 10_000,
      greetingTimeout:   10_000,
      socketTimeout:     20_000
    })
  : null;

// Surface a broken/missing email config LOUDLY at boot — otherwise every
// transactional email (purchase tokens, trials) silently no-ops, which is how
// "I paid but got no token email" slips through unnoticed.
if (emailTransporter) {
  emailTransporter.verify()
    .then(() => console.log('[MASS] Email transporter verified — SMTP login OK'))
    .catch((err) => console.error('[MASS] ⚠️  EMAIL TRANSPORTER VERIFY FAILED — token/trial emails will NOT send:', err?.message || err));
} else {
  console.warn('[MASS] ⚠️  Email NOT configured (EMAIL_USER/EMAIL_PASS missing) — transactional emails are disabled');
}

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
        <span style="font-size: 28px; font-weight: bold; letter-spacing: 2px; color: #1a1a1a;">${escapeHtml(tokenCode)}</span>
      </div>
      <p style="color: #555;"><strong>Plan:</strong> ${escapeHtml(planLabel)} Access</p>
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

export function sendTrialEmail(customerEmail, tokenCode, confirmUrl, { plans = [], monthly = null } = {}) {
  if (!emailTransporter) {
    console.log('[MASS] Email transporter not configured — skipping trial email');
    return;
  }
  if (!customerEmail || customerEmail === 'unknown') {
    console.log('[MASS] No customer email available — skipping trial email');
    return;
  }

  // The welcome email carries everything (Ian, 2026-09-27): confirm, how to keep listening
  // after the trial (the app may not say where to buy — an email may), other devices, the
  // Android app, and how to reach us. Plans/prices come from lib/paystack.js via the route,
  // so the email never quotes a stale price.
  const base = (process.env.APP_URL || 'https://musicafricadirect.com').replace(/\/+$/, '');
  const listenUrl  = `${base}/access?token=${encodeURIComponent(tokenCode)}`;
  const buyUrl     = `${base}/access?buy=1`;
  const contactUrl = `${base}/mobile?contact=1`;
  const playUrl    = process.env.PLAY_STORE_URL || 'https://play.google.com/store/apps/details?id=com.musicafricadirect.app';
  const button = (href, label) => `<a href="${escapeHtml(href)}" style="display: inline-block; background: #7c3aed; color: #ffffff; text-decoration: none; font-weight: bold; padding: 14px 28px; border-radius: 999px;">${label}</a>`;
  const h = (t) => `<h3 style="color: #1a1a1a; font-size: 16px; margin: 28px 0 8px;">${t}</h3>`;
  const p = (t, extra = '') => `<p style="color: #555; line-height: 1.5; margin: 0 0 10px;${extra}">${t}</p>`;
  const priceRows = [
    ...(monthly ? [['Monthly subscription', escapeHtml(monthly)]] : []),
    ...plans.map((pl) => [escapeHtml(pl.label), escapeHtml(pl.display)]),
  ].map(([a, b]) => `<tr><td style="padding: 4px 16px 4px 0; color: #333;">${a}</td><td style="padding: 4px 0; color: #1a1a1a; font-weight: bold;">${b}</td></tr>`).join('');

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px;">
      <h2 style="color: #1a1a1a; margin-bottom: 8px;">Your free trial has started</h2>
      ${p('Welcome to MAD — Music Africa Direct: a hundred years of South African music from the original master tapes. You’re already signed in on the device you signed up on.', ' margin-bottom: 20px;')}
      ${confirmUrl ? `
      ${p('<strong>Confirm your email within 24 hours to keep all 7 days</strong> (otherwise the trial ends after 1 day):', ' margin-bottom: 16px;')}
      <p style="text-align: center; margin: 0 0 8px;">${button(confirmUrl, 'Confirm my email')}</p>` : ''}

      ${h('Keep listening after your trial')}
      ${p('Choose a pass or subscribe on our website — pay once, no card details stored for passes:')}
      ${priceRows ? `<table style="font-size: 14px; border-collapse: collapse; margin: 4px 0 14px;">${priceRows}</table>` : ''}
      <p style="text-align: center; margin: 6px 0 10px;">${button(buyUrl, 'See plans &amp; subscribe')}</p>
      ${p('<strong>Using the MAD app?</strong> Buy your pass here on the website — we email you an access code — then open the app and choose <em>Enter access code</em>.', ' font-size: 13px;')}

      ${h('Listen on another phone or computer')}
      ${p(`Use <a href="${escapeHtml(listenUrl)}" style="color: #7c3aed; font-weight: bold;">this sign-in link</a>, or enter your code:`)}
      <div style="background: #f4f4f4; border-radius: 8px; padding: 16px; text-align: center; margin: 8px 0 4px;">
        <span style="font-size: 24px; font-weight: bold; letter-spacing: 2px; color: #1a1a1a;">${escapeHtml(tokenCode)}</span>
      </div>

      ${h('Get the app')}
      ${p(`Android: <a href="${escapeHtml(playUrl)}" style="color: #7c3aed; font-weight: bold;">MAD Music on Google Play</a>. On iPhone, use <a href="${escapeHtml(base)}" style="color: #7c3aed;">musicafricadirect.com</a> in Safari — the iPhone app is coming.`)}

      ${h('Need help?')}
      ${p(`<a href="${escapeHtml(contactUrl)}" style="color: #7c3aed; font-weight: bold;">Contact us</a> and we’ll get back to you by email.`)}

      <hr style="border: none; border-top: 1px solid #ddd; margin: 28px 0 16px;" />
      <p style="color: #999; font-size: 12px;">If you did not request this trial, please ignore this email.</p>
    </div>
  `;

  return emailTransporter.sendMail({
    from:    EMAIL_FROM,
    to:      customerEmail,
    subject: 'Confirm your email to keep your 7-day MAD free trial',
    html
  }).then(() => {
    console.log(`[MASS] Trial email sent to ${customerEmail}`);
  }).catch(err => {
    console.error(`[MASS] Failed to send trial email to ${customerEmail}:`, err?.message || err);
    throw err; // the route rolls the trial back — an unreachable address can't confirm
  });
}

// ── Trial ending / ended reminders ────────────────────────────────────────────
// Sent by lib/trial-reminders.js (Ian, 2026-09-29): the store apps may not tell anyone where
// to buy, so these emails are how an app listener learns how to keep listening. One email
// helper for the three moments, so they share one look and one price table.
//   kind 'ending'            — a confirmed trial ends within about a day
//   kind 'ended'             — the trial is over
//   kind 'ended-unconfirmed' — the unconfirmed 1-day trial is over; Confirm still unlocks the week
export function sendTrialReminderEmail(customerEmail, opts) {
  if (!emailTransporter) {
    console.log('[MASS] Email transporter not configured — skipping trial reminder');
    return Promise.resolve();
  }
  if (!customerEmail) return Promise.resolve();
  let msg;
  try { msg = trialReminderContent(opts); } catch (err) { return Promise.reject(err); }
  return emailTransporter.sendMail({ from: EMAIL_FROM, to: customerEmail, subject: msg.subject, html: msg.html })
    .then(() => console.log(`[MASS] Trial reminder (${opts.kind}) sent to ${customerEmail}`));
}

/** Subject + HTML for a trial reminder — separate from sending so it can be previewed. */
export function trialReminderContent({ kind, tokenCode, endsText = '', confirmUrl = null, plans = [], monthly = null }) {
  const base = (process.env.APP_URL || 'https://musicafricadirect.com').replace(/\/+$/, '');
  const buyUrl     = `${base}/access?buy=1`;
  const contactUrl = `${base}/mobile?contact=1`;
  const button = (href, label, bg = '#7c3aed') => `<a href="${escapeHtml(href)}" style="display: inline-block; background: ${bg}; color: #ffffff; text-decoration: none; font-weight: bold; padding: 14px 28px; border-radius: 999px;">${label}</a>`;
  const h = (t) => `<h3 style="color: #1a1a1a; font-size: 16px; margin: 28px 0 8px;">${t}</h3>`;
  const p = (t, extra = '') => `<p style="color: #555; line-height: 1.5; margin: 0 0 10px;${extra}">${t}</p>`;
  const priceRows = [
    ...(monthly ? [['Monthly subscription', escapeHtml(monthly)]] : []),
    ...plans.map((pl) => [escapeHtml(pl.label), escapeHtml(pl.display)]),
  ].map(([a, b]) => `<tr><td style="padding: 4px 16px 4px 0; color: #333;">${a}</td><td style="padding: 4px 0; color: #1a1a1a; font-weight: bold;">${b}</td></tr>`).join('');

  const copy = {
    ending: {
      subject: 'Your MAD free trial ends tomorrow',
      title: 'Your free trial ends tomorrow',
      intro: `Your 7-day free trial of MAD — Music Africa Direct ends <strong>${escapeHtml(endsText)}</strong>. Pick a plan now and the music keeps playing without a break.`,
    },
    ended: {
      subject: 'Your MAD free trial has ended — keep the music playing',
      title: 'Your free trial has ended',
      intro: 'Thanks for spending a week in the vault. Your free trial of MAD — Music Africa Direct is over, but a hundred years of South African music is still here, from R2.50.',
    },
    'ended-unconfirmed': {
      subject: 'Your free day on MAD is over — unlock 6 more days',
      title: 'Your free day is over — there’s more',
      intro: 'Your free day on MAD — Music Africa Direct has ended because your email was never confirmed. <strong>Confirm it now and your trial carries on for the rest of the week</strong>, free.',
    },
  }[kind];
  if (!copy) throw new Error(`unknown trial reminder kind: ${kind}`);

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px;">
      <h2 style="color: #1a1a1a; margin-bottom: 8px;">${copy.title}</h2>
      ${p(copy.intro, ' margin-bottom: 20px;')}
      ${confirmUrl ? `<p style="text-align: center; margin: 0 0 8px;">${button(confirmUrl, 'Confirm my email — 6 more days free')}</p>` : ''}

      ${h(confirmUrl ? 'Or keep listening with a plan' : 'Keep listening')}
      ${p('Subscribe monthly, or buy a pass on our website — passes are paid once, no card details stored:')}
      ${priceRows ? `<table style="font-size: 14px; border-collapse: collapse; margin: 4px 0 14px;">${priceRows}</table>` : ''}
      <p style="text-align: center; margin: 6px 0 10px;">${button(buyUrl, 'See plans &amp; subscribe', confirmUrl ? '#1a1a1a' : '#7c3aed')}</p>
      ${p('<strong>Listening in the MAD app?</strong> Buy here on the website — we email you an access code — then open the app and choose <em>Enter access code</em>.', ' font-size: 13px;')}

      ${h('Need help?')}
      ${p(`<a href="${escapeHtml(contactUrl)}" style="color: #7c3aed; font-weight: bold;">Contact us</a> and we’ll get back to you by email.`)}

      <hr style="border: none; border-top: 1px solid #ddd; margin: 28px 0 16px;" />
      <p style="color: #999; font-size: 12px;">You’re getting this because you started a free trial on musicafricadirect.com with this email address (trial code ${escapeHtml(tokenCode || '')}). We send at most two reminders per trial.</p>
    </div>
  `;

  return { subject: copy.subject, html };
}

// ── Email-claim verification code ─────────────────────────────────────────────
// Sends the 6-digit verification code used by the email-claim flow in
// routes/access.js (POST /api/access/email/start). Verifying the code binds
// the user's real email to their access token, closing the orphan-data hole
// where playlists/library got stored under the token code.

export function sendEmailClaimCode(customerEmail, code) {
  if (!emailTransporter) {
    console.log('[MASS] Email transporter not configured — cannot send claim code');
    return Promise.reject(new Error('Email service not configured'));
  }
  if (!customerEmail) {
    return Promise.reject(new Error('Recipient email required'));
  }

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px;">
      <h2 style="color: #1a1a1a; margin-bottom: 8px;">Verify your email</h2>
      <p style="color: #555; margin-bottom: 16px;">
        Enter this code in MAD Music to link your access token to this email address.
        Your playlists and saved albums will be stored under this email going forward.
      </p>
      <div style="background:#f4f4f4;border-radius:8px;padding:20px;text-align:center;margin-bottom:20px;">
        <span style="font-size:32px;font-weight:bold;letter-spacing:8px;color:#1a1a1a;">${escapeHtml(code)}</span>
      </div>
      <p style="color:#555;margin-bottom:8px;">This code expires in <strong>10 minutes</strong>.</p>
      <hr style="border:none;border-top:1px solid #ddd;margin:24px 0;" />
      <p style="color:#999;font-size:12px;">
        If you didn't request this code, you can ignore this email — no changes
        will be made to your account.
      </p>
    </div>
  `;

  return emailTransporter.sendMail({
    from:    EMAIL_FROM,
    to:      customerEmail,
    subject: `MAD Music verification code: ${code}`,
    text:    `Your MAD Music verification code is: ${code}\n\nThis code expires in 10 minutes.\n\nIf you didn't request this, ignore this email.`,
    html
  }).then(() => {
    console.log(`[MASS] Email-claim code sent to ${customerEmail}`);
  }).catch(err => {
    console.error(`[MASS] Failed to send email-claim code to ${customerEmail}:`, err?.message || err);
    throw err;
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
        Your <strong>${escapeHtml(planLabel || 'Monthly Subscription')}</strong> is now active.
        Use the token below to log in — keep it somewhere safe, you won't need to enter it again
        on this device.
      </p>
      <div style="background: #f4f4f4; border-radius: 8px; padding: 20px; text-align: center; margin-bottom: 24px;">
        <span style="font-size: 28px; font-weight: bold; letter-spacing: 2px; color: #1a1a1a;">${escapeHtml(tokenCode)}</span>
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


// ── Basket of downloads ───────────────────────────────────────────────────────
// One payment, several tracks: every track keeps its own link (and its own
// 3-download allowance), so a failed download costs one track rather than the
// whole purchase. Sent the moment the basket is recorded.
export function sendBasketLinksEmail(customerEmail, items, reference) {
  if (!emailTransporter) {
    console.log('[MASS] Email transporter not configured — skipping basket email');
    return Promise.resolve();
  }
  if (!customerEmail || customerEmail === 'unknown' || !items?.length) return Promise.resolve();

  const APP_BASE = (process.env.APP_URL || 'https://musicafricadirect.com').replace(/\/$/, '');
  const linkFor = (id) =>
    `${APP_BASE}/api/download/file?ref=${encodeURIComponent(reference)}&track=${encodeURIComponent(id)}`;
  const total = items.reduce((sum, i) => sum + (Number(i.price) || 0), 0);

  const rows = items.map((i) => `
    <tr>
      <td style="padding:10px 0;border-bottom:1px solid #eee;color:#1a1a1a;">${escapeHtml(i.name || 'Track')}
        ${i.artist ? `<br><span style="color:#777;font-size:13px;">${escapeHtml(i.artist)}</span>` : ''}</td>
      <td style="padding:10px 0;border-bottom:1px solid #eee;text-align:right;white-space:nowrap;">
        <a href="${linkFor(i.trackRecordId)}" style="background:#8b5cf6;color:#fff;text-decoration:none;padding:8px 16px;border-radius:6px;font-size:14px;display:inline-block;">Download</a>
      </td>
    </tr>`).join('');

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px;">
      <h2 style="color:#1a1a1a;margin-bottom:8px;">Your MAD Music downloads</h2>
      <p style="color:#555;margin-bottom:20px;">Thank you — ${items.length} track${items.length === 1 ? '' : 's'}, R${total.toFixed(2)}. Each one downloads separately:</p>
      <table style="width:100%;border-collapse:collapse;">${rows}</table>
      <p style="color:#555;margin:20px 0 8px;">Each link works for 48 hours and allows three downloads — enough for your phone, your computer and a retry. They are personal to your purchase; please don't share them.</p>
      <hr style="border:none;border-top:1px solid #ddd;margin:24px 0;" />
      <p style="color:#999;font-size:12px;">Keep this email as your receipt (reference ${escapeHtml(reference)}). If you did not make this purchase, please contact support.</p>
    </div>`;

  return emailTransporter.sendMail({
    from: EMAIL_FROM,
    to: customerEmail,
    subject: `Your downloads are ready (${items.length} track${items.length === 1 ? '' : 's'})`,
    html
  }).then(() => {
    console.log(`[MASS] Basket email sent to ${customerEmail} (${items.length} tracks, ref=${reference})`);
  }).catch(err => {
    console.error(`[MASS] Failed to send basket email to ${customerEmail}:`, err?.message || err);
  });
}

// ── Download purchase link ────────────────────────────────────────────────────
// Sent the moment a download purchase is recorded (callback or webhook), so
// the customer has their file link in the inbox even if the browser return
// journey breaks (2026-08-25). The link is the 48h purchase reference.
export function sendDownloadLinkEmail(customerEmail, trackName, reference) {
  if (!emailTransporter) {
    console.log('[MASS] Email transporter not configured — skipping download link email');
    return Promise.resolve();
  }
  if (!customerEmail || customerEmail === 'unknown') {
    console.log('[MASS] No customer email available — skipping download link email');
    return Promise.resolve();
  }
  const APP_BASE = (process.env.APP_URL || 'https://musicafricadirect.com').replace(/\/$/, '');
  const link = `${APP_BASE}/api/download/file?ref=${encodeURIComponent(reference)}`;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px;">
      <h2 style="color: #1a1a1a; margin-bottom: 8px;">Your MAD Music download</h2>
      <p style="color: #555; margin-bottom: 24px;">Thank you for your purchase of <strong>${escapeHtml(trackName)}</strong>. Your download is ready:</p>
      <div style="text-align: center; margin-bottom: 24px;">
        <a href="${link}" style="background: #8b5cf6; color: #fff; text-decoration: none; padding: 14px 28px; border-radius: 8px; font-size: 16px; display: inline-block;">Download ${escapeHtml(trackName)}</a>
      </div>
      <p style="color: #555; margin-bottom: 8px;">This link works for 48 hours and is personal to your purchase — please don't share it.</p>
      <p style="color: #555; margin-bottom: 24px;">If the button doesn't work, copy this address into your browser:<br>
      <span style="font-size: 12px; color: #777; word-break: break-all;">${link}</span></p>
      <hr style="border: none; border-top: 1px solid #ddd; margin: 24px 0;" />
      <p style="color: #999; font-size: 12px;">Keep this email as your payment receipt (reference ${escapeHtml(reference)}). If you did not make this purchase, please contact support.</p>
    </div>
  `;
  return emailTransporter.sendMail({
    from:    EMAIL_FROM,
    to:      customerEmail,
    subject: `Your download is ready: ${trackName}`,
    html
  }).then(() => {
    console.log(`[MASS] Download link email sent to ${customerEmail} (ref=${reference})`);
  }).catch(err => {
    console.error(`[MASS] Failed to send download link email to ${customerEmail}:`, err?.message || err);
  });
}

// ── Contact / help requests (mobile "Contact us", 2026-09-26) ─────────────────
// Goes to the support inbox (CONTACT_TO, default serverdev@musicafricadirect.com) with Ian as a
// silent BCC (CONTACT_BCC, default ian@digitalcupboard.net). Reply-To is the customer,
// so "Reply" in the support inbox answers them directly.
export function sendContactEmail({ email, message, details }) {
  if (!emailTransporter) throw new Error('Email transporter not configured');
  const to  = process.env.CONTACT_TO  || 'serverdev@musicafricadirect.com';
  const bcc = process.env.CONTACT_BCC || 'ian@digitalcupboard.net';
  const rows = Object.entries(details || {})
    .filter(([, v]) => v)
    .map(([k, v]) => `<tr><td style="color:#888;padding:2px 12px 2px 0;vertical-align:top">${escapeHtml(k)}</td><td style="color:#333">${escapeHtml(String(v))}</td></tr>`)
    .join('');
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 560px; padding: 16px;">
      <h3 style="margin: 0 0 12px;">MAD help request</h3>
      <p style="margin: 0 0 6px;"><strong>From:</strong> ${escapeHtml(email)}</p>
      <div style="white-space: pre-wrap; background: #f4f4f4; border-radius: 8px; padding: 14px; margin: 12px 0 16px; color: #1a1a1a;">${escapeHtml(message)}</div>
      <table style="font-size: 12px; border-collapse: collapse;">${rows}</table>
      <p style="color: #999; font-size: 12px; margin-top: 16px;">Reply to this email to answer the customer directly.</p>
    </div>`;
  return emailTransporter.sendMail({
    from: EMAIL_FROM, to, bcc, replyTo: email,
    subject: `MAD help request from ${email}`,
    html,
  });
}

// ── Mad Mixer free split (2026-09-28) ─────────────────────────────────────────
// The listener is already in Mad Mixer on the device they signed up on; this email's job is
// the Confirm button (it unlocks the one free split) and the code for any other device.
// lib/mixer-trial.js builds both links: MAD's own /api/mixer/trial/confirm + /mixer?code= while
// Mad Mixer lives inside MAD, MIXER_URL/#confirm=… + MIXER_URL/#code=… once it has its own home.
export function sendMixerTrialEmail(customerEmail, tokenCode, { confirmUrl, openUrl } = {}) {
  if (!emailTransporter) throw new Error('Email transporter not configured');
  if (!confirmUrl || !openUrl) throw new Error('Mad Mixer trial email needs confirmUrl and openUrl');
  const base = (process.env.APP_URL || 'https://musicafricadirect.com').replace(/\/+$/, '');
  const contactUrl = `${base}/mobile?contact=1`;
  const button = (href, label) => `<a href="${escapeHtml(href)}" style="display: inline-block; background: #7c3aed; color: #ffffff; text-decoration: none; font-weight: bold; padding: 14px 28px; border-radius: 999px;">${label}</a>`;
  const p = (t, extra = '') => `<p style="color: #555; line-height: 1.5; margin: 0 0 10px;${extra}">${t}</p>`;
  const h = (t) => `<h3 style="color: #1a1a1a; font-size: 16px; margin: 26px 0 8px;">${t}</h3>`;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px;">
      <h2 style="color: #1a1a1a; margin-bottom: 8px;">Welcome to Mad Mixer</h2>
      ${p('South African classics from the original master tapes, opened up into separate stems — vocals, drums, bass and more. Mix them in your browser, or download them to your DAW.', ' margin-bottom: 18px;')}
      ${p('<strong>Confirm your email to unlock your free split:</strong>', ' margin-bottom: 14px;')}
      <p style="text-align: center; margin: 0 0 8px;">${button(confirmUrl, 'Confirm &amp; unlock my free split')}</p>

      ${h('Open Mad Mixer on another device')}
      ${p(`Use <a href="${escapeHtml(openUrl)}" style="color: #7c3aed; font-weight: bold;">this link</a>, or enter your code on the Mad Mixer page:`)}
      <div style="background: #f4f4f4; border-radius: 8px; padding: 16px; text-align: center; margin: 8px 0 4px;">
        <span style="font-size: 24px; font-weight: bold; letter-spacing: 2px; color: #1a1a1a;">${escapeHtml(tokenCode)}</span>
      </div>

      ${h('After your free split')}
      ${p('Mad Mixer is R99 a month for 30 splits a month and stem downloads — or R109.99 a month with full MAD streaming of 100 years of South African music included.')}

      ${h('Need help?')}
      ${p(`<a href="${escapeHtml(contactUrl)}" style="color: #7c3aed; font-weight: bold;">Contact us</a> and we’ll get back to you by email.`)}
      <hr style="border: none; border-top: 1px solid #ddd; margin: 26px 0 16px;" />
      <p style="color: #999; font-size: 12px;">If you did not ask for a Mad Mixer free split, please ignore this email.</p>
    </div>`;
  return emailTransporter.sendMail({
    from: EMAIL_FROM, to: customerEmail,
    subject: 'Confirm your email to unlock your free Mad Mixer split',
    html,
  });
}
