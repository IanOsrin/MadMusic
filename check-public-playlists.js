import { fetch } from 'undici';
import 'dotenv/config';

const FM_HOST = process.env.FM_HOST;
const FM_DB = process.env.FM_DB;
const FM_USER = process.env.FM_USER;
const FM_PASS = process.env.FM_PASS;
const FM_LAYOUT = 'API_Album_Songs';

// Login
const loginResp = await fetch(`${FM_HOST}/fmi/data/vLatest/databases/${encodeURIComponent(FM_DB)}/sessions`, {
  method: 'POST',
  headers: {
    'Authorization': `Basic ${Buffer.from(`${FM_USER}:${FM_PASS}`).toString('base64')}`,
    'Content-Type': 'application/json'
  }
});

const loginData = await loginResp.json();
const token = loginData.response?.token;

console.log('Testing PublicPlaylist field...\n');

// Query for records with PublicPlaylist field
const publicResp = await fetch(`${FM_HOST}/fmi/data/vLatest/databases/${encodeURIComponent(FM_DB)}/layouts/${encodeURIComponent(FM_LAYOUT)}/_find`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    query: [{ 'PublicPlaylist': '*' }],
    limit: 10
  })
});

const publicData = await publicResp.json();

if (!publicResp.ok) {
  const msg = publicData?.messages?.[0]?.message || 'Error';
  const code = publicData?.messages?.[0]?.code;
  console.log(`❌ Query failed: ${msg} (code: ${code})`);
  console.log('\nThis might mean the PublicPlaylist field does not exist or is not on this layout.');
} else {
  const items = publicData.response?.data || [];
  console.log(`✓ Found ${items.length} records with PublicPlaylist field\n`);

  if (items.length > 0) {
    console.log('Sample records:');
    items.slice(0, 3).forEach((record, i) => {
      const fields = record.fieldData || {};
      const playlist = fields['PublicPlaylist'] || fields['Tape Files::PublicPlaylist'] || 'N/A';
      const album = fields['Tape Files::Album Title'] || 'N/A';
      const track = fields['Track Name'] || fields['Tape Files::Track Name'] || 'N/A';
      console.log(`  ${i + 1}. "${track}" from "${album}"`);
      console.log(`     PublicPlaylist: "${playlist}"`);
    });
  }
}

// Try alternative field names
console.log('\n\nTrying "Tape Files::PublicPlaylist"...');
const altResp = await fetch(`${FM_HOST}/fmi/data/vLatest/databases/${encodeURIComponent(FM_DB)}/layouts/${encodeURIComponent(FM_LAYOUT)}/_find`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    query: [{ 'Tape Files::PublicPlaylist': '*' }],
    limit: 10
  })
});

const altData = await altResp.json();

if (!altResp.ok) {
  const msg = altData?.messages?.[0]?.message || 'Error';
  const code = altData?.messages?.[0]?.code;
  console.log(`❌ Query failed: ${msg} (code: ${code})`);
} else {
  const items = altData.response?.data || [];
  console.log(`✓ Found ${items.length} records with Tape Files::PublicPlaylist field\n`);

  if (items.length > 0) {
    console.log('Sample records:');
    items.slice(0, 3).forEach((record, i) => {
      const fields = record.fieldData || {};
      const playlist = fields['Tape Files::PublicPlaylist'] || 'N/A';
      const album = fields['Tape Files::Album Title'] || 'N/A';
      const track = fields['Track Name'] || fields['Tape Files::Track Name'] || 'N/A';
      console.log(`  ${i + 1}. "${track}" from "${album}"`);
      console.log(`     Tape Files::PublicPlaylist: "${playlist}"`);
    });
  }
}

// Logout
await fetch(`${FM_HOST}/fmi/data/vLatest/databases/${encodeURIComponent(FM_DB)}/sessions/${token}`, {
  method: 'DELETE'
});

console.log('\n✓ Done');
