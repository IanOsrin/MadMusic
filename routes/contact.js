/**
 * routes/contact.js — POST /api/contact: the mobile "Contact us" form.
 *
 * Public on purpose (people who can't sign in are exactly the ones who need help), so it is
 * rate-limited per IP in server.js, carries a honeypot field, and caps the message length.
 * The email goes to the support inbox with Ian as a silent BCC (lib/email.js sendContactEmail).
 */
import { Router } from 'express';
import { isStrictEmail } from '../lib/validators.js';
import { sendContactEmail } from '../lib/email.js';

const router = Router();
const MAX_MESSAGE = 3000;
const clip = (v, n) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, n);

router.post('/', async (req, res) => {
  const body = req.body || {};
  if (body.website) return res.json({ ok: true });            // honeypot: bots fill every field
  const email = clip(body.email, 200).toLowerCase();
  const message = clip(body.message, MAX_MESSAGE);
  if (!isStrictEmail(email)) return res.status(400).json({ ok: false, error: 'Please enter a valid email address so we can reply.' });
  if (message.length < 3) return res.status(400).json({ ok: false, error: 'Please tell us what’s wrong.' });

  // Enough to help without asking the customer twice. The code is theirs; it is sent
  // only to MAD's own support inbox.
  const code = clip(req.headers['x-access-token'], 40).toUpperCase();
  const details = {
    'Signed in': code ? 'yes' : 'no (guest)',
    'Access code': /^[A-Z0-9-]{6,40}$/.test(code) ? code : '',
    'Screen': clip(body.page, 200),
    'Device': clip(req.headers['user-agent'], 300),
    'Sent': new Date().toISOString(),
  };
  try {
    await sendContactEmail({ email, message, details });
    console.log('[MASS] Contact request sent');
    res.json({ ok: true });
  } catch (err) {
    console.error('[MASS] Contact request failed:', err?.message || err);
    res.status(502).json({ ok: false, error: 'We couldn’t send your message just now. Please try again in a minute.' });
  }
});

export default router;
