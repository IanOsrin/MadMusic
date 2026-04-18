import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { requireTokenEmail } from '../lib/auth.js';
import { validators } from '../lib/validators.js';
import { normalizeShareId, generateShareId, escapeHtml } from '../lib/format.js';
import { buildShareUrl } from '../lib/http.js';
import {
  playlistOwnerMatches, sanitizePlaylistForShare,
  buildPlaylistDuplicateIndex, resolveDuplicate, summarizeTrackPayload, buildTrackEntry
} from '../lib/playlist.js';
import { normalizeTrackPayload } from '../lib/track.js';
import { AUDIO_FIELD_CANDIDATES, ARTWORK_FIELD_CANDIDATES, FM_LAYOUT } from '../lib/fm-fields.js';
import { emailTransporter } from '../lib/email.js';
import {
  loadUserPlaylists, loadPlaylistById, loadPlaylistByShareId,
  isShareIdTaken, createPlaylist, updatePlaylist, deletePlaylist
} from '../lib/playlist-store.js';
import { fmGetRecordById, fmUpdateRecord } from '../fm-client.js';

const router = Router();

// All playlist routes return user-specific data — never cache on client or CDN.
router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

// ── GET / — list user's playlists ─────────────────────────────────────────────
router.get('/', async (req, res) => {
  const user = requireTokenEmail(req, res);
  if (!user) return;

  try {
    const playlists = await loadUserPlaylists(user.email);
    res.json({ ok: true, playlists });
  } catch (err) {
    console.error('[MASS] Fetch playlists failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to load playlists' });
  }
});

// ── POST / — create playlist ──────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const user = requireTokenEmail(req, res);
  if (!user) return;

  try {
    const email      = user.email;
    const nameRaw    = req.body?.name;
    const artworkRaw = req.body?.artwork;

    if (!nameRaw) {
      res.status(400).json({ ok: false, error: 'Playlist name required' });
      return;
    }
    const nameValidation = validators.playlistName(nameRaw);
    if (!nameValidation.valid) {
      res.status(400).json({ ok: false, error: nameValidation.error });
      return;
    }
    const name = nameValidation.value;

    // Validate artwork URL if provided — must be a recognised S3 origin
    const S3_ARTWORK_BASE = 'https://mass-music-audio-files.s3.eu-north-1.amazonaws.com/artwork/';
    const artwork = typeof artworkRaw === 'string' && artworkRaw.startsWith(S3_ARTWORK_BASE)
      ? artworkRaw.trim()
      : '';

    // Collision check against existing user playlists
    const existing = await loadUserPlaylists(email);
    const collision = existing.find(
      (p) => p && playlistOwnerMatches(p.userId, email) && typeof p.name === 'string' && p.name.toLowerCase() === name.toLowerCase()
    );
    if (collision) {
      res.status(409).json({ ok: false, error: 'You already have a playlist with that name', playlist: collision });
      return;
    }

    const now      = new Date().toISOString();
    const playlist = await createPlaylist({
      id:        randomUUID(),
      userId:    email,
      name,
      artwork,
      tracks:    [],
      createdAt: now,
      updatedAt: now
    });

    res.status(201).json({ ok: true, playlist });
  } catch (err) {
    console.error('[MASS] Create playlist failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to create playlist' });
  }
});

