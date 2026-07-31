import { describe, it, expect, beforeAll } from 'vitest';
import { ipIsPrivate, hostnameResolvesPrivate, isSameOrigin } from '../../lib/ssrf-guard.js';

// Regression guards for the container resolver hardening.
//
// 1. Whether to attach the FileMaker bearer token was decided with a string
//    prefix test rather than an origin comparison, so hosts that merely began
//    with the configured origin were treated as trusted.
// 2. The track container route took `layout`/`field` from the query string and
//    returned the raw value of any field on any layout, with no allowlist.
//
// Hostnames here are RFC-reserved placeholders, and every case uses IP literals
// or reserved domains — no live DNS dependency, no real infrastructure named.

describe('isSameOrigin (bearer-token attachment)', () => {
  const HOST = 'https://data.example.test';

  it('rejects a host that merely starts with the trusted origin', () => {
    // A prefix test returns true for this; an origin comparison must not.
    expect('https://data.example.test.attacker.example/x'.startsWith(HOST)).toBe(true);
    expect(isSameOrigin('https://data.example.test.attacker.example/x', HOST)).toBe(false);
  });

  it('rejects a userinfo-prefixed URL that resolves to another host', () => {
    expect('https://data.example.test@attacker.example/x'.startsWith(HOST)).toBe(true);
    expect(isSameOrigin('https://data.example.test@attacker.example/x', HOST)).toBe(false);
  });

  it('rejects a scheme downgrade and a port change', () => {
    expect(isSameOrigin('http://data.example.test/x', HOST)).toBe(false);
    expect(isSameOrigin('https://data.example.test:8443/x', HOST)).toBe(false);
  });

  it('still accepts genuine same-origin URLs', () => {
    expect(isSameOrigin(`${HOST}/fmi/data/vLatest/databases/x/layouts/y`, HOST)).toBe(true);
    expect(isSameOrigin(`${HOST}/Streaming_SSL/foo.mp3?RCType=RCFileProcessor`, HOST)).toBe(true);
  });

  it('is false for malformed input rather than throwing', () => {
    expect(isSameOrigin('not-a-url', HOST)).toBe(false);
    expect(isSameOrigin('', HOST)).toBe(false);
    expect(isSameOrigin(`${HOST}/x`, '')).toBe(false);
  });
});

describe('SSRF guard (private address detection)', () => {
  it('flags private and loopback IPv4 literals', () => {
    for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '0.0.0.0']) {
      expect(ipIsPrivate(ip), ip).toBe(true);
    }
  });

  it('flags IPv6 loopback, link-local and IPv4-mapped private addresses', () => {
    for (const ip of ['::1', '::', 'fe80::1', 'fc00::1', 'fd00::1', '::ffff:127.0.0.1']) {
      expect(ipIsPrivate(ip), ip).toBe(true);
    }
  });

  it('allows ordinary public addresses', () => {
    expect(ipIsPrivate('93.184.216.34')).toBe(false);
    expect(ipIsPrivate('2606:2800:220:1:248:1893:25c8:1946')).toBe(false);
  });

  it('treats non-IP garbage as unsafe', () => {
    expect(ipIsPrivate('not-an-ip')).toBe(true);
    expect(ipIsPrivate('')).toBe(true);
  });

  it('blocks hostnames the old string regex missed', async () => {
    // `0.0.0.0` is loopback on Linux; Node reports IPv6 hosts bracketed, which
    // the previous /^::1$/ pattern never matched.
    await expect(hostnameResolvesPrivate('0.0.0.0')).resolves.toBe(true);
    await expect(hostnameResolvesPrivate('[::1]')).resolves.toBe(true);
    await expect(hostnameResolvesPrivate('127.0.0.1')).resolves.toBe(true);
    await expect(hostnameResolvesPrivate('169.254.169.254')).resolves.toBe(true);
    await expect(hostnameResolvesPrivate('localhost')).resolves.toBe(true);
    await expect(hostnameResolvesPrivate('foo.internal')).resolves.toBe(true);
    await expect(hostnameResolvesPrivate('')).resolves.toBe(true);
  });
});

describe('container resolver layout/field allowlist', () => {
  let isAllowedLayout, isAllowedAudioField, resolveTrackAudio, FM_LAYOUT, containerUrlCache;

  beforeAll(async () => {
    ({ isAllowedLayout, isAllowedAudioField, resolveTrackAudio } = await import('../../routes/stream.js'));
    ({ FM_LAYOUT } = await import('../../lib/fm-fields.js'));
    ({ containerUrlCache } = await import('../../cache.js'));
  });

  it('permits only the main track layout', () => {
    expect(isAllowedLayout(FM_LAYOUT)).toBe(true);
    for (const layout of ['API_Access_Tokens', 'API_Download_Purchases', 'API_Users', '', 'api_album_songs']) {
      expect(isAllowedLayout(layout), layout).toBe(false);
    }
  });

  it('permits only known audio fields', () => {
    expect(isAllowedAudioField('S3_URL')).toBe(true);
    expect(isAllowedAudioField('Tape Files::S3_URL')).toBe(true);
    for (const field of ['Token_Code', 'Issued_To', 'Expiration_Date', 'Email', '']) {
      expect(isAllowedAudioField(field), field).toBe(false);
    }
  });

  it('ignores a disallowed layout/field instead of reading them from FileMaker', async () => {
    // Seeded on the ALLOWED layout only. If the resolver honoured the caller's
    // layout it would miss this entry and attempt a live FM read of the access
    // token table; instead it coerces and returns the seeded audio URL.
    containerUrlCache.set(`${FM_LAYOUT}::424242`, {
      url: 'https://example.invalid/audio.mp3', field: 'S3_URL', artworkUrl: ''
    });

    const resolved = await resolveTrackAudio('424242', 'API_Access_Tokens', {
      requestedField: 'Token_Code',
      candidates: ['Issued_To']
    });

    expect(resolved.ok).toBe(true);
    expect(resolved.url).toBe('https://example.invalid/audio.mp3');
    expect(resolved.field).toBe('S3_URL');
  });
});
