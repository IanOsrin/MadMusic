import { fetch } from 'undici';
import 'dotenv/config';

const FM_HOST = process.env.FM_HOST;
const FM_DB = process.env.FM_DB;
const FM_USER = process.env.FM_USER;
const FM_PASS = process.env.FM_PASS;
const FM_LAYOUT = 'API_Album_Songs';

// Login to FileMaker
const loginResp = await fetch(`${FM_HOST}/fmi/data/vLatest/databases/${encodeURIComponent(FM_DB)}/sessions`, {
  method: 'POST',
  headers: {
    'Authorization': `Basic ${Buffer.from(`${FM_USER}:${FM_PASS}`).toString('base64')}`,
    'Content-Type': 'application/json'
  }
});

const loginData = await loginResp.json();
const token = loginData.response?.token;

if (!token) {
  console.error('Failed to get token:', loginData);
  process.exit(1);
}

console.log('✓ Got FileMaker token');

// Query for Lengane album (record 94492)
const findResp = await fetch(`${FM_HOST}/fmi/data/vLatest/databases/${encodeURIComponent(FM_DB)}/layouts/${encodeURIComponent(FM_LAYOUT)}/records/94492`, {
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  }
});

const findData = await findResp.json();

if (findData.response?.data?.[0]) {
  const record = findData.response.data[0];
  const fields = record.fieldData;
  console.log('\nLengane Album (Record 94492):');
  console.log('  Album:', fields['Tape Files::Album Title']);
  console.log('  Featured field value:', JSON.stringify(fields['Tape Files::Featured']));
  console.log('  Featured field type:', typeof fields['Tape Files::Featured']);
  console.log('  Featured field length:', (fields['Tape Files::Featured'] || '').length);
  console.log('  Raw Featured:', fields['Tape Files::Featured']);
}

// Now query for featured albums
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
console.log('\n\nFeatured albums query:');
console.log('  Found:', featuredData.response?.dataInfo?.foundCount || 0);
console.log('  Returned:', (featuredData.response?.data || []).length);

// Check if Lengane or Singles are in the results
const items = featuredData.response?.data || [];
const lengane = items.find(i => (i.fieldData['Tape Files::Album Title'] || '').includes('Lengane'));
const singles = items.find(i => (i.fieldData['Tape Files::Album Title'] || '').includes('Singles') || (i.fieldData['Tape Files::Album Title'] || '').includes('Taxman'));

console.log('  Contains Lengane?', !!lengane);
console.log('  Contains Singles/Taxman?', !!singles);

// Logout
await fetch(`${FM_HOST}/fmi/data/vLatest/databases/${encodeURIComponent(FM_DB)}/sessions/${token}`, {
  method: 'DELETE'
});

console.log('\n✓ Done');
