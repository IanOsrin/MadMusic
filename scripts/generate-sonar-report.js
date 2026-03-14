#!/usr/bin/env node
// Generates a fresh HTML report from SonarQube API data
// Usage: node scripts/generate-sonar-report.js

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const HOST        = 'http://localhost:9000';
const PROJECT_KEY = 'madmusic';
const OUT_FILE    = path.join(__dirname, '..', 'sonarqube-report.html');

// Read password from command line arg or prompt
let AUTH;
if (process.argv[2]) {
  AUTH = `admin:${process.argv[2]}`;
} else {
  // Try to read from stdin
  const { execSync } = await import('node:child_process');
  const pass = execSync('read -sp "SonarQube password: " pass && echo $pass', { shell: '/bin/bash' }).toString().trim();
  AUTH = `admin:${pass}`;
}

async function api(path) {
  const res = await fetch(`${HOST}${path}`, {
    headers: { Authorization: 'Basic ' + Buffer.from(AUTH).toString('base64') }
  });
  if (!res.ok) throw new Error(`API error ${res.status}: ${path}`);
  return res.json();
}

async function fetchAllIssues() {
  let issues = [], page = 1;
  while (true) {
    const data = await api(
      `/api/issues/search?componentKeys=${PROJECT_KEY}&ps=500&p=${page}&statuses=OPEN,CONFIRMED,REOPENED`
    );
    issues = issues.concat(data.issues);
    if (issues.length >= data.paging.total) break;
    page++;
  }
  return issues;
}

function escHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

