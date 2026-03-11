import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import {
  requireTokenEmail, validators, playlistOwnerMatches, normalizeTrackPayload,
  buildPlaylistDuplicateIndex, resolveDuplicate, summarizeTrackPayload, buildTrackEntry,
  normalizeShareId, generateShareId, sanitizePlaylistForShare, buildShareUrl,
  AUDIO_FIELD_CANDIDATES, ARTWORK_FIELD_CANDIDATES
} from '../helpers.js';
import { loadPlaylists, savePlaylists } from '../store.js';
import { fmGetRecordById, fmUpdateRecord } from '../fm-client.js';

const router = Router();

const FM_LAYOUT = process.env.FM_LAYOUT || 'API_Album_Songs';

router.get('/', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const user = requireTokenEmail(req, res);
  if (!user) return;

  try {
    const email = user.email;
    const playlists = await loadPlaylists();
    const mine = playlists.filter((p) => p && playlistOwnerMatches(p.userId, email));
    res.json({ ok: true, playlists: mine });
  } catch (err) {
    console.error('[MASS] Fetch playlists failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to load playlists' });
  }
});

router.post('/', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const user = requireTokenEmail(req, res);
  if (!user) return;

  try {
    const email = user.email;
    const nameRaw = req.body?.name;
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

    const now = new Date().toISOString();
    const playlists = await loadPlaylists();
    const collision = playlists.find(
      (p) => p && playlistOwnerMatches(p.userId, email) && typeof p.name === 'string' && p.name.toLowerCase() === name.toLowerCase()
    );
    if (collision) {
      res.status(409).json({ ok: false, error: 'You already have a playlist with that name', playlist: collision });
      return;
    }

    const playlist = {
      id: randomUUID(),
      userId: email,
      name,
      artwork,
      tracks: [],
      createdAt: now,
      updatedAt: now
    };

    playlists.push(playlist);
    await savePlaylists(playlists);

    res.status(201).json({ ok: true, playlist });
  } catch (err) {
    console.error('[MASS] Create playlist failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to create playlist' });
  }
});

router.post('/:playlistId/tracks', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const user = requireTokenEmail(req, res);
  if (!user) return;

  try {
    const email = user.email;
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

    const playlists = await loadPlaylists();
    console.log(`[MASS] Add track: email=${email}, playlistId=${playlistId}, totalPlaylists=${playlists.length}`);
    const index = playlists.findIndex((p) => p && p.id === playlistId && playlistOwnerMatches(p.userId, email));
    if (index === -1) {
      const ids = playlists.map(p => p?.id).join(',');
      const owners = playlists.map(p => p?.userId).join(',');
      console.warn(`[MASS] Playlist not found: looking for id=${playlistId} owner=${email}; stored ids=[${ids}] owners=[${owners}]`);
      res.status(404).json({ ok: false, error: 'Playlist not found' });
      return;
    }

    const playlist = playlists[index];
    playlist.tracks = Array.isArray(playlist.tracks) ? playlist.tracks : [];

    const duplicateIndex = buildPlaylistDuplicateIndex(playlist);
    const { key: dupKey, entry: duplicate } = resolveDuplicate(duplicateIndex, trackPayload);
    if (duplicate) {
      console.log(`[MASS] Duplicate track: key=${dupKey}`);
      res.status(200).json({ ok: true, playlist, track: duplicate, duplicate: true });
      return;
    }

    const addedAt = new Date().toISOString();
    const entry = buildTrackEntry(trackPayload, addedAt);

    playlist.tracks.push(entry);
    playlist.updatedAt = addedAt;

    playlists[index] = playlist;
    await savePlaylists(playlists);

    res.status(201).json({ ok: true, playlist, track: entry });
  } catch (err) {
    console.error('[MASS] Add track to playlist failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to add track' });
  }
});

router.post('/:playlistId/tracks/bulk', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const user = requireTokenEmail(req, res);
  if (!user) return;

  try {
    const email = user.email;
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

    const normalizedTracks = rawTracks.map((track) => normalizeTrackPayload(track || {}));
    const playlists = await loadPlaylists();
    const index = playlists.findIndex((p) => p && p.id === playlistId && playlistOwnerMatches(p.userId, email));
    if (index === -1) {
      res.status(404).json({ ok: false, error: 'Playlist not found' });
      return;
    }

    const playlist = playlists[index];
    playlist.tracks = Array.isArray(playlist.tracks) ? playlist.tracks : [];

    const duplicateIndex = buildPlaylistDuplicateIndex(playlist);

    const addedEntries = [];
    const duplicates = [];
    const skipped = [];
    const timestampBase = Date.now();

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

    if (addedEntries.length) {
      playlist.updatedAt = addedEntries[addedEntries.length - 1].addedAt;
      playlists[index] = playlist;
      await savePlaylists(playlists);
    }

    const status = addedEntries.length ? 201 : 200;
    res.status(status).json({
      ok: true,
      playlist,
      addedCount: addedEntries.length,
      duplicateCount: duplicates.length,
      skippedCount: skipped.length,
      added: addedEntries,
      duplicates,
      skipped
    });
  } catch (err) {
    console.error('[MASS] Bulk add tracks to playlist failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to add tracks' });
  }
});

