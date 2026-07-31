import { describe, it, expect, afterEach } from 'vitest';
import { isCloudflareIp, resolveClientIp, parseIp, resetCloudflareRanges } from '../../lib/cloudflare-ips.js';

// Regression guard for finding 4 in AUDIT_2026-07-31.md: every rate limiter
// keyed on `req.headers['cf-connecting-ip'] || req.ip` without checking that the
// request actually came through Cloudflare. Rotating the header gave an
// unlimited budget (defeating the 10-per-15-min payment limiter and Maddie's
// Anthropic spend cap); setting it to a victim's address burned theirs.

const CF_PEER = '162.158.1.1';        // inside 162.158.0.0/15
const CF_PEER_V6 = '2606:4700::1';    // inside 2606:4700::/32
const DIRECT_PEER = '203.0.113.9';    // ordinary public address, not Cloudflare

afterEach(() => {
  delete process.env.CLOUDFLARE_IP_RANGES;
  resetCloudflareRanges();
});

describe('parseIp', () => {
  it('parses IPv4, IPv6, bracketed and zoned forms', () => {
    expect(parseIp('1.2.3.4')?.version).toBe(4);
    expect(parseIp('2606:4700::1')?.version).toBe(6);
    expect(parseIp('[2606:4700::1]')?.version).toBe(6);
    expect(parseIp('fe80::1%eth0')?.version).toBe(6);
  });

  it('folds IPv4-mapped IPv6 down to IPv4', () => {
    const mapped = parseIp('::ffff:162.158.1.1');
    expect(mapped?.version).toBe(4);
    expect(mapped?.value).toBe(parseIp('162.158.1.1')?.value);
  });

  it('rejects malformed input rather than throwing', () => {
    for (const bad of ['', 'nonsense', '1.2.3', '1.2.3.999', '::ffff::1', 'gggg::1', null, undefined]) {
      expect(parseIp(bad)).toBeNull();
    }
  });
});

describe('isCloudflareIp', () => {
  it('recognises addresses inside the published ranges', () => {
    for (const ip of ['162.158.1.1', '104.16.0.1', '173.245.48.1', '131.0.72.1', '2606:4700::1', '2400:cb00::5']) {
      expect(isCloudflareIp(ip), ip).toBe(true);
    }
  });

  it('rejects addresses outside them, including near-miss neighbours', () => {
    for (const ip of ['203.0.113.9', '8.8.8.8', '162.157.255.255', '162.160.0.1', '2606:4701::1', '']) {
      expect(isCloudflareIp(ip), ip).toBe(false);
    }
  });

  it('honours a CLOUDFLARE_IP_RANGES override', () => {
    process.env.CLOUDFLARE_IP_RANGES = '198.51.100.0/24';
    resetCloudflareRanges();
    expect(isCloudflareIp('198.51.100.7')).toBe(true);
    expect(isCloudflareIp('162.158.1.1')).toBe(false); // default list no longer applies
  });
});

describe('resolveClientIp', () => {
  const reqWith = (ip, headers = {}) => ({ ip, headers, socket: { remoteAddress: ip } });

  it('trusts CF-Connecting-IP when the peer really is Cloudflare', () => {
    expect(resolveClientIp(reqWith(CF_PEER, { 'cf-connecting-ip': '41.13.5.7' }))).toBe('41.13.5.7');
    expect(resolveClientIp(reqWith(CF_PEER_V6, { 'cf-connecting-ip': '41.13.5.7' }))).toBe('41.13.5.7');
  });

  it('IGNORES a spoofed CF-Connecting-IP from a direct-to-origin client', () => {
    // The attack: hit the Render origin directly and rotate this header.
    const spoofed = reqWith(DIRECT_PEER, { 'cf-connecting-ip': '1.2.3.4' });
    expect(resolveClientIp(spoofed)).toBe(DIRECT_PEER);

    // Rotating the header must not change the bucket.
    const keys = new Set(
      ['9.9.9.9', '8.8.8.8', '7.7.7.7'].map(v => resolveClientIp(reqWith(DIRECT_PEER, { 'cf-connecting-ip': v })))
    );
    expect(keys).toEqual(new Set([DIRECT_PEER]));
  });

  it('cannot be used to burn a victim\'s budget from outside Cloudflare', () => {
    const victim = '41.13.5.7';
    const attacker = resolveClientIp(reqWith(DIRECT_PEER, { 'cf-connecting-ip': victim }));
    expect(attacker).not.toBe(victim);
  });

  it('ignores X-Forwarded-For entirely (it is client-supplied in full)', () => {
    const req = reqWith(DIRECT_PEER, { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' });
    expect(resolveClientIp(req)).toBe(DIRECT_PEER);
  });

  it('falls back to the peer when Cloudflare sends no header', () => {
    expect(resolveClientIp(reqWith(CF_PEER, {}))).toBe(CF_PEER);
  });

  it('degrades safely on a malformed request object', () => {
    expect(resolveClientIp({})).toBe('');
    expect(resolveClientIp(undefined)).toBe('');
  });
});
