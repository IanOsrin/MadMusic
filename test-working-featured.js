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

// Get a working featured album - "Dinner At Eight"
const findResp = await fetch(`${FM_HOST}/fmi/data/vLatest/databases/${encodeURIComponent(FM_DB)}/layouts/${encodeURIComponent(FM_LAYOUT)}/_find`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    query: [{ 'Tape Files::Album Title': 'Dinner At Eight' }],
    limit: 1
  })
});

const findData = await findResp.json();
const dinnerRecord = findData.response?.data?.[0];

console.log('Working Featured Album - "Dinner At Eight":');
console.log('  Record ID:', dinnerRecord.recordId);
console.log('  Featured value:', JSON.stringify(dinnerRecord.fieldData['Tape Files::Featured']));
console.log('  Featured type:', typeof dinnerRecord.fieldData['Tape Files::Featured']);

// Now fetch that same record by ID
const byIdResp = await fetch(`${FM_HOST}/fmi/data/vLatest/databases/${encodeURIComponent(FM_DB)}/layouts/${encodeURIComponent(FM_LAYOUT)}/records/${dinnerRecord.recordId}`, {
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  }
});

const byIdData = await byIdResp.json();
const byIdRecord = byIdData.response?.data?.[0];

console.log('\nSame record fetched by ID:');
console.log('  Featured value:', JSON.stringify(byIdRecord.fieldData['Tape Files::Featured']));
console.log('  Featured type:', typeof byIdRecord.fieldData['Tape Files::Featured']);

// Logout
await fetch(`${FM_HOST}/fmi/data/vLatest/databases/${encodeURIComponent(FM_DB)}/sessions/${token}`, {
  method: 'DELETE'
});
