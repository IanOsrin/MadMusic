import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { requireTokenEmail } from '../lib/auth.js';
import { loadUserLibrary, updateUserLibrary } from '../lib/library-store.js';

const router = Router();

// All library routes return user-specific data — never cache on client or CDN.
router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

router.get('/', async (req, res) => {
  const user = requireTokenEmail(req, res);
  if (!user) return;
  try {
    const { songs, albums } = await loadUserLibrary(user.email);
    res.json({ ok: true, songs, albums });
  } catch (err) {
    console.error('[MASS] Load library failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to load library' });
  }
});

router.post('/songs', async (req, res) => {
  const user = requireTokenEmail(req, res);
  if (!user) return;
  try {
    const { trackRecordId, name, albumTitle, albumArtist, trackArtist, artwork, S3_URL, mp3 } = req.body || {};
    if (!name) return res.status(400).json({ ok: false, error: 'Song name required' });

    const result = await updateUserLibrary(user.email, ({ songs, albums }) => {
      const duplicate = songs.find(s => s.trackRecordId && s.trackRecordId === trackRecordId);
      if (duplicate) return { songs, albums, duplicate, song: duplicate };

      const song = {
        id:            randomUUID(),
        trackRecordId: trackRecordId || '',
        name,
        albumTitle:    albumTitle  || '',
        albumArtist:   albumArtist || '',
        trackArtist:   trackArtist || '',
        artwork:       artwork     || '',
        S3_URL:        S3_URL      || '',
        mp3:           mp3         || '',
        addedAt:       new Date().toISOString()
      };
      songs.push(song);
      return { songs, albums, song };
    });

    if (result.duplicate) return res.json({ ok: true, duplicate: true, song: result.song });
    res.status(201).json({ ok: true, song: result.song });
  } catch (err) {
    console.error('[MASS] Add song to library failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to add song' });
  }
});

router.delete('/songs/:songId', async (req, res) => {
  const user = requireTokenEmail(req, res);
  if (!user) return;
  try {
    const songId = req.params.songId;
    const result = await updateUserLibrary(user.email, ({ songs, albums }) => {
      const before  = songs.length;
      const updated = songs.filter(s => s.id !== songId);
      return { songs: updated, albums, notFound: updated.length === before };
    });
    if (result.notFound) return res.status(404).json({ ok: false, error: 'Song not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[MASS] Remove song from library failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to remove song' });
  }
});

router.post('/albums', async (req, res) => {
  const user = requireTokenEmail(req, res);
  if (!user) return;
  try {
    const { title, artist, artwork, genre, year } = req.body || {};
    if (!title) return res.status(400).json({ ok: false, error: 'Album title required' });

    const result = await updateUserLibrary(user.email, ({ songs, albums }) => {
      const duplicate = albums.find(a => a.title === title && a.artist === artist);
      if (duplicate) return { songs, albums, duplicate, album: duplicate };

      const album = {
        id:      randomUUID(),
        title,
        artist:  artist  || '',
        artwork: artwork || '',
        genre:   genre   || '',
        year:    year    || '',
        addedAt: new Date().toISOString()
      };
      albums.push(album);
      return { songs, albums, album };
    });

    if (result.duplicate) return res.json({ ok: true, duplicate: true, album: result.album });
    res.status(201).json({ ok: true, album: result.album });
  } catch (err) {
    console.error('[MASS] Add album to library failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to add album' });
  }
});

router.delete('/albums/:albumId', async (req, res) => {
  const user = requireTokenEmail(req, res);
  if (!user) return;
  try {
    const albumId = req.params.albumId;
    const result = await updateUserLibrary(user.email, ({ songs, albums }) => {
      const before  = albums.length;
      const updated = albums.filter(a => a.id !== albumId);
      return { songs, albums: updated, notFound: updated.length === before };
    });
    if (result.notFound) return res.status(404).json({ ok: false, error: 'Album not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[MASS] Remove album from library failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to remove album' });
  }
});

export default router;
