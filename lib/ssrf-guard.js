/**
 * lib/ssrf-guard.js — SSRF protection for server-side fetches of client-supplied URLs.
 * No dependencies on other app modules.
 *
 * Any endpoint that fetches a URL the caller controls must run the target
 * hostname through `hostnameResolvesPrivate()` BEFORE fetching. A hostname
 * string regex is not sufficient: `169-254-169-254.nip.io` resolves to the
 * cloud metadata endpoint, `0.0.0.0` is loopback on Linux, and Node reports
 * IPv6 hosts in bracketed form (`[::1]`), which `/^::1$/` never matches.
 */

import dns from 'node:dns/promises';
import net from 'node:net';

// Decide whether a resolved IP address belongs to a private/internal range.
// Uses net.isIP + numeric checks so decimal/octal/hex/IPv4-mapped-IPv6 literals
// can't slip past a string regex.
export function ipIsPrivate(ip) {
  if (!ip) return true;
  const fam = net.isIP(ip);
  if (fam === 4) {
    const o = ip.split('.').map(Number);
    if (o.length !== 4 || o.some(n => Number.isNaN(n) || n < 0 || n > 255)) return true;
    if (o[0] === 10) return true;                              // 10.0.0.0/8
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true; // 172.16.0.0/12
    if (o[0] === 192 && o[1] === 168) return true;             // 192.168.0.0/16
    if (o[0] === 169 && o[1] === 254) return true;             // link-local
    if (o[0] === 127) return true;                             // loopback
    if (o[0] === 0) return true;                               // 0.0.0.0/8
    if (o[0] >= 224) return true;                              // multicast/reserved
    return false;
  }
  if (fam === 6) {
    const low = ip.toLowerCase();
    if (low === '::1' || low === '::') return true;
    if (low.startsWith('fe80') || low.startsWith('fc') || low.startsWith('fd')) return true;
    // IPv4-mapped IPv6 (::ffff:a.b.c.d) — re-check the embedded v4 address.
    const m = low.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return ipIsPrivate(m[1]);
    return false;
  }
  return true; // not a valid IP literal → treat as unsafe
}

// Resolve a hostname and return true if ANY resolved address is private/internal.
// This defeats DNS-rebinding (attacker domain → 169.254.169.254) and alternate
// IP encodings that a hostname-string regex would miss.
export async function hostnameResolvesPrivate(hostname) {
  if (!hostname) return true;
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal')) return true;
  if (net.isIP(h)) return ipIsPrivate(h);
  try {
    const records = await dns.lookup(h, { all: true });
    if (!records.length) return true;
    return records.some(r => ipIsPrivate(r.address));
  } catch {
    return true; // unresolvable → block
  }
}

/**
 * True when `url` is served by the same origin as `baseUrl`.
 *
 * Always compare parsed origins, never string prefixes. A configured host is a
 * bare origin with no trailing slash, so a `startsWith()` test also passes for
 * hostnames that merely BEGIN with it while resolving somewhere else entirely —
 * and for URLs that park the expected host in the userinfo section. Any request
 * that carries a credential must gate on the parsed origin, or that credential
 * can be steered to a third party.
 */
export function isSameOrigin(url, baseUrl) {
  if (!url || !baseUrl) return false;
  try {
    return new URL(url).origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}