// ── POST /:playlistId/tracks — add a single track ─────────────────────────────
router.post('/:playlistId/tracks', async (req, res) => {
  const user = requireTokenEmail(req, res);
  if (!user) return;

  try {
    const email      = user.email;
    const playlistId = req.params?.playlistId;
    if (!playlistId) {
      res.status(400).json({ ok: false, error: 'Playlist ID required' });
      return;
    }

    const trackPayload = normalizeTrackPayload(req.body?.track || {});
    if (!trackPayload.name) {
      res.status(400).json({ ok: false, error: 'Track name required' });
      return;
    }

    const playlist = await loadPlaylistById(playlistId, email);
    if (!playlist) {
      res.status(404).json({ ok: false, error: 'Playlist not found' });
      return;
    }

    playlist.tracks = Array.isArray(playlist.tracks) ? playlist.tracks : [];
    const duplicateIndex = buildPlaylistDuplicateIndex(playlist);
    const { key: dupKey, entry: duplicate } = resolveDuplicate(duplicateIndex, trackPayload);
    if (duplicate) {
      console.log(`[MASS] Duplicate track: key=${dupKey}`);
      res.status(200).json({ ok: true, playlist, track: duplicate, duplicate: true });
      return;
    }

    const addedAt = new Date().toISOString();
    const entry   = buildTrackEntry(trackPayload, addedAt);
    playlist.tracks.push(entry);
    playlist.updatedAt = addedAt;

    await updatePlaylist(playlist._fmRecordId, { tracks: playlist.tracks, updatedAt: playlist.updatedAt });

    res.status(201).json({ ok: true, playlist, track: entry });
  } catch (err) {
    console.error('[MASS] Add track to playlist failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to add track' });
  }
});

// Processes a list of normalized track payloads against a playlist, returning
// categorised results. Mutates playlist.tracks and duplicateIndex in place.
function processBulkTracks(normalizedTracks, playlist, duplicateIndex, timestampBase) {
  const addedEntries = [];
  const duplicates   = [];
  const skipped      = [];
  for (const trackPayload of normalizedTracks) {
    if (!trackPayload.name) {
      skipped.push({ ...summarizeTrackPayload(trackPayload), reason: 'invalid_name' });
      continue;
    }
    const { key, entry: duplicate } = resolveDuplicate(duplicateIndex, trackPayload);
    if (duplicate) {
      duplicates.push({ ...summarizeTrackPayload(trackPayload), reason: 'already_exists' });
      continue;
    }
    const addedAt = new Date(timestampBase + addedEntries.length).toISOString();
    const entry = buildTrackEntry(trackPayload, addedAt);
    playlist.tracks.push(entry);
    addedEntries.push(entry);
    if (key) duplicateIndex.set(key, entry);
  }
  return { addedEntries, duplicates, skipped };
}

// ── POST /:playlistId/tracks/bulk — add many tracks at once ──────────────────
router.post('/:playlistId/tracks/bulk', async (req, res) => {
  const user = requireTokenEmail(req, res);
  if (!user) return;

  try {
    const email      = user.email;
    const playlistId = req.params?.playlistId;
    if (!playlistId) {
      res.status(400).json({ ok: false, error: 'Playlist ID required' });
      return;
    }

    const rawTracks = Array.isArray(req.body?.tracks) ? req.body.tracks : [];
    if (!rawTracks.length) {
      res.status(400).json({ ok: false, error: 'At least one track required' });
      return;
    }

    const playlist = await loadPlaylistById(playlistId, email);
    if (!playlist) {
      res.status(404).json({ ok: false, error: 'Playlist not found' });
      return;
    }

    playlist.tracks = Array.isArray(playlist.tracks) ? playlist.tracks : [];
    const normalizedTracks = rawTracks.map((track) => normalizeTrackPayload(track || {}));
    const duplicateIndex   = buildPlaylistDuplicateIndex(playlist);
    const { addedEntries, duplicates, skipped } = processBulkTracks(
      normalizedTracks, playlist, duplicateIndex, Date.now()
    );

    if (addedEntries.length) {
      playlist.updatedAt = addedEntries.at(-1).addedAt;
      await updatePlaylist(playlist._fmRecordId, { tracks: playlist.tracks, updatedAt: playlist.updatedAt });
    }

    const status = addedEntries.length ? 201 : 200;
    res.status(status).json({
      ok: true,
      playlist,
      addedCount:     addedEntries.length,
      duplicateCount: duplicates.length,
      skippedCount:   skipped.length,
      added:          addedEntries,
      duplicates,
      skipped
    });
  } catch (err) {
    console.error('[MASS] Bulk add tracks to playlist failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to add tracks' });
  }
});

