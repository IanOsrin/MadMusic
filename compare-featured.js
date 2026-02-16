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

// Get all featured records
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

console.log('Analyzing all 70 featured records...\n');

// Group by whether Featured field is populated
const withValue = [];
const withoutValue = [];

items.forEach(record => {
  const featuredValue = record.fieldData['Tape Files::Featured'] || '';
  const album = record.fieldData['Tape Files::Album Title'] || '';
  const catalogue = record.fieldData['Album Catalogue Number'] || '';

  if (featuredValue.trim()) {
    withValue.push({ album, catalogue, value: featuredValue });
  } else {
    withoutValue.push({ album, catalogue, recordId: record.recordId });
  }
});

console.log(`Records WITH Featured="yes" in field: ${withValue.length}`);
// Group by album
const withValueByAlbum = {};
withValue.forEach(r => {
  if (!withValueByAlbum[r.catalogue]) {
    withValueByAlbum[r.catalogue] = { album: r.album, catalogue: r.catalogue, count: 0 };
  }
  withValueByAlbum[r.catalogue].count++;
});

Object.values(withValueByAlbum).forEach(a => {
  console.log(`  - ${a.album} (${a.catalogue}): ${a.count} tracks`);
});

console.log(`\nRecords WITHOUT Featured value in field (empty): ${withoutValue.length}`);
// Group by album
const withoutValueByAlbum = {};
withoutValue.forEach(r => {
  if (!withoutValueByAlbum[r.catalogue]) {
    withoutValueByAlbum[r.catalogue] = { album: r.album, catalogue: r.catalogue, count: 0 };
  }
  withoutValueByAlbum[r.catalogue].count++;
});

Object.values(withoutValueByAlbum).forEach(a => {
  console.log(`  - ${a.album} (${a.catalogue}): ${a.count} tracks`);
});

// Now check: Do the empty ones have a different field name or table occurrence?
console.log('\n\nChecking first empty record for all field names containing "featured":');
if (withoutValue.length > 0) {
  const recordId = withoutValue[0].recordId;
  const byIdResp = await fetch(`${FM_HOST}/fmi/data/vLatest/databases/${encodeURIComponent(FM_DB)}/layouts/${encodeURIComponent(FM_LAYOUT)}/records/${recordId}`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  });

  const byIdData = await byIdResp.json();
  const record = byIdData.response?.data?.[0];

  const allFields = Object.keys(record.fieldData);
  const featuredFields = allFields.filter(f => f.toLowerCase().includes('feature'));

  console.log('Featured-related fields:', featuredFields);
  featuredFields.forEach(field => {
    console.log(`  ${field}: "${record.fieldData[field]}"`);
  });
}

// Logout
await fetch(`${FM_HOST}/fmi/data/vLatest/databases/${encodeURIComponent(FM_DB)}/sessions/${token}`, {
  method: 'DELETE'
});
