#!/usr/bin/env node
/**
 * resize-artwork.mjs — one-shot S3 artwork derivative generator.
 *
 * Reads master artwork (3000x3000 JPEGs from the Ingrooves spec) under a prefix
 * and writes smaller WebP derivatives next to them, under `<prefix>resized/`:
 *   artwork/GMVi4460.jpg  ->  artwork/resized/GMVi4460_300.webp   (cards/rails)
 *                            artwork/resized/GMVi4460_800.webp   (album detail)
 *
 * SAFETY: this NEVER modifies or deletes the masters. It only writes new objects
 * under the resized/ subprefix. Re-running is safe and idempotent (it skips keys
 * whose derivatives already exist, unless --force).
 *
 * ── Install (in this folder) ──
 *   npm install
 *
 * ── Credentials ──
 *   Uses the standard AWS credential chain: AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
 *   (+ AWS_REGION) in the environment, or an AWS profile (AWS_PROFILE). The IAM
 *   identity needs s3:ListBucket, s3:GetObject, s3:PutObject on the bucket.
 *
 * ── Usage ──
 *   node resize-artwork.mjs --dry-run --limit=10   # list what WOULD be done, no writes
 *   node resize-artwork.mjs --limit=10             # process just 10 (smoke test)
 *   node resize-artwork.mjs                         # full run
 *   node resize-artwork.mjs --force                 # regenerate even if derivatives exist
 *
 * ── Config via env (all optional; defaults match the observed bucket) ──
 *   ART_BUCKET       (default: mass-music-audio-files)
 *   AWS_REGION       (default: eu-north-1)
 *   ART_PREFIX       (default: artwork/)
 *   ART_SIZES        (default: 300,800)
 *   ART_QUALITY      (default: 80)
 *   ART_CONCURRENCY  (default: 8)
 */

import {
  S3Client, ListObjectsV2Command, GetObjectCommand,
  PutObjectCommand, HeadObjectCommand, CopyObjectCommand
} from '@aws-sdk/client-s3';
import sharp from 'sharp';
import pLimit from 'p-limit';

// ── Config ────────────────────────────────────────────────────────────────────
const BUCKET      = process.env.ART_BUCKET || 'mass-music-audio-files';
const REGION      = process.env.AWS_REGION || 'eu-north-1';
const PREFIX      = (process.env.ART_PREFIX || 'artwork/').replace(/\/?$/, '/');
const RESIZED_PREFIX = `${PREFIX}resized/`;
const SIZES       = (process.env.ART_SIZES || '300,800').split(',').map(s => parseInt(s, 10)).filter(Boolean);
const QUALITY     = parseInt(process.env.ART_QUALITY || '80', 10);
const CONCURRENCY = parseInt(process.env.ART_CONCURRENCY || '8', 10);
// Derivatives are NOT immutable: a re-uploaded master (same name) must be able to
// supersede its old derivative. Cache for an hour, then revalidate (serving stale
// while it does). Tunable via env.
const CACHE_CONTROL = process.env.ART_CACHE_CONTROL || 'public, max-age=3600, stale-while-revalidate=86400';

// ── Args ────────────────────────────────────────────────────────────────────
const argv  = process.argv.slice(2);
const DRY   = argv.includes('--dry-run');
const FORCE = argv.includes('--force');
// --restamp: rewrite the Cache-Control on EXISTING derivatives (server-side copy,
// no re-resize) — used once to clear the legacy `immutable` header so changes can
// ever propagate. Does not regenerate image content.
const RESTAMP = argv.includes('--restamp');
// --since=<hours>: only consider masters modified in the last N hours. Lets a
// scheduled run process just recently-changed artwork (fast) instead of HEADing
// the whole catalogue every time.
const sinceArg = argv.find(a => a.startsWith('--since'));
const SINCE_HOURS = sinceArg
  ? (parseFloat(sinceArg.includes('=') ? sinceArg.split('=')[1] : argv[argv.indexOf(sinceArg) + 1]) || 0)
  : 0;
const limitArg = argv.find(a => a.startsWith('--limit'));
const LIMIT = limitArg
  ? parseInt(limitArg.includes('=') ? limitArg.split('=')[1] : argv[argv.indexOf(limitArg) + 1], 10) || Infinity
  : Infinity;

const s3    = new S3Client({ region: REGION });
const limit = pLimit(CONCURRENCY);

// ── Helpers ───────────────────────────────────────────────────────────────────
const isMaster   = (key) => /\.(jpe?g|png)$/i.test(key) && !key.startsWith(RESIZED_PREFIX);
const baseName   = (key) => key.slice(PREFIX.length).replace(/\.(jpe?g|png)$/i, '');
const derivedKey = (key, size) => `${RESIZED_PREFIX}${baseName(key)}_${size}.webp`;

async function objectExists(key) {
  try { await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key })); return true; }
  catch { return false; }
}

