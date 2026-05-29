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
  PutObjectCommand, HeadObjectCommand
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

// ── Args ────────────────────────────────────────────────────────────────────
const argv  = process.argv.slice(2);
const DRY   = argv.includes('--dry-run');
const FORCE = argv.includes('--force');
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
  let token;
  do {
    const out = await s3.send(new ListObjectsV2Command({
      Bucket: BUCKET, Prefix: PREFIX, ContinuationToken: token
    }));
    for (const obj of out.Contents || []) {
      if (isMaster(obj.Key)) yield obj.Key;
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
    const present = await Promise.all(SIZES.map(s => objectExists(derivedKey(key, s))));
    if (present.every(Boolean)) return 'skipped';
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
      CacheControl: 'public, max-age=31536000, immutable'
    }));
  }
  return 'done';
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`[resize] bucket=${BUCKET} region=${REGION} prefix=${PREFIX}`);
  console.log(`[resize] sizes=${SIZES.join('/')} quality=${QUALITY} concurrency=${CONCURRENCY} dryRun=${DRY} force=${FORCE} limit=${LIMIT}`);

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
