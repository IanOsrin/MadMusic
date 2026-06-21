#!/usr/bin/env node
import {
  S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand
} from '@aws-sdk/client-s3';
import sharp from 'sharp';
import pLimit from 'p-limit';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BUCKET = process.env.ART_BUCKET || 'mass-music-audio-files';
const REGION = process.env.AWS_REGION || 'eu-north-1';
const PREFIX = (process.env.ART_PREFIX || 'artwork/').replace(/\/?$/, '/');
const RESIZED_PREFIX = `${PREFIX}resized/`;
const SIZES = (process.env.ART_SIZES || '300,800').split(',').map(s => parseInt(s, 10)).filter(Boolean);
const QUALITY = parseInt(process.env.ART_QUALITY || '80', 10);
const CONCURRENCY = parseInt(process.env.ART_CONCURRENCY || '4', 10);
const DRY = process.argv.includes('--dry-run');

const s3 = new S3Client({ region: REGION });
const limit = pLimit(CONCURRENCY);

const isMaster   = (key) => /\.(jpe?g|png)$/i.test(key) && !key.startsWith(RESIZED_PREFIX);
const baseName   = (key) => key.slice(PREFIX.length).replace(/\.(jpe?g|png)$/i, '');
const derivedKey = (key, size) => `${RESIZED_PREFIX}${baseName(key)}_${size}.webp`;

async function listAll() {
  const keys = new Set();
  let token;
  do {
    const out = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: PREFIX, ContinuationToken: token }));
    for (const o of out.Contents || []) keys.add(o.Key);
    token = out.IsTruncated ? out.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function toWebp(input, size, viaSips) {
  if (!viaSips) {
    return sharp(input).resize(size, size, { fit: 'inside', withoutEnlargement: true }).webp({ quality: QUALITY }).toBuffer();
  }
  const dir = mkdtempSync(join(tmpdir(), 'heic-'));
  try {
    const src = join(dir, 'in.heic');
    const png = join(dir, 'out.png');
    writeFileSync(src, input);
    execFileSync('sips', ['-s', 'format', 'png', src, '--out', png], { stdio: 'ignore' });
    const pngBuf = readFileSync(png);
    return sharp(pngBuf).resize(size, size, { fit: 'inside', withoutEnlargement: true }).webp({ quality: QUALITY }).toBuffer();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function repair(key) {
  const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const input = await streamToBuffer(obj.Body);

  let viaSips = false;
  try {
    await sharp(input).metadata();
  } catch {
    viaSips = true;
  }

  for (const size of SIZES) {
    const out = await toWebp(input, size, viaSips);
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET, Key: derivedKey(key, size), Body: out,
      ContentType: 'image/webp', CacheControl: process.env.ART_CACHE_CONTROL || 'public, max-age=3600, stale-while-revalidate=86400'
    }));
  }
  return viaSips ? 'repaired-heic' : 'repaired';
}

(async () => {
  try {
    execFileSync('sips', ['--help'], { stdio: 'ignore' });
  } catch {
    console.error('[repair] `sips` not found — this script needs macOS (sips decodes HEIC).');
    process.exit(1);
  }

  console.error(`[repair] bucket=${BUCKET} region=${REGION} prefix=${PREFIX} sizes=${SIZES.join('/')} dryRun=${DRY}`);
  const keys = await listAll();
  const masters = [...keys].filter(isMaster);
  const todo = masters.filter(m => SIZES.some(size => !keys.has(derivedKey(m, size))));
  console.error(`[repair] ${todo.length} masters still missing a derivative`);

  if (DRY) {
    for (const k of todo) console.error(`  would repair: ${k}`);
    return;
  }

  let ok = 0, heic = 0, failed = 0;
  await Promise.all(todo.map(k => limit(async () => {
    try {
      const r = await repair(k);
      if (r === 'repaired-heic') heic += 1;
      ok += 1;
      console.error(`  ✓ ${k}${r === 'repaired-heic' ? '  (HEIC via sips)' : ''}`);
    } catch (err) {
      failed += 1;
      console.error(`  ! ${k}: ${err.message}`);
    }
  })));

  console.error(`[repair] done — ${ok} fixed (${heic} were HEIC), ${failed} failed`);
  if (failed) process.exitCode = 1;
})();
