#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PLAYLISTS_PATH = path.join(__dirname, '..', 'data', 'playlists.json');

async function removeEmailsFromPlaylists() {
  try {
    console.log('[MIGRATION] Reading playlists.json...');
    const raw = await fs.readFile(PLAYLISTS_PATH, 'utf8');
    const playlists = JSON.parse(raw);

    if (!Array.isArray(playlists)) {
      console.error('[MIGRATION] playlists.json is not an array');
      process.exit(1);
    }

    let emailsRemoved = 0;
    for (const playlist of playlists) {
      if (playlist && typeof playlist === 'object' && playlist.userEmail) {
        delete playlist.userEmail;
        emailsRemoved++;
      }
    }

    if (emailsRemoved === 0) {
      console.log('[MIGRATION] No email addresses found. File is already clean.');
      return;
    }

    // Create backup
    const backupPath = `${PLAYLISTS_PATH}.backup-${Date.now()}`;
    await fs.copyFile(PLAYLISTS_PATH, backupPath);
    console.log(`[MIGRATION] Backup created at: ${backupPath}`);

    // Write cleaned data
    const payload = JSON.stringify(playlists, null, 2);
    await fs.writeFile(PLAYLISTS_PATH, payload, 'utf8');

    console.log(`[MIGRATION] ✅ Successfully removed ${emailsRemoved} email address(es) from playlists.json`);
    console.log('[MIGRATION] Your playlists are now more private!');
  } catch (err) {
    console.error('[MIGRATION] Failed:', err);
    process.exit(1);
  }
}

removeEmailsFromPlaylists();