// ── POST /:playlistId/share — generate a share link ──────────────────────────

async function resolveShareId(playlist, regenerate) {
  const existing = normalizeShareId(playlist.shareId);
  const needsNew = regenerate || !existing;

  if (!needsNew) {
    const changed = !playlist.sharedAt;
    if (changed) playlist.sharedAt = new Date().toISOString();
    return { shareId: existing, changed };
  }

  // Generate a short code and verify uniqueness against FM
  let candidate;
  let attempts = 0;
  do {
    candidate = generateShareId();
    attempts += 1;
  } while (await isShareIdTaken(candidate) && attempts < 10);

  if (attempts >= 10) return { shareId: null, changed: false };

  playlist.shareId  = candidate;
  playlist.sharedAt = new Date().toISOString();
  return { shareId: candidate, changed: true };
}

router.post('/:playlistId/share', async (req, res) => {
  const user = requireTokenEmail(req, res);
  if (!user) return;

  let playlist = null;
  let shareId  = '';

  try {
    const email      = user.email;
    const playlistId = req.params?.playlistId;
    if (!playlistId) {
      res.status(400).json({ ok: false, error: 'Playlist ID required' });
      return;
    }

    playlist = await loadPlaylistById(playlistId, email);
    if (!playlist) {
      res.status(404).json({ ok: false, error: 'Playlist not found' });
      return;
    }

    const tracks = Array.isArray(playlist.tracks) ? playlist.tracks : [];
    if (!tracks.length) {
      res.status(400).json({ ok: false, error: 'Add at least one track before sharing a playlist' });
      return;
    }

    const regenerate = req.body?.regenerate === true;
    const resolved   = await resolveShareId(playlist, regenerate);
    if (!resolved.shareId) {
      res.status(500).json({ ok: false, error: 'Unable to generate a unique share link' });
      return;
    }
    shareId = resolved.shareId;

    if (resolved.changed) {
      await updatePlaylist(playlist._fmRecordId, { shareId: playlist.shareId, sharedAt: playlist.sharedAt });
    }

    const payload  = sanitizePlaylistForShare(playlist);
    const shareUrl = buildShareUrl(req, shareId);

    res.json({ ok: true, shareId, shareUrl, playlist: payload });
  } catch (err) {
    console.error('[MASS] Generate playlist share link failed:', err);
    const detail     = err?.message || err?.code || String(err);
    const fallbackId = normalizeShareId(shareId || playlist?.shareId);
    if (fallbackId && playlist) {
      try {
        const payload  = sanitizePlaylistForShare(playlist);
        const shareUrl = buildShareUrl(req, fallbackId);
        res.json({ ok: true, shareId: fallbackId, shareUrl, playlist: payload, reused: true, error: 'Existing share link reused' });
        return;
      } catch (error_) {
        console.error('[MASS] Fallback share link serialization failed:', error_);
      }
    }
    res.status(500).json({ ok: false, error: 'Unable to generate share link', detail });
  }
});

