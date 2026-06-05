#!/usr/bin/env node
/**
 * scripts/fm-login-test.js — isolated FileMaker Data API login diagnostic.
 *
 * Tests ONLY the FM login (POST /sessions) using the same env vars and request
 * the app uses, and prints the exact HTTP status + FileMaker error code so we
 * can tell apart: wrong password, missing fmrest privilege, wrong DB name, a
 * disabled account, or a network/DNS problem.
 *
 * Run it WHERE THE CREDENTIALS LIVE:
 *   • Locally (uses your local .env):     node scripts/fm-login-test.js
 *   • On Render (uses the live env vars): open the Render Shell, then
 *                                         node scripts/fm-login-test.js
 *
 * It never prints your password — only its length, so it's safe to share output.
 */
import 'dotenv/config';

const FM_HOST = process.env.FM_HOST;
const FM_DB   = process.env.FM_DB;
const FM_USER = process.env.FM_USER;
const FM_PASS = process.env.FM_PASS;

function mask(v) {
  if (!v) return '(MISSING)';
  return `set, length ${v.length}`;
}

console.log('── FileMaker login diagnostic ──────────────────────────────');
console.log('FM_HOST :', FM_HOST || '(MISSING)');
console.log('FM_DB   :', FM_DB || '(MISSING)');
console.log('FM_USER :', FM_USER ? `"${FM_USER}"` : '(MISSING)');
console.log('FM_PASS :', mask(FM_PASS));
// Surface invisible whitespace that breaks pasted env values:
if (FM_USER && FM_USER !== FM_USER.trim()) console.log('  ⚠️  FM_USER has leading/trailing whitespace!');
if (FM_PASS && FM_PASS !== FM_PASS.trim()) console.log('  ⚠️  FM_PASS has leading/trailing whitespace!');
if (FM_PASS && /["']/.test(FM_PASS[0])) console.log('  ⚠️  FM_PASS starts with a quote — did a quote get pasted into the env value?');

if (!FM_HOST || !FM_DB || !FM_USER || !FM_PASS) {
  console.error('\n❌ One or more required env vars are missing. Fix those first.');
  process.exit(1);
}

const loginUrl = `${FM_HOST}/fmi/data/vLatest/databases/${encodeURIComponent(FM_DB)}/sessions`;
console.log('\nPOST', loginUrl);

const auth = 'Basic ' + Buffer.from(`${FM_USER}:${FM_PASS}`).toString('base64');

try {
  const res = await fetch(loginUrl, {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'Authorization': auth },
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(20000),
  });
  const json = await res.json().catch(() => ({}));
  const code = json?.messages?.[0]?.code;
  const msg  = json?.messages?.[0]?.message;

  console.log(`\nHTTP ${res.status}`);
  console.log('FileMaker code   :', code ?? '(none)');
  console.log('FileMaker message:', msg ?? '(none)');

  if (res.ok && json?.response?.token) {
    console.log('\n✅ SUCCESS — login worked and a Data API token was returned.');
    console.log('   The credentials AND the fmrest privilege are good. If the app');
    console.log('   still fails, the problem is the env var the APP reads (Render),');
    console.log('   not the credentials themselves.');
    process.exit(0);
  }

  console.log('\n❌ Login failed. Most likely cause for this code:');
  switch (String(code)) {
    case '212':
      console.log('   212 = "Invalid account/password". For a NEWLY CREATED user this');
      console.log('   is MOST OFTEN the missing Data API privilege, NOT a wrong password:');
      console.log('   → In FileMaker: Manage → Security → select the account\'s privilege');
      console.log('     set → Extended Privileges → tick "Access via FileMaker Data API');
      console.log('     (fmrest)". Save. Then re-run this test.');
      console.log('   If fmrest is already enabled, the password/username is wrong or has');
      console.log('   stray whitespace/quotes in the env value (see warnings above).');
      break;
    case '802':
      console.log('   802 = "Unable to open the file". The database name (FM_DB) is wrong,');
      console.log('   or the file isn\'t hosted/open on the server. Check FM_DB matches the');
      console.log('   hosted file name exactly (case-sensitive).');
      break;
    case '9':
    case '10':
      console.log('   9/10 = insufficient privileges. The account\'s privilege set lacks');
      console.log('   the access the Data API needs. Review the privilege set.');
      break;
    default:
      console.log('   (See https://help.claris.com → FileMaker error codes for this code.)');
  }
  process.exit(2);
} catch (err) {
  console.log('\n❌ Could not reach FileMaker at all (network/DNS/TLS), not an auth error:');
  console.log('  ', err.message);
  console.log('   → Check FM_HOST is correct and reachable from THIS machine, and that');
  console.log('     nothing (firewall/VPN) is blocking it. This is a connectivity issue,');
  console.log('     not a username/password issue.');
  process.exit(3);
}
