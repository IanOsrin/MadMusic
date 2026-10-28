import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';

// HQ stems stream from MAD to the Mixer's page, so the browser must be let in from EVERY address the Mixer
// answers on. 2026-10-28: MIXER_URL was mad-mixer.vercel.app, the listener was on madmixerafrica.com, and every
// stem was refused ("The HQ stems couldn't be loaded just now").
let app;
const saved = process.env.MIXER_URL;

beforeAll(async () => {
  process.env.MIXER_URL = 'https://mad-mixer.vercel.app';
  const { createMixerHqAudioRouter } = await import('../../routes/mixer-hq-audio.js');
  app = express();
  app.use('/mixer-hq', createMixerHqAudioRouter());
});
afterAll(() => { if (saved === undefined) delete process.env.MIXER_URL; else process.env.MIXER_URL = saved; });

describe('HQ stem CORS', () => {
  for (const origin of ['https://madmixerafrica.com', 'https://mad-mixer.vercel.app']) {
    it(`lets the Mixer on ${origin} read a stem`, async () => {
      const pre = await request(app).options('/mixer-hq/1').set('Origin', origin);
      expect(pre.status).toBe(204);
      expect(pre.headers['access-control-allow-origin']).toBe(origin);
      const get = await request(app).get('/mixer-hq/1?exp=1&sig=x').set('Origin', origin);
      expect(get.headers['access-control-allow-origin']).toBe(origin);
    });
  }

  it('does not let any other site in', async () => {
    const res = await request(app).options('/mixer-hq/1').set('Origin', 'https://evil.example');
    expect(res.headers['access-control-allow-origin']).not.toBe('https://evil.example');
  });
});
