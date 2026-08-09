#!/usr/bin/env node
// Taster funnel report — reads data/taster-stats.json (cookie-free counters
// written by the server) and prints the staircase: landed → played → trials.
//
//   node scripts/taster-report.mjs [--days 28]
//
// Against production, fetch the same numbers with the admin key instead:
//   curl -H "X-Admin-Key: $ADMIN_SECRET" https://musicafricadirect.com/api/taster/report

import { readTasterStats } from '../lib/taster-stats.js';

const daysArg = process.argv.indexOf('--days');
const DAYS = daysArg > -1 ? parseInt(process.argv[daysArg + 1], 10) || 28 : 28;
const since = new Date(Date.now() - DAYS * 86400e3).toISOString().slice(0, 10);

const stats = await readTasterStats();
const days = Object.keys(stats).filter((d) => d >= since).sort();

if (!days.length) {
  console.log(`No taster activity recorded since ${since}.`);
  process.exit(0);
}

const byCampaign = {};
const byTrack = {};
for (const d of days) {
  for (const [campaign, b] of Object.entries(stats[d])) {
    const c = (byCampaign[campaign] ||= { land: 0, landMobile: 0, play: 0, trial: 0 });
    c.land += b.land || 0;
    c.landMobile += b.landMobile || 0;
    c.play += b.play || 0;
    c.trial += b.trial || 0;
    for (const [t, tb] of Object.entries(b.tracks || {})) {
      const tr = (byTrack[t] ||= { land: 0, play: 0 });
      tr.land += tb.land || 0;
      tr.play += tb.play || 0;
    }
  }
}

const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');
console.log(`Taster funnel — last ${DAYS} days (${days[0]} → ${days.at(-1)})\n`);
console.log('campaign          landed  (mobile)   played  play-rate   trials  trial-rate');
for (const [c, v] of Object.entries(byCampaign).sort((a, b) => b[1].land - a[1].land)) {
  console.log(
    c.padEnd(16),
    String(v.land).padStart(7),
    `(${v.landMobile})`.padStart(9),
    String(v.play).padStart(8),
    pct(v.play, v.land).padStart(10),
    String(v.trial).padStart(8),
    pct(v.trial, v.land).padStart(11)
  );
}

const topTracks = Object.entries(byTrack).sort((a, b) => b[1].land - a[1].land).slice(0, 15);
if (topTracks.length) {
  console.log('\ntop tracks (recordId)   landed   played');
  for (const [t, v] of topTracks) {
    console.log(t.padEnd(22), String(v.land).padStart(6), String(v.play).padStart(8));
  }
  console.log('\n(resolve a recordId to a song: /?t=<recordId> opens it in the app)');
}
