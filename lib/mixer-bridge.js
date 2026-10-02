/**
 * lib/mixer-bridge.js — the trust link between MAD and Mad Mixer on Vercel.
 *
 * ONE job: signing the internal calls Mad Mixer makes to MAD (Vercel → MAD, /internal/mixer/*,
 * routes/mixer-internal.js). The key comes from ONE shared secret, MIXER_SHARED_SECRET — the same
 * value on Render and on Vercel; it never travels.
 *
 *   Headers X-MM-Ts (Unix seconds) and X-MM-Sig:
 *     X-MM-Sig = base64url( HMAC-SHA256( K_sign, ts "\n" METHOD "\n" path "\n" hex(SHA-256(body)) ) )
 *   `path` is the path AND query exactly as sent (e.g. "/internal/mixer/songs"), `body` the exact
 *   raw bytes (empty for a GET). MAD accepts ts within ±60 s and compares in constant time.
 *
 *   K_sign = HKDF-SHA256, IKM = the secret's UTF-8 bytes (surrounding whitespace trimmed — a value
 *   pasted from `openssl rand -base64 48 | pbcopy` carries a newline), salt = empty, L = 32,
 *   info = "mm-sign-v1".
 *
 * There is no sign-in hand-off any more (owner decision 2026-10-02: MAD's 🎚 buttons and the
 * left-menu item are plain links to MIXER_URL; listeners sign in on the Mixer with their code).
 *
 * docs/mixer-bridge-vectors.json holds the algorithm and fixed-input vectors; the Vercel repo tests
 * against the same file, so the two sides cannot drift apart silently.
 */
import crypto from 'node:crypto';
import { timingSafeEqualStr } from './crypto-utils.js';

export const SIGN_INFO = 'mm-sign-v1';
export const MAX_SKEW_S = 60;

export const mixerSharedSecret = () => String(process.env.MIXER_SHARED_SECRET || '').trim();

/**
 * Mad Mixer's public address (MIXER_URL), normalised to origin + path without a trailing slash,
 * or '' when unset or unusable. https only — plain http is accepted for localhost testing.
 */
export function mixerPublicUrl(value = process.env.MIXER_URL) {
  const v = String(value || '').trim();
  if (!v) return '';
  let u;
  try { u = new URL(v); } catch { return ''; }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return '';
  if (u.username || u.password || u.search || u.hash) return '';
  return (u.origin + u.pathname).replace(/\/+$/, '');
}

// The key is derived once per secret value, not per request.
let derived = { secret: null, sign: null };
export function deriveKeys(secret = mixerSharedSecret()) {
  const s = String(secret || '').trim();
  if (!s) throw new Error('MIXER_SHARED_SECRET is not set');
  if (derived.secret !== s) {
    derived = { secret: s, sign: Buffer.from(crypto.hkdfSync('sha256', Buffer.from(s, 'utf8'), Buffer.alloc(0), Buffer.from(SIGN_INFO, 'utf8'), 32)) };
  }
  return { sign: derived.sign };
}

const toBuf = (body) => (Buffer.isBuffer(body) ? body : Buffer.from(body == null ? '' : String(body), 'utf8'));
export const bodyHash = (body) => crypto.createHash('sha256').update(toBuf(body)).digest('hex');

export const canonicalRequest = ({ ts, method, path, body }) =>
  `${ts}\n${String(method || '').toUpperCase()}\n${path}\n${bodyHash(body)}`;

/** X-MM-Sig for one request. `ts` is Unix seconds (number or decimal string). */
export function signRequest({ ts, method, path, body }, secret) {
  const { sign } = deriveKeys(secret);
  return crypto.createHmac('sha256', sign).update(canonicalRequest({ ts, method, path, body })).digest('base64url');
}

/**
 * Check X-MM-Ts / X-MM-Sig. Returns { ok: true } or { ok: false, reason } where reason is
 * 'missing' | 'skew' | 'bad-signature'. `now` is in ms (tests pin it).
 */
export function verifyRequest({ ts, sig, method, path, body, now = Date.now() }, secret) {
  const t = String(ts ?? '');
  if (!/^\d{1,12}$/.test(t) || typeof sig !== 'string' || !sig) return { ok: false, reason: 'missing' };
  if (Math.abs(Math.floor(now / 1000) - Number(t)) > MAX_SKEW_S) return { ok: false, reason: 'skew' };
  const want = signRequest({ ts: t, method, path, body }, secret);
  return timingSafeEqualStr(sig, want) ? { ok: true } : { ok: false, reason: 'bad-signature' };
}
