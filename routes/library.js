import { Router } from 'express';
import { randomUUID } from 'crypto';
import { requireTokenEmail } from '../helpers.js';
import { loadLibrary, saveLibrary, getUserLibrary } from '../store.js';

const router = Router();

router.get('/', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const user = requireTokenEmail(req, res);
  if (!user) return;
  try {
    const library = await loadLibrary();
    const userLib = getUserLibrary(library, user.email);
    res.json({ ok: true, songs: userLib.songs, albums: userLib.albums });
  } catch (err) {
    console.error('[MASS] Load library failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to load library' });
  }
});

router.post('/songs', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const user = requireTokenEmail(req, res);
  if (!user) return;
  try {
    const { trackRecordId, name, albumTitle, albumArtist, trackArtist, artwork, S3_URL, mp3 } = req.body || {};
    if (!name) return res.status(400).json({ ok: false, error: 'Song name required' });
    const library = await loadLibrary();
    const userLib = getUserLibrary(library, user.email);
    const duplicate = userLib.songs.find(s => s.trackRecordId && s.trackRecordId === trackRecordId);
    if (duplicate) return res.json({ ok: true, duplicate: true, song: duplicate });
    const song = {
      id: randomUUID(),
      trackRecordId: trackRecordId || '',
      name,
      albumTitle: albumTitle || '',
      albumArtist: albumArtist || '',
      trackArtist: trackArtist || '',
      artwork: artwork || '',
      S3_URL: S3_URL || '',
      mp3: mp3 || '',
      addedAt: new Date().toISOString()
    };
    userLib.songs.push(song);
    await saveLibrary(library);
    res.status(201).json({ ok: true, song });
  } catch (err) {
    console.error('[MASS] Add song to library failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to add song' });
  }
});

router.delete('/songs/:songId', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const user = requireTokenEmail(req, res);
  if (!user) return;
  try {
    const library = await loadLibrary();
    const userLib = getUserLibrary(library, user.email);
    const before = userLib.songs.length;
    userLib.songs = userLib.songs.filter(s => s.id !== req.params.songId);
    if (userLib.songs.length === before) return res.status(404).json({ ok: false, error: 'Song not found' });
    await saveLibrary(library);
    res.json({ ok: true });
  } catch (err) {
    console.error('[MASS] Remove song from library failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to remove song' });
  }
});

router.post('/albums', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const user = requireTokenEmail(req, res);
  if (!user) return;
  try {
    const { title, artist, artwork, genre, year } = req.body || {};
    if (!title) return res.status(400).json({ ok: false, error: 'Album title required' });
    const library = await loadLibrary();
    const userLib = getUserLibrary(library, user.email);
    const duplicate = userLib.albums.find(a => a.title === title && a.artist === artist);
    if (duplicate) return res.json({ ok: true, duplicate: true, album: duplicate });
    const album = {
      id: randomUUID(),
      title,
      artist: artist || '',
      artwork: artwork || '',
      genre: genre || '',
      year: year || '',
      addedAt: new Date().toISOString()
    };
    userLib.albums.push(album);
    await saveLibrary(library);
    res.status(201).json({ ok: true, album });
  } catch (err) {
    console.error('[MASS] Add album to library failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to add album' });
  }
});

router.delete('/albums/:albumId', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const user = requireTokenEmail(req, res);
  if (!user) return;
  try {
    const library = await loadLibrary();
    const userLib = getUserLibrary(library, user.email);
    const before = userLib.albums.length;
    userLib.albums = userLib.albums.filter(a => a.id !== req.params.albumId);
    if (userLib.albums.length === before) return res.status(404).json({ ok: false, error: 'Album not found' });
    await saveLibrary(library);
    res.json({ ok: true });
  } catch (err) {
    console.error('[MASS] Remove album from library failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to remove album' });
  }
});

export default router;
