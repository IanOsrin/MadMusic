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

// Search for Music Sounds Of Africa
const findResp = await fetch(`${FM_HOST}/fmi/data/vLatest/databases/${encodeURIComponent(FM_DB)}/layouts/${encodeURIComponent(FM_LAYOUT)}/_find`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    query: [{ 'Tape Files::Album Title': 'Music Sounds Of Africa' }],
    limit: 10
  })
});

const findData = await findResp.json();
const record = findData.response?.data?.[0];

if (record) {
  const fields = record.fieldData;
  console.log('Music Sounds Of Africa:');
  console.log('  Album:', fields['Tape Files::Album Title']);
  console.log('  Featured:', fields['Tape Files::Featured']);
  console.log('  Artwork S3:', fields['Tape Files::Artwork_S3_URL']);
  console.log('  Has GMVi?:', (fields['Tape Files::Artwork_S3_URL'] || '').toLowerCase().includes('gmvi'));
}

// Logout
await fetch(`${FM_HOST}/fmi/data/vLatest/databases/${encodeURIComponent(FM_DB)}/sessions/${token}`, {
  method: 'DELETE'
});