// ── POST /:playlistId/share/email — send share email ─────────────────────────
router.post('/:playlistId/share/email', async (req, res) => {
  const user = requireTokenEmail(req, res);
  if (!user) return;

  const playlistId = req.params?.playlistId;
  const { recipientEmail, recipientName } = req.body || {};

  if (!playlistId) return res.status(400).json({ ok: false, error: 'Playlist ID required' });
  const atIdx  = recipientEmail ? recipientEmail.indexOf('@') : -1;
  const dotIdx = recipientEmail ? recipientEmail.lastIndexOf('.') : -1;
  const validRecipient = atIdx > 0 && atIdx === recipientEmail.lastIndexOf('@')
    && dotIdx > atIdx + 1 && dotIdx < recipientEmail.length - 1;
  if (!recipientEmail || recipientEmail.length > 320 || !validRecipient) {
    return res.status(400).json({ ok: false, error: 'Valid recipient email required' });
  }

  try {
    const playlist = await loadPlaylistById(playlistId, user.email);
    if (!playlist) return res.status(404).json({ ok: false, error: 'Playlist not found' });

    // Ensure it has a shareId
    if (!playlist.shareId) {
      playlist.shareId  = generateShareId();
      playlist.sharedAt = new Date().toISOString();
      await updatePlaylist(playlist._fmRecordId, { shareId: playlist.shareId, sharedAt: playlist.sharedAt });
    }

    const shareUrl    = buildShareUrl(req, playlist.shareId);
    const playlistName = escapeHtml(playlist.name || 'a playlist');
    const senderLabel  = escapeHtml(recipientName ? `${recipientName}` : (user.email || 'Someone'));
    const trackCount   = Array.isArray(playlist.tracks) ? playlist.tracks.length : 0;
    const trackWord    = trackCount === 1 ? 'track' : 'tracks';

    const transporter = emailTransporter;
    if (!transporter) {
      console.warn('[MASS] Email transporter not configured — cannot send share email');
      return res.status(503).json({ ok: false, error: 'Email service not configured' });
    }

    const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0f0f0f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f0f0f;padding:40px 20px;">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0" style="background:#1a1a1a;border-radius:16px;overflow:hidden;border:1px solid #2a2a2a;">
        <!-- Header -->
        <tr><td style="background:linear-gradient(135deg,#1a1a1a 0%,#0f0f0f 100%);padding:32px 40px 24px;text-align:center;border-bottom:1px solid #2a2a2a;">
          <div style="font-size:28px;font-weight:900;letter-spacing:-1px;color:#62f5a9;">MAD<span style="color:#ffffff;">music</span></div>
          <div style="font-size:12px;color:#666;margin-top:4px;letter-spacing:2px;text-transform:uppercase;">Playlist Shared With You</div>
        </td></tr>
        <!-- Body -->
        <tr><td style="padding:32px 40px;">
          <p style="color:#aaa;font-size:15px;margin:0 0 8px;">Hi there,</p>
          <p style="color:#fff;font-size:16px;margin:0 0 24px;line-height:1.6;">
            <strong style="color:#62f5a9;">${senderLabel}</strong> has shared a playlist with you on MAD Music.
          </p>
          <!-- Playlist card -->
          <div style="background:#111;border:1px solid #2a2a2a;border-left:4px solid #62f5a9;border-radius:12px;padding:20px 24px;margin:0 0 28px;">
            <div style="font-size:22px;font-weight:700;color:#fff;margin:0 0 6px;">${playlistName}</div>
            <div style="font-size:13px;color:#666;">${trackCount} ${trackWord}</div>
          </div>
          <!-- CTA button -->
          <div style="text-align:center;margin:0 0 28px;">
            <a href="${escapeHtml(shareUrl)}" style="display:inline-block;background:#62f5a9;color:#0a0a0a;font-weight:700;font-size:15px;text-decoration:none;padding:14px 36px;border-radius:50px;letter-spacing:0.3px;">
              Listen Now →
            </a>
          </div>
          <p style="color:#555;font-size:13px;margin:0;line-height:1.6;">
            If the button doesn't work, copy this link into your browser:<br>
            <a href="${escapeHtml(shareUrl)}" style="color:#62f5a9;word-break:break-all;">${escapeHtml(shareUrl)}</a>
          </p>
        </td></tr>
        <!-- Footer -->
        <tr><td style="padding:20px 40px;border-top:1px solid #2a2a2a;text-align:center;">
          <p style="color:#444;font-size:12px;margin:0;">You need an active MAD Music access token to play this playlist.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

    await transporter.sendMail({
      from:    process.env.EMAIL_FROM || '"MAD Music" <noreply@madmusic.com>',
      to:      recipientEmail,
      subject: `${senderLabel} shared "${playlistName}" with you on MAD Music`,
      html,
      text: `${senderLabel} shared the playlist "${playlistName}" (${trackCount} ${trackWord}) with you on MAD Music.\n\nListen here: ${shareUrl}\n\nYou need an active MAD Music access token to play this playlist.`,
    });

    console.log(`[MASS] Playlist share email sent to ${recipientEmail} for playlist ${playlistId}`);
    res.json({ ok: true, shareUrl });
  } catch (err) {
    console.error('[MASS] Share email failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to send share email', detail: err?.message });
  }
});

