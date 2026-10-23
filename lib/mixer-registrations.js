/**
 * lib/mixer-registrations.js — song registrations from Mad Mixer (Ian, 2026-10-23: "Lets build a page for
 * registering songs"). Before a subscriber releases a song that uses Mixer material, they register it (the
 * Mad Mixer Sample & Stems Licence §5): the new song's details plus a full-quality copy. Ian checks each one
 * in FileMaker and sets Status to Confirmed; the Mixer page shows the status back to the subscriber.
 *
 * FileMaker: MADMixer table/layout "Registrations" (MADMIXER_FM_REG_LAYOUT to use another), one record per
 * registration, every field Text: Reg_ID, Submitted_At, Status, Account, Email, Plan, Original_Song_ID,
 * Original_Title, Original_Artist, Original_ISRC, Material, DCX_IDs, Seconds_Used, New_Title, New_Artist,
 * New_ISRC, Distributor, Release_Date, Writers, Notes, File_Key, File_Name, File_Bytes, Licence_Version,
 * MAD_Note, Confirmed_At. All must be ON the layout (a field missing from it is silently dropped).
 * Account = the Mixer's acct key (HMAC of the code) — the access code itself is never sent or stored.
 *
 * The copy goes straight from the browser to a PRIVATE S3 bucket on a presigned PUT, so MAD never carries
 * the bytes: MIXER_REG_S3_BUCKET, MIXER_REG_S3_REGION (default eu-north-1), MIXER_REG_S3_ACCESS_KEY,
 * MIXER_REG_S3_SECRET_KEY (an IAM user allowed s3:PutObject + s3:GetObject on that bucket only). The bucket
 * needs CORS allowing PUT from MIXER_URL. Key = registrations/<regId>/<file>; a registration is saved only
 * when that object is really there at the size the subscriber declared.
 *
 *   regStorageConfigured()                     → true when the four S3 settings are present
 *   presignS3({ method, bucket, region, key, … }) → a SigV4 query-signed URL (no SDK needed)
 *   uploadLink({ regId, file, bytes })         → { url, key, expiresAt } for a PUT, 1 hour
 *   uploadedBytes(key)                         → the object's size, or null when it isn't there
 *   createRegistration(fields)                 → writes the record (Status "Submitted")
 *   findRegistration(regId)                    → that record's summary, or null
 *   registrationsFor(acct)                     → [{ regId, status, … }] newest first (SWR 30 s per account)
 */
import crypto from 'node:crypto';
import { mmRequest } from './mixer-catalogue.js';
import { createSwrCache } from './swr-cache.js';

const env = (k) => String(process.env[k] || '').trim();
const regLayout = () => env('MADMIXER_FM_REG_LAYOUT') || 'Registrations';
const s3 = () => ({ bucket: env('MIXER_REG_S3_BUCKET'), region: env('MIXER_REG_S3_REGION') || 'eu-north-1', accessKeyId: env('MIXER_REG_S3_ACCESS_KEY'), secretAccessKey: env('MIXER_REG_S3_SECRET_KEY') });

export const REG_ID_RE = /^mmr_[A-Za-z0-9_-]{22}$/;
export const ACCT_RE = /^[a-f0-9]{64}$/;
export const AUDIO_FILE_RE = /\.(wav|aiff?|flac)$/i;
export const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;   // 1 GB: a long 24-bit stereo master fits
const UPLOAD_LINK_S = 3600;

export const regStorageConfigured = () => {
  const c = s3();
  return !!(c.accessKeyId && c.secretAccessKey && /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(c.bucket) && /^[a-z]{2}-[a-z]+-\d$/.test(c.region));
};

// ── S3 SigV4 query signing (AWS "Authenticating Requests: Using Query Parameters") ────────────────────
const hmac = (k, s) => crypto.createHmac('sha256', k).update(s, 'utf8').digest();
const sha256hex = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const amzDateOf = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

