#!/usr/bin/env node
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';

const BUCKET = process.env.ART_BUCKET || 'mass-music-audio-files';
const REGION = process.env.AWS_REGION || 'eu-north-1';
const PREFIX = (process.env.ART_PREFIX || 'artwork/').replace(/\/?$/, '/');
const RESIZED_PREFIX = `${PREFIX}resized/`;
const SIZES = (process.env.ART_SIZES || '300,800').split(',').map(s => parseInt(s, 10)).filter(Boolean);
const CSV = process.argv.includes('--csv');

const s3 = new S3Client({ region: REGION });

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

(async () => {
  if (!CSV) {
    console.error(`[audit] bucket=${BUCKET} region=${REGION} prefix=${PREFIX} sizes=master+${SIZES.join('+')}`);
  }
  const keys = await listAll();
  const masters = [...keys].filter(isMaster).sort();

  const incomplete = [];
  for (const m of masters) {
    const missing = SIZES.filter(size => !keys.has(derivedKey(m, size)));
    if (missing.length) incomplete.push({ master: m, missing });
  }

  if (CSV) {
    console.log('master,missing_sizes');
    for (const r of incomplete) console.log(`${r.master},${r.missing.join('|')}`);
    return;
  }

  console.error(`[audit] ${masters.length} album masters found`);
  console.error(`[audit] ${masters.length - incomplete.length} have all ${SIZES.length + 1} sizes`);
  console.error(`[audit] ${incomplete.length} are MISSING at least one derivative\n`);
  if (incomplete.length) {
    for (const r of incomplete.slice(0, 100)) {
      console.error(`  MISSING ${r.missing.map(s => s + 'px').join(', ')}  ←  ${r.master}`);
    }
    if (incomplete.length > 100) console.error(`  …and ${incomplete.length - 100} more (use --csv for the full list)`);
    process.exitCode = 1;
  } else {
    console.error('  ✓ every album master has all three sizes.');
  }
})();