// ── POST /:playlistId/publish-to-filemaker ────────────────────────────────────
router.post('/:playlistId/publish-to-filemaker', async (req, res) => {
  const user = requireTokenEmail(req, res);
  if (!user) return;

  try {
    const email      = user.email;
    const playlistId = req.params?.playlistId;
    if (!playlistId) {
      return res.status(400).json({ ok: false, error: 'Playlist ID required' });
    }

    const playlist = await loadPlaylistById(playlistId, email);
    if (!playlist) {
      return res.status(404).json({ ok: false, error: 'Playlist not found' });
    }
    if (!playlist.tracks || playlist.tracks.length === 0) {
      return res.status(400).json({ ok: false, error: 'Playlist has no tracks' });
    }

    const playlistName = playlist.name || 'Unnamed Playlist';
    console.log(`[MASS] Publishing playlist "${playlistName}" (${playlist.tracks.length} tracks) to FileMaker`);

    const results = [];
    for (const track of playlist.tracks) {
      const recId = track['song files:recid'] || track.recordId || track.trackRecordId;
      if (!recId) {
        results.push({ track: track.name || 'Unknown', success: false, error: 'No record ID found' });
        continue;
      }
      try {
        await fmUpdateRecord(FM_LAYOUT, recId, { 'PublicPlaylist': playlistName });
        results.push({ track: track.name || 'Unknown', recordId: recId, success: true });
        console.log(`[MASS] ✓ Updated track "${track.name}" (${recId}) with PublicPlaylist="${playlistName}"`);
      } catch (err) {
        const errMsg = err?.message || String(err);
        results.push({ track: track.name || 'Unknown', recordId: recId, success: false, error: errMsg });
        console.error(`[MASS] ✗ Failed to update track "${track.name}" (${recId}):`, errMsg);
      }
    }

    const successCount = results.filter(r => r.success).length;
    const failCount    = results.filter(r => !r.success).length;
    console.log(`[MASS] Publish complete: ${successCount} succeeded, ${failCount} failed`);

    res.json({
      ok: true,
      message: 'Playlist published to FileMaker',
      playlistName,
      totalTracks: playlist.tracks.length,
      successCount,
      failCount,
      results
    });
  } catch (err) {
    console.error('[MASS] Publish playlist to FileMaker failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to publish playlist', detail: err?.message || String(err) });
  }
});

// ── GET /:playlistId/export — export as base64 track IDs ─────────────────────
router.get('/:playlistId/export', async (req, res) => {
  const user = requireTokenEmail(req, res);
  if (!user) return;

  try {
    const playlistId = req.params?.playlistId;
    if (!playlistId) {
      return res.status(400).json({ ok: false, error: 'Playlist ID required' });
    }

    const playlist = await loadPlaylistById(playlistId, user.email);
    if (!playlist || !Array.isArray(playlist.tracks)) {
      return res.status(404).json({ ok: false, error: 'Playlist not found' });
    }

    const trackIds = playlist.tracks
      .map((t) => t.trackRecordId || t.recordId)
      .filter(Boolean);

    if (!trackIds.length) return res.json({ ok: true, code: '' });

    const code = Buffer.from(trackIds.join(',')).toString('base64').replaceAll('=', '');
    res.json({ ok: true, code });
  } catch (err) {
    console.error('[MASS] Export playlist failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to export playlist', detail: err?.message });
  }
});

// Decodes a base64 import code → array of track IDs, or throws on invalid input.
function decodeImportCode(importCode) {
  const padded  = importCode + '='.repeat((4 - (importCode.length % 4)) % 4);
  const decoded = Buffer.from(padded, 'base64').toString('utf-8');
  return decoded.split(',').filter(Boolean);
}

