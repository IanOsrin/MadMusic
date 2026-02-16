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

// Query for featured albums
const featuredResp = await fetch(`${FM_HOST}/fmi/data/vLatest/databases/${encodeURIComponent(FM_DB)}/layouts/${encodeURIComponent(FM_LAYOUT)}/_find`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    query: [{ 'Tape Files::Featured': 'yes' }],
    limit: 100
  })
});

const featuredData = await featuredResp.json();
const items = featuredData.response?.data || [];

console.log(`Total featured records: ${items.length}\n`);

// Find Lengane records
const lenganeRecords = items.filter(i =>
  (i.fieldData['Tape Files::Album Title'] || '').toLowerCase().includes('lengane')
);

console.log(`Lengane records found: ${lenganeRecords.length}`);
lenganeRecords.forEach(r => {
  console.log(`  Record ${r.recordId}: Featured="${r.fieldData['Tape Files::Featured']}", Catalogue="${r.fieldData['Album Catalogue Number']}"`);
});

// Find Singles/Taxman records
const singlesRecords = items.filter(i => {
  const title = (i.fieldData['Tape Files::Album Title'] || '').toLowerCase();
  return title.includes('singles') || title.includes('taxman');
});

console.log(`\nSingles/Taxman records found: ${singlesRecords.length}`);
singlesRecords.forEach(r => {
  console.log(`  Record ${r.recordId}: Featured="${r.fieldData['Tape Files::Featured']}", Catalogue="${r.fieldData['Album Catalogue Number']}"`);
});

// Logout
await fetch(`${FM_HOST}/fmi/data/vLatest/databases/${encodeURIComponent(FM_DB)}/sessions/${token}`, {
  method: 'DELETE'
});
