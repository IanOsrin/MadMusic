/**
 * lib/vision-read.js — READ-ONLY access to Vision (Gallo's S3-compatible master store) for Mad Mixer's HQ
 * stems (2026-10-08): listeners' stems stream from a dedicated Vision folder through MAD (routes/mixer-hq-audio.js).
 *
 * The same connection GalloIngest uses (lib/vision-drive.js there): VISION_ENDPOINT, VISION_ACCESS_KEY,
 * VISION_SECRET_KEY, VISION_REGION (default us-east-1), VISION_INSECURE_TLS=true for its self-signed
 * certificate, VISION_BUCKET to pin one bucket. Paths look like /bucket/folder/file.wav. Nothing here writes.
 */
import https from 'node:https';
import path from 'node:path';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';

const env = (k) => String(process.env[k] || '').trim();
export const visionConfigured = () => !!(env('VISION_ENDPOINT') && env('VISION_ACCESS_KEY') && env('VISION_SECRET_KEY'));

let client = null, clientFor = '';
function s3() {
  const endpoint = env('VISION_ENDPOINT').replace(/\/$/, ''), sig = `${endpoint}|${env('VISION_ACCESS_KEY')}`;
  if (!client || clientFor !== sig) {
    const insecure = env('VISION_INSECURE_TLS') === 'true' && endpoint.startsWith('https');
    client = new S3Client({
      endpoint, region: env('VISION_REGION') || 'us-east-1', forcePathStyle: true,
      credentials: { accessKeyId: env('VISION_ACCESS_KEY'), secretAccessKey: env('VISION_SECRET_KEY') },
      requestHandler: new NodeHttpHandler({ httpsAgent: new https.Agent({ keepAlive: true, rejectUnauthorized: !insecure }), connectionTimeout: 10_000, requestTimeout: 0 }),
    });
    clientFor = sig;
  }
  return client;
}

// "/bucket/a/b.wav" → { bucket, key }; ".." segments refused.
export function visionParse(rel) {
  const parts = path.posix.normalize('/' + String(rel || '/')).replace(/^\/+/, '').split('/').filter(Boolean);
  if (parts.includes('..')) throw new Error('Invalid path');
  const fixed = env('VISION_BUCKET');
  if (fixed) return { bucket: fixed, key: parts.join('/') };
  return { bucket: parts[0] || '', key: parts.slice(1).join('/') };
}

// GetObject (optionally a byte Range, e.g. "bytes=0-") → { Body (stream), ContentLength, ContentRange, … }
export async function visionGet(rel, range, signal) {
  const { bucket, key } = visionParse(rel);
  if (!bucket || !key) throw new Error('Not a file path');
  return s3().send(new GetObjectCommand({ Bucket: bucket, Key: key, Range: range || undefined }), { abortSignal: signal });
}