async function main() {
  console.log('📡 Fetching data from SonarQube...');

  const [metricsData, issuesRaw, hotspotsData] = await Promise.all([
    api(`/api/measures/component?component=${PROJECT_KEY}&metricKeys=bugs,vulnerabilities,code_smells,security_hotspots,coverage,duplicated_lines_density,ncloc,reliability_rating,security_rating,sqale_rating`),
    fetchAllIssues(),
    api(`/api/hotspots/search?projectKey=${PROJECT_KEY}&ps=500`)
  ]);

  // Parse metrics
  const m = {};
  for (const measure of metricsData.component.measures) {
    m[measure.metric] = measure.value;
  }

  const ratingLabel = v => ['', 'A', 'B', 'C', 'D', 'E'][Number.parseInt(v)] || '?';
  const ratingClass = v => ['', 'a', 'b', 'c', 'd', 'e'][Number.parseInt(v)] || '';

  // Group issues by type & severity
  const bugs         = issuesRaw.filter(i => i.type === 'BUG');
  const vulns        = issuesRaw.filter(i => i.type === 'VULNERABILITY');
  const smells       = issuesRaw.filter(i => i.type === 'CODE_SMELL');
  const hotspots     = hotspotsData.hotspots || [];

  const severityOrder = { BLOCKER: 0, CRITICAL: 1, MAJOR: 2, MINOR: 3, INFO: 4 };
  const sortBySeverity = arr => arr.sort((a, b) =>
    (severityOrder[a.severity] ?? 99) - (severityOrder[b.severity] ?? 99)
  );

  const issueRow = i => {
    const sev = (i.severity || '').toLowerCase();
    const file = (i.component || '').split(':').pop();
    const line = i.textRange?.startLine ? `:${i.textRange.startLine}` : '';
    return `<tr>
      <td><span class="sev ${sev}">${i.severity || ''}</span></td>
      <td>${escHtml(i.message || '')}</td>
      <td class="mono">${escHtml(file)}${line}</td>
    </tr>`;
  };

  const hotspotRow = h => {
    const file = (h.component || '').split(':').pop();
    const line = h.textRange?.startLine ? `:${h.textRange.startLine}` : '';
    return `<tr>
      <td><span class="sev major">${h.vulnerabilityProbability || 'MEDIUM'}</span></td>
      <td>${escHtml(h.message || '')}</td>
      <td class="mono">${escHtml(file)}${line}</td>
    </tr>`;
  };

  function issueTable(items, label) {
    if (!items.length) return `<p class="empty">No ${label} found ✅</p>`;
    return `<table>
      <thead><tr><th>Severity</th><th>Message</th><th>Location</th></tr></thead>
      <tbody>${sortBySeverity([...items]).map(issueRow).join('')}</tbody>
    </table>`;
  }

  function hotspotTable(items) {
    if (!items.length) return `<p class="empty">No hotspots found ✅</p>`;
    return `<table>
      <thead><tr><th>Priority</th><th>Message</th><th>Location</th></tr></thead>
      <tbody>${items.map(hotspotRow).join('')}</tbody>
    </table>`;
  }

  const now = new Date().toLocaleString('en-GB', { dateStyle: 'long', timeStyle: 'short' });

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>MASS Music — SonarQube Report</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f4f5f7;color:#172b4d;line-height:1.5}
    header{background:#0052cc;color:#fff;padding:20px 32px;display:flex;align-items:center;gap:16px}
    header .logo{font-size:22px;font-weight:700;letter-spacing:-.5px}
    header .subtitle{font-size:13px;opacity:.8;margin-top:2px}
    header .badge{margin-left:auto;background:rgba(255,255,255,.15);border-radius:6px;padding:6px 14px;font-size:12px;font-weight:600}
    .summary{display:flex;gap:12px;padding:24px 32px 8px;flex-wrap:wrap}
    .card{background:#fff;border-radius:8px;padding:18px 22px;flex:1;min-width:150px;box-shadow:0 1px 3px rgba(0,0,0,.08);border-top:4px solid #dfe1e6}
    .card .num{font-size:36px;font-weight:700;line-height:1}
    .card .label{font-size:13px;color:#5e6c84;margin-top:4px}
    .card .rating{display:inline-block;margin-top:8px;border-radius:4px;padding:2px 8px;font-size:12px;font-weight:700;color:#fff}
    .rating.a{background:#00875a}.rating.b{background:#00875a}.rating.c{background:#f89c20}
    .rating.d{background:#e5404a}.rating.e{background:#e5404a;color:#fff}
    .card.bugs{border-color:#e5404a}.card.bugs .num{color:#e5404a}
    .card.vulns{border-color:#f7c948}.card.vulns .num{color:#c9a800}
    .card.hotspot{border-color:#f89c20}.card.hotspot .num{color:#f89c20}
    .card.smells{border-color:#6554c0}.card.smells .num{color:#6554c0}
    .card.coverage{border-color:#00875a}.card.coverage .num{color:#00875a}
    .card.dupes{border-color:#0052cc}.card.dupes .num{color:#0052cc}
    section{padding:16px 32px}
    section h2{font-size:15px;font-weight:700;color:#5e6c84;text-transform:uppercase;letter-spacing:.5px;margin-bottom:12px;padding-bottom:6px;border-bottom:1px solid #dfe1e6}
    table{width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08);font-size:13.5px}
    thead th{background:#f4f5f7;padding:10px 14px;text-align:left;font-weight:600;color:#5e6c84;font-size:12px;text-transform:uppercase;letter-spacing:.4px}
    tbody tr{border-top:1px solid #f4f5f7}
    tbody tr:hover{background:#f8f9ff}
    td{padding:10px 14px;vertical-align:top}
    .sev{display:inline-block;border-radius:3px;padding:2px 8px;font-size:11px;font-weight:700;white-space:nowrap}
    .sev.blocker{background:#e5404a;color:#fff}
    .sev.critical{background:#ff6b6b;color:#fff}
    .sev.major{background:#f7c948;color:#172b4d}
    .sev.minor{background:#dfe1e6;color:#172b4d}
    .sev.info{background:#e3fcef;color:#00875a}
    .sev.high{background:#e5404a;color:#fff}
    .sev.medium{background:#f7c948;color:#172b4d}
    .sev.low{background:#dfe1e6;color:#172b4d}
    .mono{font-family:monospace;font-size:12px;color:#5e6c84}
    .empty{color:#5e6c84;font-style:italic;padding:12px 0}
    footer{text-align:center;padding:24px;font-size:12px;color:#5e6c84}
  </style>
</head>
<body>

<header>
  <div>
    <div class="logo">MASS Music</div>
    <div class="subtitle">SonarQube Code Quality Report · ${now}</div>
  </div>
  <div class="badge">Community Build v26.3.0.120487</div>
</header>

<div class="summary">
  <div class="card bugs">
    <div class="num">${m.bugs ?? 0}</div>
    <div class="label">Bugs</div>
    <span class="rating ${ratingClass(m.reliability_rating)}">${ratingLabel(m.reliability_rating)}</span>
  </div>
  <div class="card vulns">
    <div class="num">${m.vulnerabilities ?? 0}</div>
    <div class="label">Vulnerabilities</div>
    <span class="rating ${ratingClass(m.security_rating)}">${ratingLabel(m.security_rating)}</span>
  </div>
  <div class="card hotspot">
    <div class="num">${m.security_hotspots ?? 0}</div>
    <div class="label">Security Hotspots</div>
  </div>
  <div class="card smells">
    <div class="num">${m.code_smells ?? 0}</div>
    <div class="label">Code Smells</div>
    <span class="rating ${ratingClass(m.sqale_rating)}">${ratingLabel(m.sqale_rating)}</span>
  </div>
  <div class="card coverage">
    <div class="num">${Number.parseFloat(m.coverage ?? 0).toFixed(1)}%</div>
    <div class="label">Coverage</div>
  </div>
  <div class="card dupes">
    <div class="num">${Number.parseFloat(m.duplicated_lines_density ?? 0).toFixed(1)}%</div>
    <div class="label">Duplications</div>
  </div>
</div>

<section>
  <h2>🐛 Bugs (${bugs.length})</h2>
  ${issueTable(bugs, 'bugs')}
</section>

<section>
  <h2>🔒 Vulnerabilities (${vulns.length})</h2>
  ${issueTable(vulns, 'vulnerabilities')}
</section>

<section>
  <h2>🔥 Security Hotspots (${hotspots.length})</h2>
  ${hotspotTable(hotspots)}
</section>

<section>
  <h2>🧹 Code Smells (${smells.length})</h2>
  ${issueTable(smells, 'code smells')}
</section>

<footer>
  Generated ${now} · SonarQube Community Build v26.3.0.120487 · Project: ${PROJECT_KEY} · ${m.ncloc ?? '?'} lines of code
</footer>

</body>
</html>`;

  fs.writeFileSync(OUT_FILE, html, 'utf8');
  console.log(`✅ Report saved to: ${OUT_FILE}`);
  console.log(`   Bugs: ${m.bugs}  Vulns: ${m.vulnerabilities}  Smells: ${m.code_smells}  Hotspots: ${m.security_hotspots}`);
}

try {
  await main();
} catch (err) {
  console.error('❌', err.message);
  process.exit(1);
}