router.post('/:playlistId/share', async (req, res) => {
  const user = requireTokenEmail(req, res);
  if (!user) return;

  let playlist = null;
  let shareId = '';

  try {
    const email = user.email;
    const playlistId = req.params?.playlistId;
    if (!playlistId) {
      res.status(400).json({ ok: false, error: 'Playlist ID required' });
      return;
    }

    const playlists = await loadPlaylists();
    const index = playlists.findIndex((p) => p && p.id === playlistId && playlistOwnerMatches(p.userId, email));
    if (index === -1) {
      res.status(404).json({ ok: false, error: 'Playlist not found' });
      return;
    }

    playlist = playlists[index];
    const tracks = Array.isArray(playlist.tracks) ? playlist.tracks : [];
    if (!tracks.length) {
      res.status(400).json({ ok: false, error: 'Add at least one track before sharing a playlist' });
      return;
    }

    const regenerate = req.body?.regenerate === true;
    const existingIds = new Set();
    playlists.forEach((entry, idx) => {
      if (!entry || idx === index) return;
      const existing = normalizeShareId(entry.shareId);
      if (existing) existingIds.add(existing);
    });

    shareId = normalizeShareId(playlist.shareId);
    const needsNewId = regenerate || !shareId || existingIds.has(shareId);
    if (needsNewId) {
      let candidate = '';
      let attempts = 0;
      do {
        candidate = generateShareId();
        attempts += 1;
      } while (existingIds.has(candidate) && attempts < 50);
      if (existingIds.has(candidate)) {
        res.status(500).json({ ok: false, error: 'Unable to generate a unique share link' });
        return;
      }
      shareId = candidate;
      playlist.shareId = shareId;
      playlist.sharedAt = new Date().toISOString();
    } else if (!playlist.sharedAt) {
      playlist.sharedAt = new Date().toISOString();
    }

    playlists[index] = playlist;
    await savePlaylists(playlists);

    const payload = sanitizePlaylistForShare(playlist);
    const shareUrl = buildShareUrl(req, shareId);

    res.json({ ok: true, shareId, shareUrl, playlist: payload });
  } catch (err) {
    console.error('[MASS] Generate playlist share link failed:', err);
    const detail = err?.message || err?.code || String(err);
    const fallbackId = normalizeShareId(shareId || playlist?.shareId);
    if (fallbackId && playlist) {
      try {
        const payload = sanitizePlaylistForShare(playlist);
        const shareUrl = buildShareUrl(req, fallbackId);
        res.json({ ok: true, shareId: fallbackId, shareUrl, playlist: payload, reused: true, error: 'Existing share link reused' });
        return;
      } catch (fallbackErr) {
        console.error('[MASS] Fallback share link serialization failed:', fallbackErr);
      }
    }
    res.status(500).json({ ok: false, error: 'Unable to generate share link', detail });
  }
});