// Builds a track object from a FileMaker record and a pre-computed timestamp.
function buildTrackObjectFromRecord(record, trackId, now) {
  const fields = record.fieldData || {};
  const trackObj = {
    trackRecordId: trackId,
    name:        fields['Track Name']   || fields['Tape Files::Track Name'] || 'Unknown Track',
    albumTitle:  fields['Album']        || fields['Tape Files::Album']       || '',
    albumArtist: fields['Album Artist'] || fields['Artist'] || fields['Tape Files::Album Artist'] || '',
    trackArtist: fields['Track Artist'] || fields['Album Artist'] || '',
    catalogue:   fields['Catalogue #']  || fields['Catalogue'] || '',
    addedAt: now
  };
  const audioField   = AUDIO_FIELD_CANDIDATES.find(f => fields[f]);
  const artworkField = ARTWORK_FIELD_CANDIDATES.find(f => fields[f]);
  if (audioField)   { trackObj.mp3 = fields[audioField]; trackObj.audioField = audioField; }
  if (artworkField) { trackObj.artwork = fields[artworkField]; trackObj.artworkField = artworkField; }
  return trackObj;
}

const IMPORT_MAX = 100;
const IMPORT_CONCURRENCY = 5;

/**
 * Fetches FM records for up to IMPORT_MAX track IDs using a limited-concurrency
 * pool. Returns a Map of trackId → record (single fetch — no second pass needed),
 * the list of IDs that failed/were not found, and any IDs silently dropped by
 * the cap (so callers can be transparent about the limit).
 */
async function resolveAndFetchTracks(importedTrackIds) {
  // Deduplicate before capping so the limit is applied to unique IDs only
  const unique     = [...new Set(importedTrackIds)];
  const toProcess  = unique.slice(0, IMPORT_MAX);
  const ignoredIds = unique.slice(IMPORT_MAX); // IDs beyond the cap

  const recordCache = new Map(); // trackId → FM record
  const failedIds   = [];

  for (let i = 0; i < toProcess.length; i += IMPORT_CONCURRENCY) {
    const batch = toProcess.slice(i, i + IMPORT_CONCURRENCY);
    await Promise.all(batch.map(async (trackId) => {
      try {
        const record = await fmGetRecordById(FM_LAYOUT, trackId);
        if (record) {
          console.log(`[MASS] Import: ✓ ${trackId}`);
          recordCache.set(trackId, record);
        } else {
          console.log(`[MASS] Import: ✗ not found: ${trackId}`);
          failedIds.push(trackId);
        }
      } catch (err) {
        console.error(`[MASS] Import: ✗ error fetching ${trackId}:`, err.message);
        failedIds.push(trackId);
      }
    }));
  }

  return { recordCache, failedIds, ignoredIds };
}