async function* listMasters() {
  const sinceMs = SINCE_HOURS ? Date.now() - SINCE_HOURS * 3600 * 1000 : 0;
  let token;
  do {
    const out = await s3.send(new ListObjectsV2Command({
      Bucket: BUCKET, Prefix: PREFIX, ContinuationToken: token
    }));
    for (const obj of out.Contents || []) {
      if (!isMaster(obj.Key)) continue;
      if (sinceMs && obj.LastModified && obj.LastModified.getTime() < sinceMs) continue; // unchanged recently
      yield obj.Key;
    }
    token = out.IsTruncated ? out.NextContinuationToken : undefined;
  } while (token);
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function processKey(key) {
  if (!FORCE) {
    // Regenerate when a derivative is missing OR OLDER than the master — so a
    // re-uploaded master (same filename) gets fresh derivatives instead of the
    // old ones lingering forever. (--force regenerates regardless.)
    let masterMtime = 0;
    try {
      const mh = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
      masterMtime = mh.LastModified ? mh.LastModified.getTime() : 0;
    } catch { /* master vanished — let the GET below surface it */ }
    const fresh = await Promise.all(SIZES.map(async (s) => {
      try {
        const dh = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: derivedKey(key, s) }));
        return (dh.LastModified ? dh.LastModified.getTime() : 0) >= masterMtime;
      } catch { return false; } // missing derivative
    }));
    if (fresh.every(Boolean)) return 'skipped';
  }
  if (DRY) return 'dry';

  const obj   = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const input = await streamToBuffer(obj.Body);

  for (const size of SIZES) {
    const out = await sharp(input)
      .resize(size, size, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: QUALITY })
      .toBuffer();
    await s3.send(new PutObjectCommand({
      Bucket:       BUCKET,
      Key:          derivedKey(key, size),
      Body:         out,
      ContentType:  'image/webp',
      CacheControl: CACHE_CONTROL
    }));
  }
  return 'done';
}

// Rewrite Cache-Control on every existing derivative via server-side CopyObject
// (no download/resize). One-time use to clear the legacy `immutable` header.
async function restampDerivatives() {
  let token, seen = 0, done = 0, failed = 0;
  do {
    const out = await s3.send(new ListObjectsV2Command({
      Bucket: BUCKET, Prefix: RESIZED_PREFIX, ContinuationToken: token
    }));
    const keys = (out.Contents || []).map(o => o.Key).filter(k => /\.webp$/i.test(k));
    await Promise.all(keys.map(k => limit(async () => {
      seen += 1;
      if (DRY) { if (seen <= 10) console.log(`  would restamp: ${k}`); return; }
      try {
        await s3.send(new CopyObjectCommand({
          Bucket: BUCKET, Key: k, CopySource: `${BUCKET}/${k}`,
          MetadataDirective: 'REPLACE', ContentType: 'image/webp', CacheControl: CACHE_CONTROL
        }));
        done += 1;
        if (done % 250 === 0) console.log(`  …restamped ${done} (${seen} seen)`);
      } catch (err) { failed += 1; console.warn(`  ! ${k}: ${err.message}`); }
    })));
    token = out.IsTruncated ? out.NextContinuationToken : undefined;
  } while (token);
  console.log(`[restamp] ${done}/${seen} derivatives → Cache-Control: ${CACHE_CONTROL}${failed ? ` (${failed} failed)` : ''}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`[resize] bucket=${BUCKET} region=${REGION} prefix=${PREFIX}`);
  console.log(`[resize] sizes=${SIZES.join('/')} quality=${QUALITY} concurrency=${CONCURRENCY} dryRun=${DRY} force=${FORCE} restamp=${RESTAMP} since=${SINCE_HOURS || 'all'}h limit=${LIMIT}`);
  console.log(`[resize] cacheControl="${CACHE_CONTROL}"`);

  if (RESTAMP) { await restampDerivatives(); return; }

  const started = Date.now();
  let queued = 0, done = 0, skipped = 0, dry = 0, failed = 0;
  const tasks = [];

  for await (const key of listMasters()) {
    if (queued >= LIMIT) break;
    queued += 1;
    tasks.push(limit(async () => {
      try {
        const result = await processKey(key);
        if (result === 'done') done += 1;
        else if (result === 'skipped') skipped += 1;
        else if (result === 'dry') { dry += 1; console.log(`  would process: ${key}`); }
        if ((done + skipped) > 0 && (done + skipped) % 250 === 0) {
          console.log(`  …${done} processed, ${skipped} skipped (${queued} seen)`);
        }
      } catch (err) {
        failed += 1;
        console.warn(`  ! ${key}: ${err.message}`);
      }
    }));
  }

  await Promise.all(tasks);
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`[resize] complete in ${secs}s — ${queued} masters seen, ${done} processed, ${skipped} skipped, ${dry} dry, ${failed} failed`);
  if (failed) process.exitCode = 1;
})();