// ── Share playlist by email ────────────────────────────────────────────────
router.post('/:playlistId/share/email', async (req, res) => {
  const user = requireTokenEmail(req, res);
  if (!user) return;

  const playlistId = req.params?.playlistId;
  const { recipientEmail, recipientName } = req.body || {};

  if (!playlistId) return res.status(400).json({ ok: false, error: 'Playlist ID required' });
  if (!recipientEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail)) {
    return res.status(400).json({ ok: false, error: 'Valid recipient email required' });
  }

  try {
    // 1. Load playlists and find the one being shared
    const playlists = await loadPlaylists();
    const playlist = playlists.find(
      (p) => p && String(p.id).trim() === String(playlistId).trim()
    );
    if (!playlist) return res.status(404).json({ ok: false, error: 'Playlist not found' });

    // 2. Ensure it has a shareId (generate one if missing)
    if (!playlist.shareId) {
      playlist.shareId = generateShareId();
      playlist.sharedAt = new Date().toISOString();
      await savePlaylists(playlists);
    }
    const shareUrl = buildShareUrl(req, playlist.shareId);
    const playlistName = playlist.name || 'a playlist';
    const senderLabel = recipientName
      ? `${recipientName}`
      : (user.email || 'Someone');
    const trackCount = Array.isArray(playlist.tracks) ? playlist.tracks.length : 0;
    const trackWord  = trackCount === 1 ? 'track' : 'tracks';

    // 3. Build and send email via Nodemailer
    const nodemailer = (await import('nodemailer')).default;
    const transporter = nodemailer.createTransport({
      host:   process.env.EMAIL_HOST,
      port:   Number(process.env.EMAIL_PORT) || 587,
      secure: Number(process.env.EMAIL_PORT) === 465,
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });

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
            <a href="${shareUrl}" style="display:inline-block;background:#62f5a9;color:#0a0a0a;font-weight:700;font-size:15px;text-decoration:none;padding:14px 36px;border-radius:50px;letter-spacing:0.3px;">
              Listen Now →
            </a>
          </div>
          <p style="color:#555;font-size:13px;margin:0;line-height:1.6;">
            If the button doesn't work, copy this link into your browser:<br>
            <a href="${shareUrl}" style="color:#62f5a9;word-break:break-all;">${shareUrl}</a>
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

router.post('/:playlistId/publish-to-filemaker', async (req, res) => {
  const user = requireTokenEmail(req, res);
  if (!user) return;

  try {
    const email = user.email;
    const playlistId = req.params?.playlistId;

    if (!playlistId) {
      return res.status(400).json({ ok: false, error: 'Playlist ID required' });
    }

    const playlists = await loadPlaylists();
    const playlist = playlists.find((p) => p && p.id === playlistId && playlistOwnerMatches(p.userId, email));

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
        await fmUpdateRecord(FM_LAYOUT, recId, {
          'PublicPlaylist': playlistName
        });
        results.push({ track: track.name || 'Unknown', recordId: recId, success: true });
        console.log(`[MASS] ✓ Updated track "${track.name}" (${recId}) with PublicPlaylist="${playlistName}"`);
      } catch (err) {
        const errMsg = err?.message || String(err);
        results.push({ track: track.name || 'Unknown', recordId: recId, success: false, error: errMsg });
        console.error(`[MASS] ✗ Failed to update track "${track.name}" (${recId}):`, errMsg);
      }
    }

    const successCount = results.filter(r => r.success).length;
    const failCount = results.filter(r => !r.success).length;

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

router.get('/:playlistId/export', async (req, res) => {
  const user = requireTokenEmail(req, res);
  if (!user) return;

  try {
    const email = user.email;
    const playlistId = req.params?.playlistId;
    if (!playlistId) {
      return res.status(400).json({ ok: false, error: 'Playlist ID required' });
    }

    const playlists = await loadPlaylists();
    const playlist = playlists.find((p) => p && p.id === playlistId && playlistOwnerMatches(p.userId, email));

    if (!playlist || !Array.isArray(playlist.tracks)) {
      return res.status(404).json({ ok: false, error: 'Playlist not found' });
    }

    const trackIds = playlist.tracks
      .map((t) => t.trackRecordId || t.recordId)
      .filter(Boolean);

    if (!trackIds.length) {
      return res.json({ ok: true, code: '' });
    }

    const code = Buffer.from(trackIds.join(',')).toString('base64').replace(/=/g, '');
    res.json({ ok: true, code });
  } catch (err) {
    console.error('[MASS] Export playlist failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to export playlist', detail: err?.message });
  }
});

router.post('/:playlistId/import', async (req, res) => {
  const user = requireTokenEmail(req, res);
  if (!user) return;

  try {
    const email = user.email;
    const playlistId = req.params?.playlistId;
    const { code: importCode, playlistName: importedName } = req.body || {};

    if (!playlistId) {
      return res.status(400).json({ ok: false, error: 'Playlist ID required' });
    }

    if (!importCode || typeof importCode !== 'string') {
      return res.status(400).json({ ok: false, error: 'Import code required' });
    }

    let importedTrackIds = [];
    try {
      const padded = importCode + '='.repeat((4 - (importCode.length % 4)) % 4);
      const decoded = Buffer.from(padded, 'base64').toString('utf-8');
      importedTrackIds = decoded.split(',').filter(Boolean);
    } catch (err) {
      return res.status(400).json({ ok: false, error: 'Invalid import code', detail: err?.message });
    }

    if (!importedTrackIds.length) {
      return res.status(400).json({ ok: false, error: 'No tracks in import code' });
    }

    console.log(`[MASS] Import: Validating ${importedTrackIds.length} track IDs`);
    const validTrackIds = [];
    const failedIds = [];
    for (const trackId of importedTrackIds.slice(0, 100)) {
      try {
        const record = await fmGetRecordById(FM_LAYOUT, trackId);
        if (record) {
          console.log(`[MASS] Import: ✓ Found track ID: ${trackId}`);
          validTrackIds.push(trackId);
        } else {
          console.log(`[MASS] Import: ✗ Track ID not found: ${trackId}`);
          failedIds.push(trackId);
        }
      } catch (err) {
        console.error(`[MASS] Import: ✗ Error fetching track ${trackId}:`, err.message);
        failedIds.push(trackId);
      }
    }

    console.log(`[MASS] Import: Valid IDs: ${validTrackIds.length}, Failed IDs: ${failedIds.length}`);
    if (failedIds.length > 0) {
      console.log(`[MASS] Import: Failed ID samples:`, failedIds.slice(0, 5));
    }

    if (!validTrackIds.length) {
      return res.status(400).json({
        ok: false,
        error: 'None of the imported tracks were found',
        detail: `Tried ${importedTrackIds.length} track IDs, none found in FileMaker`
      });
    }

    const now = new Date().toISOString();
    const playlists = await loadPlaylists();
    const newPlaylist = {
      id: randomUUID(),
      userId: email,
      name: importedName || 'Imported Playlist',
      tracks: [],
      createdAt: now,
      updatedAt: now
    };

    for (const trackId of validTrackIds) {
      try {
        const record = await fmGetRecordById(FM_LAYOUT, trackId);

        if (record) {
          const fields = record.fieldData || {};

          const trackObj = {
            trackRecordId: trackId,
            name: fields['Track Name'] || fields['Tape Files::Track Name'] || 'Unknown Track',
            albumTitle: fields['Album'] || fields['Tape Files::Album'] || '',
            albumArtist: fields['Album Artist'] || fields['Artist'] || fields['Tape Files::Album Artist'] || '',
            trackArtist: fields['Track Artist'] || fields['Album Artist'] || '',
            catalogue: fields['Catalogue #'] || fields['Catalogue'] || '',
            addedAt: now
          };

          const audioField = AUDIO_FIELD_CANDIDATES.find(f => fields[f]);
          const artworkField = ARTWORK_FIELD_CANDIDATES.find(f => fields[f]);

          if (audioField) {
            trackObj.mp3 = fields[audioField];
            trackObj.audioField = audioField;
          }
          if (artworkField) {
            trackObj.artwork = fields[artworkField];
            trackObj.artworkField = artworkField;
          }

          newPlaylist.tracks.push(trackObj);
        }
      } catch (err) {
        console.error(`[MASS] Failed to fetch track ${trackId}:`, err);
      }
    }

    playlists.push(newPlaylist);
    await savePlaylists(playlists);

    res.json({
      ok: true,
      playlist: newPlaylist,
      imported: newPlaylist.tracks.length,
      skipped: importedTrackIds.length - newPlaylist.tracks.length
    });
  } catch (err) {
    console.error('[MASS] Import playlist failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to import playlist', detail: err?.message });
  }
});

router.delete('/:playlistId/tracks/:addedAt', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const user = requireTokenEmail(req, res);
  if (!user) return;

  try {
    const email = user.email;
    const playlistId = req.params?.playlistId;
    const addedAt = req.params?.addedAt;

    if (!playlistId) {
      res.status(400).json({ ok: false, error: 'Playlist ID required' });
      return;
    }
    if (!addedAt) {
      res.status(400).json({ ok: false, error: 'Track addedAt timestamp required' });
      return;
    }

    const playlists = await loadPlaylists();
    const playlistIndex = playlists.findIndex((p) => p && p.id === playlistId && playlistOwnerMatches(p.userId, email));
    if (playlistIndex === -1) {
      res.status(404).json({ ok: false, error: 'Playlist not found' });
      return;
    }

    const playlist = playlists[playlistIndex];
    playlist.tracks = Array.isArray(playlist.tracks) ? playlist.tracks : [];

    const trackIndex = playlist.tracks.findIndex((t) => t && t.addedAt === addedAt);
    if (trackIndex === -1) {
      res.status(404).json({ ok: false, error: 'Track not found in playlist' });
      return;
    }

    const [deletedTrack] = playlist.tracks.splice(trackIndex, 1);
    playlist.updatedAt = new Date().toISOString();

    playlists[playlistIndex] = playlist;
    await savePlaylists(playlists);

    res.json({ ok: true, playlist, track: deletedTrack });
  } catch (err) {
    console.error('[MASS] Delete track from playlist failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to delete track from playlist' });
  }
});

router.delete('/:playlistId', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const user = requireTokenEmail(req, res);
  if (!user) return;

  try {
    const email = user.email;
    const playlistId = req.params?.playlistId;
    if (!playlistId) {
      res.status(400).json({ ok: false, error: 'Playlist ID required' });
      return;
    }

    const playlists = await loadPlaylists();
    const index = playlists.findIndex((p) => p && p.id === playlistId && playlistOwnerMatches(p.userId, email));
    if (index === -1) {
      res.status(404).json({ ok: false, error: 'Playlist not found' });
      return;
    }

    const [deleted] = playlists.splice(index, 1);
    await savePlaylists(playlists);

    res.json({ ok: true, playlist: deleted || null });
  } catch (err) {
    console.error('[MASS] Delete playlist failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to delete playlist' });
  }
});

export default router;