// ── POST /:playlistId/import — import from base64 code into existing playlist ─
router.post('/:playlistId/import', async (req, res) => {
  const user = requireTokenEmail(req, res);
  if (!user) return;

  try {
    const email      = user.email;
    const playlistId = req.params?.playlistId;
    const { code: importCode } = req.body || {};

    if (!playlistId) {
      return res.status(400).json({ ok: false, error: 'Playlist ID required' });
    }
    if (!importCode || typeof importCode !== 'string') {
      return res.status(400).json({ ok: false, error: 'Import code required' });
    }

    // Verify the target playlist exists and belongs to this user
    const playlist = await loadPlaylistById(playlistId, email);
    if (!playlist) return res.status(404).json({ ok: false, error: 'Playlist not found' });

    let importedTrackIds = [];
    try {
      importedTrackIds = decodeImportCode(importCode);
    } catch (err) {
      return res.status(400).json({ ok: false, error: 'Invalid import code', detail: err?.message });
    }

    if (!importedTrackIds.length) {
      return res.status(400).json({ ok: false, error: 'No tracks in import code' });
    }

    console.log(`[MASS] Import: Fetching ${importedTrackIds.length} track IDs into playlist ${playlistId}`);
    const { recordCache, failedIds, ignoredIds } = await resolveAndFetchTracks(importedTrackIds);

    if (recordCache.size === 0) {
      return res.status(400).json({
        ok:     false,
        error:  'None of the imported tracks were found',
        detail: `Tried ${Math.min(importedTrackIds.length, IMPORT_MAX)} track IDs, none found in FileMaker`
      });
    }

    // Build track objects from the already-fetched records (no second FM round-trip)
    const now        = new Date().toISOString();
    const newTracks  = [];
    for (const [trackId, record] of recordCache) {
      newTracks.push(buildTrackObjectFromRecord(record, trackId, now));
    }

    // Merge: append new tracks, skip duplicates by trackRecordId
    const existingIds = new Set((playlist.tracks || []).map(t => t.trackRecordId).filter(Boolean));
    const toAppend    = newTracks.filter(t => !existingIds.has(t.trackRecordId));
    const merged      = [...(playlist.tracks || []), ...toAppend];

    await updatePlaylist(playlist._fmRecordId, { tracks: merged, updatedAt: now });
    const updated = await loadPlaylistById(playlistId, email);

    res.json({
      ok:           true,
      playlist:     updated,
      imported:     toAppend.length,
      duplicates:   newTracks.length - toAppend.length,
      notFound:     failedIds.length,
      // Transparent about the cap: if ignored > 0 the caller exceeded IMPORT_MAX unique IDs
      ignored:      ignoredIds.length,
      maxProcessed: IMPORT_MAX
    });
  } catch (err) {
    console.error('[MASS] Import playlist failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to import playlist', detail: err?.message });
  }
});

// ── DELETE /:playlistId/tracks/:addedAt — remove a track ─────────────────────
router.delete('/:playlistId/tracks/:addedAt', async (req, res) => {
  const user = requireTokenEmail(req, res);
  if (!user) return;

  try {
    const email      = user.email;
    const playlistId = req.params?.playlistId;
    const addedAt    = req.params?.addedAt;

    if (!playlistId) {
      res.status(400).json({ ok: false, error: 'Playlist ID required' });
      return;
    }
    if (!addedAt) {
      res.status(400).json({ ok: false, error: 'Track addedAt timestamp required' });
      return;
    }

    const playlist = await loadPlaylistById(playlistId, email);
    if (!playlist) {
      res.status(404).json({ ok: false, error: 'Playlist not found' });
      return;
    }

    playlist.tracks = Array.isArray(playlist.tracks) ? playlist.tracks : [];
    const trackIndex = playlist.tracks.findIndex((t) => t?.addedAt === addedAt);
    if (trackIndex === -1) {
      res.status(404).json({ ok: false, error: 'Track not found in playlist' });
      return;
    }

    const [deletedTrack] = playlist.tracks.splice(trackIndex, 1);
    playlist.updatedAt   = new Date().toISOString();

    await updatePlaylist(playlist._fmRecordId, { tracks: playlist.tracks, updatedAt: playlist.updatedAt });

    res.json({ ok: true, playlist, track: deletedTrack });
  } catch (err) {
    console.error('[MASS] Delete track from playlist failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to delete track' });
  }
});

// ── DELETE /:playlistId — delete a playlist ───────────────────────────────────
router.delete('/:playlistId', async (req, res) => {
  const user = requireTokenEmail(req, res);
  if (!user) return;

  try {
    const playlistId = req.params?.playlistId;
    if (!playlistId) {
      res.status(400).json({ ok: false, error: 'Playlist ID required' });
      return;
    }

    const playlist = await loadPlaylistById(playlistId, user.email);
    if (!playlist) {
      res.status(404).json({ ok: false, error: 'Playlist not found' });
      return;
    }

    await deletePlaylist(playlist._fmRecordId);

    res.json({ ok: true, playlist });
  } catch (err) {
    console.error('[MASS] Delete playlist failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to delete playlist' });
  }
});

export default router;
