#!/usr/bin/env node

const baseUrl = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:3000';

async function requestJson(path, label) {
  const url = baseUrl.replace(/\/$/, '') + path;
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  const text = await res.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch (err) {
      const parseErr = new Error(`Invalid JSON for ${label}: ${err.message}`);
      parseErr.responseText = text;
      throw parseErr;
    }
  } else {
    body = {};
  }
  if (!res.ok) {
    const err = new Error(body?.detail || body?.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.body = body;
    err.url = url;
    throw err;
  }
  return body;
}

function logOk(label, extra) {
  if (extra) {
    console.log(`[smoke] ${label}: ok`, extra);
  } else {
    console.log(`[smoke] ${label}: ok`);
  }
}

async function main() {
  const failures = [];

  async function step(label, fn) {
    try {
      await fn();
    } catch (err) {
      failures.push({ label, err });
    }
  }

  await step('health', async () => {
    const body = await requestJson('/api/health', 'health');
    logOk('health', { uptime: body?.uptime });
  });

  await step('artist-search', async () => {
    const query = process.env.SMOKE_ARTIST || 'test';
    const body = await requestJson(`/api/search?artist=${encodeURIComponent(query)}&limit=1`, 'artist');
    if (!Array.isArray(body?.items)) {
      throw new Error('Artist search response missing items array');
    }
    logOk('artist-search', { items: body.items.length });
  });

  if (failures.length) {
    console.error('[smoke] failures detected');
    for (const { label, err } of failures) {
      console.error(` - ${label}: ${err.message}`);
      if (err.status) console.error(`   status: ${err.status}`);
      if (err.body) console.error(`   body: ${JSON.stringify(err.body)}`);
      if (err.responseText) console.error(`   response: ${err.responseText}`);
      if (err.url) console.error(`   url: ${err.url}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log('[smoke] all checks passed');
}

main().catch(err => {
  console.error('[smoke] unexpected error', err);
  process.exitCode = 1;
});