export function presignS3({ method, bucket, region, key, accessKeyId, secretAccessKey, expires, now = Date.now(), host }) {
  const h = host || `${bucket}.s3.${region}.amazonaws.com`;
  const path = '/' + String(key).split('/').map(enc).join('/');
  const amzDate = amzDateOf(now), day = amzDate.slice(0, 8);
  const scope = `${day}/${region}/s3/aws4_request`;
  const q = { 'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Credential': `${accessKeyId}/${scope}`, 'X-Amz-Date': amzDate, 'X-Amz-Expires': String(expires), 'X-Amz-SignedHeaders': 'host' };
  const query = Object.keys(q).sort().map((k) => `${enc(k)}=${enc(q[k])}`).join('&');
  const canonical = [method, path, query, `host:${h}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonical)].join('\n');
  const kSign = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, day), region), 's3'), 'aws4_request');
  return `https://${h}${path}?${query}&X-Amz-Signature=${hmac(kSign, toSign).toString('hex')}`;
}

// "My Song (Final mix).wav" → "My_Song_Final_mix_.wav" — only safe characters reach the key.
export const safeFileName = (name) => String(name || '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '').slice(-120) || 'song.wav';
export const uploadKey = (regId, file) => `registrations/${regId}/${safeFileName(file)}`;

export function uploadLink({ regId, file, bytes, now = Date.now() }) {
  const key = uploadKey(regId, file);
  const url = presignS3({ method: 'PUT', ...s3(), key, expires: UPLOAD_LINK_S, now });
  return { url, key, expiresAt: new Date(now + UPLOAD_LINK_S * 1000).toISOString(), bytes };
}

// HEAD on a 60-second signed link: 200 → its Content-Length; 403/404 → not there.
export async function uploadedBytes(key) {
  const url = presignS3({ method: 'HEAD', ...s3(), key, expires: 60 });
  const r = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(15_000) });
  if (r.status === 404 || r.status === 403) return null;
  if (!r.ok) throw new Error(`S3 HEAD ${r.status}`);
  const n = Number(r.headers.get('content-length'));
  return Number.isSafeInteger(n) ? n : null;
}

// ── FileMaker ────────────────────────────────────────────────────────────────────────────────────────
const noRecords = (err) => /no records|record is missing/i.test(String(err?.message));
const summary = (rec) => {
  const f = rec.fieldData || {};
  return {
    regId: String(f.Reg_ID || ''), status: String(f.Status || 'Submitted').trim() || 'Submitted', submittedAt: String(f.Submitted_At || ''),
    newTitle: String(f.New_Title || ''), newArtist: String(f.New_Artist || ''), newIsrc: String(f.New_ISRC || ''),
    originalTitle: String(f.Original_Title || ''), originalArtist: String(f.Original_Artist || ''),
    releaseDate: String(f.Release_Date || ''), fileName: String(f.File_Name || ''),
    madNote: String(f.MAD_Note || ''), confirmedAt: String(f.Confirmed_At || ''),
  };
};

async function find(query, limit = 200) {
  try {
    const resp = await mmRequest('POST', `/layouts/${encodeURIComponent(regLayout())}/_find`, { query: [query], limit });
    return resp.data || [];
  } catch (err) {
    if (noRecords(err)) return [];
    throw err;
  }
}

export async function findRegistration(regId) {
  const rows = await find({ Reg_ID: `==${regId}` }, 1);
  return rows.length ? summary(rows[0]) : null;
}

const listSwr = createSwrCache({
  name: 'mixer-registrations', label: 'mixer-registrations', ttlMs: 30_000, max: 2000,
  loader: async (acct) => (await find({ Account: `==${acct}` }))
    .map(summary).sort((a, b) => b.submittedAt.localeCompare(a.submittedAt)),
});
export const registrationsFor = async (acct) => (await listSwr.get(acct)).value;

// fields are already checked by the caller (routes/mixer-internal.js validateRegistration).
export async function createRegistration(f, now = Date.now()) {
  const fieldData = {
    Reg_ID: f.regId, Submitted_At: new Date(now).toISOString().replace('T', ' ').slice(0, 19) + ' UTC', Status: 'Submitted',
    Account: f.acct, Email: f.email, Plan: f.plan,
    Original_Song_ID: f.originalSongId, Original_Title: f.originalTitle, Original_Artist: f.originalArtist, Original_ISRC: f.originalIsrc,
    Material: f.material.join(', '), DCX_IDs: f.dcxIds.join(' '), Seconds_Used: String(f.secondsUsed),
    New_Title: f.newTitle, New_Artist: f.newArtist, New_ISRC: f.newIsrc, Distributor: f.distributor, Release_Date: f.releaseDate,
    Writers: f.writers, Notes: f.notes, File_Key: f.fileKey, File_Name: f.fileName, File_Bytes: String(f.fileBytes),
    Licence_Version: f.licenceVersion,
  };
  await mmRequest('POST', `/layouts/${encodeURIComponent(regLayout())}/records`, { fieldData });
  listSwr.cache.delete(f.acct);   // the subscriber sees it on their list at once
  return summary({ fieldData });
}
