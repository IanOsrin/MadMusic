import { describe, it, expect } from 'vitest';
import { isContainerRedirectRequest } from '../../routes/stream.js';

// Covers on a results page are /api/container?u=<S3 url> 302s. They must not
// count against the general API limiter (2026-09-14: a few genre clicks 429'd
// the next search), but anything the route could PROXY still must.
const S3 = 'https://mass-music-audio-files.s3.eu-north-1.amazonaws.com/artwork/GMVi5595.jpg';

describe('isContainerRedirectRequest', () => {
  it('skips a plain cover redirect to the media bucket', () => {
    expect(isContainerRedirectRequest('/api/container', { u: S3 })).toBe(true);
    expect(isContainerRedirectRequest('/api/container', { u: 'https://s3.eu-north-1.amazonaws.com/mass-music-audio-files/mp3/GMVn1.mp3' })).toBe(true);
  });

  it('still counts anything that would be proxied', () => {
    expect(isContainerRedirectRequest('/api/container', { u: S3, proxy: '1' })).toBe(false);
    expect(isContainerRedirectRequest('/api/container', { rid: '12', field: 'Audio' })).toBe(false);
    expect(isContainerRedirectRequest('/api/container', { u: 'https://example.com/x.jpg' })).toBe(false);
    expect(isContainerRedirectRequest('/api/container', { u: 'not a url' })).toBe(false);
    expect(isContainerRedirectRequest('/api/container', {})).toBe(false);
  });

  it('only applies to /api/container', () => {
    expect(isContainerRedirectRequest('/api/search', { u: S3 })).toBe(false);
    expect(isContainerRedirectRequest('/api/track/1/container', { u: S3 })).toBe(false);
  });
});
