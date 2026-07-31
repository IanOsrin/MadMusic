/**
 * lib/cloudflare-ips.js — is a given address one of Cloudflare's edge IPs?
 * No dependencies on other app modules.
 *
 * Why this exists: `CF-Connecting-IP` is only meaningful when the request
 * actually arrived through Cloudflare. Cloudflare overwrites the header on
 * every request it proxies, so it cannot be forged *through* CF — but an origin
 * is not always reached through its CDN, and a client that connects by another
 * route can send whatever it likes. Rate limiting keyed on an unverified header
 * is therefore no rate limiting at all: rotate the value, get a fresh budget.
 * Worse, the header can be set to a *victim's* address to burn their budget.
 *
 * Usage: verify the peer BEFORE honouring the header —
 *   isCloudflareIp(req.ip) ? req.headers['cf-connecting-ip'] : req.ip
 * Under `trust proxy = 1` on Render, `req.ip` is the address Render itself
 * observed connecting (Cloudflare in normal operation, or the client directly
 * when someone bypasses CF). Render appends to X-Forwarded-For rather than
 * replacing it, so that position is not client-controllable.
 *
 * Ranges are Cloudflare's published lists (cloudflare.com/ips-v4, ips-v6).
 * They change rarely but they DO change — override with the CLOUDFLARE_IP_RANGES
 * env var (comma-separated CIDRs) if Cloudflare publishes new ones before this
 * list is updated.
 */

const DEFAULT_CF_RANGES = [
  // IPv4
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
  // IPv6
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32'
];

// ── address parsing ──────────────────────────────────────────────────────────

function v4ToBigInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    n = (n << 8n) | BigInt(octet);
  }
  return n;
}

function v6ToBigInt(ip) {
  let s = ip;

  // An embedded IPv4 tail (::ffff:1.2.3.4) becomes the low 32 bits.
  let v4Tail = 0n;
  let hasV4Tail = false;
  const lastColon = s.lastIndexOf(':');
  const tail = lastColon === -1 ? '' : s.slice(lastColon + 1);
  if (tail.includes('.')) {
    const parsed = v4ToBigInt(tail);
    if (parsed === null) return null;
    v4Tail = parsed;
    hasV4Tail = true;
    s = s.slice(0, lastColon + 1) + '0:0';
  }

  const doubleColon = s.indexOf('::');
  let groups;
  if (doubleColon !== -1) {
    if (s.indexOf('::', doubleColon + 1) !== -1) return null; // only one '::' allowed
    const left = s.slice(0, doubleColon).split(':').filter(Boolean);
    const right = s.slice(doubleColon + 2).split(':').filter(Boolean);
    const missing = 8 - (left.length + right.length);
    if (missing < 0) return null;
    groups = [...left, ...Array(missing).fill('0'), ...right];
  } else {
    groups = s.split(':');
  }
  if (groups.length !== 8) return null;

  let n = 0n;
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
    n = (n << 16n) | BigInt(parseInt(group, 16));
  }

  if (hasV4Tail) n = (n & ~0xffffffffn) | v4Tail;
  return n;
}

/**
 * Normalise an address to { version, value }. IPv4-mapped IPv6 addresses
 * (::ffff:1.2.3.4) are folded down to plain IPv4, since that is how a v4 client
 * arrives on a dual-stack listener.
 */
export function parseIp(input) {
  if (!input || typeof input !== 'string') return null;
  let s = input.trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^\[/, '').replace(/\]$/, '');   // bracketed IPv6
  s = s.replace(/%.*$/, '');                     // zone id
  if (s.includes(':')) {
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
    if (mapped) {
      const v4 = v4ToBigInt(mapped[1]);
      return v4 === null ? null : { version: 4, value: v4 };
    }
    const v6 = v6ToBigInt(s);
    return v6 === null ? null : { version: 6, value: v6 };
  }
  const v4 = v4ToBigInt(s);
  return v4 === null ? null : { version: 4, value: v4 };
}

function parseCidr(cidr) {
  const slash = cidr.lastIndexOf('/');
  if (slash === -1) return null;
  const addr = parseIp(cidr.slice(0, slash));
  const prefix = Number(cidr.slice(slash + 1));
  if (!addr || !Number.isInteger(prefix) || prefix < 0) return null;
  const width = addr.version === 4 ? 32 : 128;
  if (prefix > width) return null;
  const shift = BigInt(width - prefix);
  return { version: addr.version, network: addr.value >> shift, shift };
}

function loadRanges() {
  const raw = (process.env.CLOUDFLARE_IP_RANGES || '').trim();
  const list = raw ? raw.split(',').map(s => s.trim()).filter(Boolean) : DEFAULT_CF_RANGES;
  const parsed = [];
  for (const cidr of list) {
    const range = parseCidr(cidr);
    if (range) parsed.push(range);
    else console.warn(`[cloudflare-ips] ignoring unparseable CIDR: ${cidr}`);
  }
  return parsed;
}

let _ranges = null;

/** Re-read CLOUDFLARE_IP_RANGES. Exposed for tests. */
export function resetCloudflareRanges() {
  _ranges = null;
}

/** True when `ip` falls inside one of Cloudflare's published edge ranges. */
export function isCloudflareIp(ip) {
  const addr = parseIp(ip);
  if (!addr) return false;
  if (_ranges === null) _ranges = loadRanges();
  for (const range of _ranges) {
    if (range.version !== addr.version) continue;
    if ((addr.value >> range.shift) === range.network) return true;
  }
  return false;
}

/**
 * The best available client address for rate limiting.
 *
 * Honours CF-Connecting-IP only when the peer is Cloudflare; otherwise falls
 * back to the address the proxy chain actually observed. NEVER read
 * X-Forwarded-For's left-most entry for this — it is client-supplied in full,
 * so anything keyed on it can be rotated for a fresh budget.
 */
export function resolveClientIp(req) {
  const peer = req?.ip || req?.socket?.remoteAddress || '';
  const forwarded = req?.headers?.['cf-connecting-ip'];
  if (isCloudflareIp(peer)) {
    if (forwarded) return String(forwarded).trim();
  } else if (forwarded) {
    // Either someone is bypassing Cloudflare and forging the header (the attack
    // this guard exists for), or Cloudflare has published edge ranges newer than
    // DEFAULT_CF_RANGES. The second case is operationally serious: the header
    // would be ignored for ALL traffic and every visitor would collapse into one
    // req.ip bucket — the site-wide 429 of 2026-07-31. If this warns steadily
    // rather than occasionally, refresh the list or set CLOUDFLARE_IP_RANGES.
    warnUntrustedForwardedHeader(peer);
  }
  return peer;
}

let _lastWarnAt = 0;
let _suppressedWarns = 0;
function warnUntrustedForwardedHeader(peer) {
  const now = Date.now();
  if (now - _lastWarnAt < 60_000) { _suppressedWarns += 1; return; }
  const extra = _suppressedWarns ? ` (+${_suppressedWarns} more in the last minute)` : '';
  console.warn(
    `[cloudflare-ips] ignoring CF-Connecting-IP from non-Cloudflare peer ${peer || '(none)'}${extra} — ` +
    'expected if someone is hitting the origin directly; if it is constant, the CF range list is stale.'
  );
  _lastWarnAt = now;
  _suppressedWarns = 0;
}
