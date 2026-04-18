#!/usr/bin/env node

/**
 * Access Token Generator for MASS
 *
 * Usage:
 *   node scripts/generate-access-token.js [options]
 *
 * Options:
 *   --days <number>    Number of days until token expires (default: 7)
 *   --unlimited        Create an unlimited access token (never expires)
 *   --notes <text>     Add notes/description for the token
 *
 * Examples:
 *   node scripts/generate-access-token.js
 *   node scripts/generate-access-token.js --days 30
 *   node scripts/generate-access-token.js --unlimited --notes "Admin token"
 *   node scripts/generate-access-token.js --days 14 --notes "Trial for Client XYZ"
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { acquireLock, releaseLock } from '../lib/file-lock.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, '..', 'data');
const ACCESS_TOKENS_PATH = path.join(DATA_DIR, 'access-tokens.json');

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    days: 7,
    unlimited: false,
    notes: ''
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    if (arg === '--days' && args[i + 1]) {
      const days = Number.parseInt(args[i + 1], 10);
      if (!Number.isNaN(days) && days > 0) {
        options.days = days;
      }
      i += 2;
    } else if (arg === '--unlimited') {
      options.unlimited = true;
      i += 1;
    } else if (arg === '--notes' && args[i + 1]) {
      options.notes = args[i + 1];
      i += 2;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
Access Token Generator for MASS

Usage:
  node scripts/generate-access-token.js [options]

Options:
  --days <number>    Number of days until token expires (default: 7)
  --unlimited        Create an unlimited access token (never expires)
  --notes <text>     Add notes/description for the token
  --help, -h         Show this help message

Examples:
  node scripts/generate-access-token.js
  node scripts/generate-access-token.js --days 30
  node scripts/generate-access-token.js --unlimited --notes "Admin token"
  node scripts/generate-access-token.js --days 14 --notes "Trial for Client XYZ"
      `);
      process.exit(0);
    } else {
      i += 1;
    }
  }

  return options;
}

// Generate a secure random token code.
// NOTE: This is intentionally duplicated from store.js (createAccessToken → generateTokenCode).
// The script cannot import store.js directly because store.js pulls in fm-client.js, which
// spins up an HTTP connection pool and logs to console on import — unsuitable for a CLI tool.
// If you change the token format here, update store.js to match (and vice versa).
function generateTokenCode() {
  // Generate 6 random bytes and encode as base32-like string (readable)
  const bytes = randomBytes(6);
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Avoid confusing chars like 0/O, 1/I
  let code = 'MASS-';

  for (let i = 0; i < bytes.length; i++) {
    if (i === 3) code += '-'; // Add separator
    code += chars[bytes[i] % chars.length];
  }

  return code;
}

async function loadTokens() {
  try {
    const raw = await fs.readFile(ACCESS_TOKENS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : { tokens: [] };
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { tokens: [] };
    }
    throw err;
  }
}

async function saveTokens(tokenData) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const payload  = JSON.stringify(tokenData, null, 2);
  const tempPath = `${ACCESS_TOKENS_PATH}.tmp`;
  await fs.writeFile(tempPath, payload, 'utf8');
  await fs.rename(tempPath, ACCESS_TOKENS_PATH);
}

async function main() {
  const options = parseArgs();

  console.log('\n🎫 MASS Access Token Generator\n');
  console.log('━'.repeat(50));

  // Generate token code
  const code = generateTokenCode();

  // Calculate expiration date
  const issuedDate = new Date();
  let expirationDate = null;

  if (!options.unlimited) {
    expirationDate = new Date(issuedDate);
    expirationDate.setDate(expirationDate.getDate() + options.days);
  }

  // Create token object
  const token = {
    code,
    type: options.unlimited ? 'unlimited' : 'trial',
    issuedDate: issuedDate.toISOString(),
    expirationDate: expirationDate ? expirationDate.toISOString() : null,
    notes: options.notes || (options.unlimited ? 'Unlimited access' : `${options.days}-day trial`)
  };

  // Load existing tokens, add the new one, and save — under an advisory lock so
  // a concurrently running server (which also writes via lib/file-lock.js) cannot
  // interleave and lose a token.
  let totalTokens = 0;
  const lockPath = await acquireLock(ACCESS_TOKENS_PATH);
  try {
    const tokenData = await loadTokens();
    tokenData.tokens.push(token);
    await saveTokens(tokenData);
    totalTokens = tokenData.tokens.length;
  } finally {
    await releaseLock(lockPath);
  }

  // Display results
  console.log('\n✅ Token Generated Successfully!\n');
  console.log('Token Code:');
  console.log(`  ${code}\n`);

  if (options.unlimited) {
    console.log('Type:        Unlimited Access (Never Expires)');
  } else {
    console.log(`Type:        Trial (${options.days} days)`);
    console.log(`Expires:     ${expirationDate.toLocaleDateString()} ${expirationDate.toLocaleTimeString()}`);
  }

  console.log(`Issued:      ${issuedDate.toLocaleDateString()} ${issuedDate.toLocaleTimeString()}`);

  if (options.notes) {
    console.log(`Notes:       ${options.notes}`);
  }

  console.log('\n━'.repeat(50));
  console.log('\n📋 Copy this token code into FileMaker:');
  console.log(`\n   ${code}\n`);
  console.log('━'.repeat(50));
  console.log(`\n📁 Token saved to: ${ACCESS_TOKENS_PATH}`);
  console.log(`   Total tokens: ${totalTokens}\n`);
}

try {
  await main();
} catch (err) {
  console.error('\n❌ Error:', err.message);
  process.exit(1);
}
