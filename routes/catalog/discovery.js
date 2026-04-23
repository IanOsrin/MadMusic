// routes/catalog/discovery.js — /random-songs, /public-playlists, /album, /missing-audio-songs
import { Router } from 'express';
import { randomInt } from 'node:crypto';
import { fmPost, fmFindRecords } from '../../fm-client.js';
import { albumCache, randomSongsPoolCache } from '../../cache.js';
import { hasValidAudio, hasValidArtwork, resolvePlayableSrc, resolveArtworkSrc } from '../../lib/track.js';
import {
  FM_LAYOUT,
  firstNonEmpty, AUDIO_FIELD_CANDIDATES, ARTWORK_FIELD_CANDIDATES,
  CATALOGUE_FIELD_CANDIDATES, pickFieldValueCaseInsensitive
} from '../../lib/fm-fields.js';
import { fmErrorToHttpStatus } from '../../lib/http.js';
import { validateQueryString } from '../../lib/validators.js';
import { resolvePlaylistImage } from '../../lib/playlist.js';
import { createSwrCache } from '../../lib/swr-cache.js';
import { createLogger } from '../../lib/logger.js';
import { parsePositiveInt } from '../../lib/format.js';

const router       = Router();
const log          = createLogger('public-playlists');
const logRandom    = createLogger('random-songs');
const logMissing   = createLogger('missing-audio');
const logAlbum     = createLogger('album');

// Aggressive TTLs with SWR — serve instantly, refresh in background.
const PUBLIC_PLAYLISTS_LIST_TTL_MS   = parsePositiveInt(process.env.PUBLIC_PLAYLISTS_LIST_TTL_MS,   60 * 60 * 1000); // 60 min
const PUBLIC_PLAYLISTS_TRACKS_TTL_MS = parsePositiveInt(process.env.PUBLIC_PLAYLISTS_TRACKS_TTL_MS, 30 * 60 * 1000); // 30 min

// Cryptographically safe Fisher-Yates shuffle
function cryptoShuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ── Random-songs helpers ──────────────────────────────────────────────────────

function deduplicateByAlbumArtist(records, count) {
  const seenAlbums  = new Set();
  const seenArtists = new Set();
  const deduped = [];
  for (const record of records) {
    const fields = record.fieldData || {};
    const artist   = (firstNonEmpty(fields, ['Album Artist', 'Tape Files::Album Artist', 'Artist']) || '').toLowerCase().trim();
    const album    = (firstNonEmpty(fields, ['Album Title',  'Tape Files::Album Title',  'Album'])  || '').toLowerCase().trim();
    const albumKey = `${album}|||${artist}`;
    if (seenAlbums.has(albumKey) || seenArtists.has(artist)) continue;
    seenAlbums.add(albumKey);
    seenArtists.add(artist);
    deduped.push(record);
    if (deduped.length >= count) break;
  }
  return deduped;
}

// Fetch a pool of songs from FM for a given genre key, bypassing the pool cache.
// Returns { error, data, msg, code } — same shape as before.
async function fetchPoolFromFM(genres) {
  if (genres.length > 0) {
    const genreFieldCandidates = ['Local Genre', 'Song Files::Local Genre'];
    for (const field of genreFieldCandidates) {
      const query = genres.map(genre => ({ [field]: `*${genre}*` }));
      const response = await fmPost(`/layouts/${encodeURIComponent(FM_LAYOUT)}/_find`, { query, limit: 500 });
      const json = await response.json().catch(() => ({}));
      if (response.ok) {
        logRandom.debug(`pool fetch (genre "${field}"): ${json?.response?.data?.length ?? 0} records from FM`);
        return { error: false, data: json?.response?.data || [] };
      }
    }
    return { error: true, msg: 'No valid genre field found', code: null };
  }

  // No genre filter — pick a random window across the full catalogue
  const query = [{ 'Album Title': '*' }];
  const countResponse = await fmPost(`/layouts/${encodeURIComponent(FM_LAYOUT)}/_find`, { query, limit: 1 });
  const countJson = await countResponse.json().catch(() => ({}));
  if (!countResponse.ok) {
    const msg = countJson?.messages?.[0]?.message || 'FM error';
    const code = countJson?.messages?.[0]?.code;
    return { error: true, msg, code };
  }

  const totalRecords = countJson?.response?.dataInfo?.foundCount || 0;
  const windowSize   = Math.min(Math.max(500, 600), 1000);
  const maxStart     = Math.max(1, totalRecords - windowSize + 1);
  const randStart    = randomInt(1, Math.max(2, maxStart + 1));

  const response = await fmPost(`/layouts/${encodeURIComponent(FM_LAYOUT)}/_find`, { query, limit: windowSize, offset: randStart });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const msg = json?.messages?.[0]?.message || 'FM error';
    const code = json?.messages?.[0]?.code;
    return { error: true, msg, code };
  }
  logRandom.debug(`pool fetch (no genre): ${json?.response?.data?.length ?? 0} records from FM`);
  return { error: false, data: json?.response?.data || [] };
}

// In-flight promise map — prevents thundering herd: if 50 requests arrive
// simultaneously for the same cache key, only one FM call goes out.
const poolInflight = new Map();

async function getPool(cacheKey, genres) {
  const cached = randomSongsPoolCache.get(cacheKey);
  if (cached) return cached;

  // Check if there's already a request in flight for this key
  if (poolInflight.has(cacheKey)) {
    return poolInflight.get(cacheKey);
  }

  const promise = fetchPoolFromFM(genres).then(result => {
    poolInflight.delete(cacheKey);
    if (!result.error && result.data.length > 0) {
      randomSongsPoolCache.set(cacheKey, result);
    }
    return result;
  }).catch(err => {
    poolInflight.delete(cacheKey);
    throw err;
  });

  poolInflight.set(cacheKey, promise);
  return promise;
}

// Legacy wrappers kept so the router logic below stays readable
async function fetchSongsByGenre(genres, _fetchLimit) {
  const cacheKey = `genre:${genres.sort().join(',')}`;
  const result = await getPool(cacheKey, genres);
  if (result.error) return null;
  return result.data;
}

async function fetchRandomSongsData(_count) {
  const result = await getPool('all', []);
  return result;
}

// ── GET /random-songs ─────────────────────────────────────────────────────────
router.get('/random-songs', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');

    const countParam = Number.parseInt(req.query.count || '12', 10);
    const count = Number.isFinite(countParam) ? Math.max(1, Math.min(100, countParam)) : 12;

    const genreParam = (req.query.genre || req.query.genres || '').toString().trim();
    const genres = genreParam.split(',').map(g => g.trim()).filter(Boolean);

    const genreStr = genres.length ? ` (genres: ${genres.join(', ')})` : '';
    logRandom.debug(`requesting ${count} songs${genreStr}`);

    let data = [];

    if (genres.length > 0) {
      const genreData = await fetchSongsByGenre(genres, count * 3);
      if (genreData === null) {
        logRandom.error('No valid genre field found on layout');
        return res.status(500).json({ ok: false, error: 'Genre filtering not supported on this layout' });
      }
      data = genreData;
    } else {
      const result = await fetchRandomSongsData(count);
      if (result.error) {
        logRandom.error(`FileMaker error: ${result.msg} (${result.code})`);
        return res.status(500).json({ ok: false, error: result.msg, code: result.code });
      }
      data = result.data;
    }

    const validRecords = data.filter(record => {
      const fields = record.fieldData || {};
      return hasValidAudio(fields) && hasValidArtwork(fields);
    });

    const shuffled = cryptoShuffle(validRecords);
    const selected = deduplicateByAlbumArtist(shuffled, count);

    const items = selected.map(record => {
      const fields = record.fieldData || {};
      const recordId = String(record.recordId || '');
      const albumArtist = firstNonEmpty(fields, ['Album Artist', 'Tape Files::Album Artist', 'Artist']);
      const trackArtist = firstNonEmpty(fields, ['Track Artist', 'Artist']) || albumArtist;
      const albumTitle = firstNonEmpty(fields, ['Album Title', 'Tape Files::Album Title', 'Album']);
      const trackName = firstNonEmpty(fields, ['Track Name', 'Tape Files::Track Name', 'Song Title', 'Title']);
      const catalogue = firstNonEmpty(fields, CATALOGUE_FIELD_CANDIDATES);
      const genre = firstNonEmpty(fields, ['Local Genre', 'Song Files::Local Genre']);
      const audioInfo = pickFieldValueCaseInsensitive(fields, AUDIO_FIELD_CANDIDATES);
      const artworkInfo = pickFieldValueCaseInsensitive(fields, ARTWORK_FIELD_CANDIDATES);
      const audioSrc = resolvePlayableSrc(audioInfo.value);
      const artworkSrc = resolveArtworkSrc(artworkInfo.value);

      return {
        recordId,
        fields: {
          'Track Artist': trackArtist,
          'Album Artist': albumArtist,
          'Album Title': albumTitle,
          'Track Name': trackName,
          'Catalogue': catalogue,
          'Local Genre': genre,
          [audioInfo.field]: audioInfo.value,
          [artworkInfo.field]: artworkInfo.value
        },
        audioSrc,
        artworkSrc
      };
    }).filter(item => item.audioSrc && item.artworkSrc);

    logRandom.debug(`returning ${items.length} songs`);
    res.json({ ok: true, items, count: items.length });
  } catch (err) {
    logRandom.error('Error:', err);
    const detail = err?.message || String(err);
    res.status(500).json({ ok: false, error: 'Failed to fetch random songs', detail });
  }
});

// ── GET /public-playlists ─────────────────────────────────────────────────────
// Two code paths, each SWR-wrapped:
//   - ?name=X      → tracks belonging to that playlist
//   - (no name)    → list of all playlist names with track counts + images
// Both return stale-instantly while a fresh fetch refreshes in the background.

async function loadPlaylistTracks(name) {
  const result = await fmFindRecords(
    FM_LAYOUT,
    [{ 'PublicPlaylist': `==${name}` }],
    { limit: 2000, offset: 1 }
  );
  if (!result.ok) {
    const err = new Error('Playlist not found or FM error');
    err.statusCode = 404;
    throw err;
  }
  const rawTracks = result.data
    .filter(r => hasValidAudio(r.fieldData || {}))
    .map(r => {
      const f           = r.fieldData || {};
      const audioInfo   = pickFieldValueCaseInsensitive(f, AUDIO_FIELD_CANDIDATES);
      const artworkInfo = pickFieldValueCaseInsensitive(f, ARTWORK_FIELD_CANDIDATES);
      const artworkSrc  = resolveArtworkSrc(artworkInfo.value) || artworkInfo.value || '';
      const orderRaw    = f['PublicPlaylistOrder'];
      const playlistOrder = (orderRaw !== undefined && orderRaw !== '' && orderRaw !== null)
        ? Number(orderRaw) : null;
      return {
        recordId:      r.recordId,
        trackRecordId: r.recordId,
        playlistOrder,
        name:        firstNonEmpty(f, ['Track Name', 'Tape Files::Track Name', 'Song Title']) || 'Unknown Track',
        albumTitle:  firstNonEmpty(f, ['Album Title', 'Tape Files::Album Title', 'Album']) || '',
        albumArtist: firstNonEmpty(f, ['Album Artist', 'Tape Files::Album Artist', 'Artist']) || '',
        trackArtist: f['Track Artist'] || firstNonEmpty(f, ['Album Artist', 'Tape Files::Album Artist']) || '',
        mp3:         audioInfo.value || '',
        resolvedSrc: resolvePlayableSrc(audioInfo.value),
        picture:     artworkSrc,
        artwork:     artworkSrc
      };
    });

  const hasOrder = rawTracks.some(t => t.playlistOrder !== null && Number.isFinite(t.playlistOrder));
  const tracks = hasOrder
    ? rawTracks.slice().sort((a, b) => {
        const aHas = a.playlistOrder !== null && Number.isFinite(a.playlistOrder);
        const bHas = b.playlistOrder !== null && Number.isFinite(b.playlistOrder);
        if (aHas && bHas) return a.playlistOrder - b.playlistOrder;
        if (aHas) return -1;
        if (bHas) return 1;
        return 0;
      })
    : rawTracks;

  log.debug(`"${name}" → ${tracks.length} tracks, ordered=${hasOrder}`);
  return { ok: true, tracks };
}

async function loadPlaylistListPayload() {
  const result = await fmFindRecords(
    FM_LAYOUT,
    [{ 'PublicPlaylist': '*' }],
    { limit: 2000, offset: 1 }
  );
  if (!result.ok) {
    throw new Error('Failed to load public playlists from FileMaker');
  }

  const playlistMap = new Map();
  for (const r of result.data) {
    const name = (r.fieldData?.PublicPlaylist || '').trim();
    if (!name) continue;
    if (!playlistMap.has(name)) {
      playlistMap.set(name, { name, trackCount: 0, order: null });
    }
    const entry = playlistMap.get(name);
    entry.trackCount += 1;
    if (entry.order === null) {
      const orderRaw = r.fieldData?.PublicPlaylistOrder;
      if (orderRaw !== undefined && orderRaw !== '' && orderRaw !== null) {
        const parsed = Number(orderRaw);
        if (Number.isFinite(parsed)) entry.order = parsed;
      }
    }
  }

  const allEntries  = Array.from(playlistMap.values());
  const rawPlaylists = allEntries
    .sort((a, b) => {
      const aHas = a.order !== null && Number.isFinite(a.order);
      const bHas = b.order !== null && Number.isFinite(b.order);
      if (aHas && bHas) return a.order - b.order;
      if (aHas) return -1;
      if (bHas) return 1;
      return 0;
    });
  const playlists = await Promise.all(
    rawPlaylists.map(async (pl) => ({
      ...pl,
      imageUrl: await resolvePlaylistImage(pl.name) || null
    }))
  );
  log.debug(`${playlists.length} playlists loaded`);
  return { ok: true, playlists };
}

const publicPlaylistTracksSwr = createSwrCache({
  ttlMs: PUBLIC_PLAYLISTS_TRACKS_TTL_MS,
  max:   200,
  label: 'public-playlist-tracks',
  name:  'publicPlaylistTracks',
  loader: (key) => loadPlaylistTracks(key.slice('tracks:'.length))
});

const publicPlaylistListSwr = createSwrCache({
  ttlMs: PUBLIC_PLAYLISTS_LIST_TTL_MS,
  max:   2,
  label: 'public-playlist-list',
  name:  'publicPlaylistList',
  loader: () => loadPlaylistListPayload()
});

export const publicPlaylistsWarmer = () => publicPlaylistListSwr.get('list');

router.get('/public-playlists', async (req, res) => {
  try {
    const nameParam  = (req.query.name || '').toString().trim();
    const limitParam = Number.parseInt((req.query.limit || '100'), 10);
    const limit      = Number.isFinite(limitParam) ? Math.max(1, Math.min(2000, limitParam)) : 100;
    const bustCache  = req.query.bust === '1' || req.query.bust === 'true';

    if (nameParam) {
      const key = `tracks:${nameParam}`;
      if (bustCache) publicPlaylistTracksSwr.cache.delete(key);
      const { value, state } = await publicPlaylistTracksSwr.get(key);
      res.setHeader('X-Cache-State', state);
      return res.json(value);
    }

    const key = 'list';
    if (bustCache) publicPlaylistListSwr.cache.delete(key);
    const { value, state } = await publicPlaylistListSwr.get(key);
    res.setHeader('X-Cache-State', state);
    // Apply limit to the list view (tracks view already respects fm limit in the query).
    if (Array.isArray(value.playlists) && value.playlists.length > limit) {
      return res.json({ ...value, playlists: value.playlists.slice(0, limit) });
    }
    return res.json(value);
  } catch (err) {
    const status = err?.statusCode || 500;
    if (status >= 500) log.error('fetch failed:', err);
    res.status(status).json({ ok: false, error: err?.message || 'Failed to load public playlists' });
  }
});

// ── GET /missing-audio-songs ──────────────────────────────────────────────────
router.get('/missing-audio-songs', async (req, res) => {
  try {
    const count = Math.max(1, Math.min(50, Number.parseInt(req.query.count || '12', 10)));

    const fetchLimit = count * 20;
    const maxOffset = 10000;
    const randomOffset = randomInt(1, maxOffset + 1);

    logMissing.debug(`fetching ${fetchLimit} records from offset ${randomOffset}`);

    const json = await fmFindRecords(FM_LAYOUT, [{ 'Album Title': '*' }], {
      limit: fetchLimit,
      offset: randomOffset
    });

    const rawData = json?.data || [];
    logMissing.debug(`fetched ${rawData.length} total records`);

    const missingAudioRecords = rawData.filter(record => {
      const fields = record.fieldData || {};
      return !hasValidAudio(fields);
    });

    logMissing.debug(`found ${missingAudioRecords.length} songs without audio out of ${rawData.length} total`);

    const shuffled = cryptoShuffle(missingAudioRecords);
    const selected = shuffled.slice(0, count);

    const items = selected.map(record => ({
      recordId: record.recordId,
      modId: record.modId,
      fields: record.fieldData || {}
    }));

    logMissing.debug(`returning ${items.length} songs`);
    return res.json({ ok: true, items, total: items.length });
  } catch (err) {
    logMissing.error('Error:', err);
    const detail = err?.message || String(err);
    return res.status(500).json({ error: 'Missing audio songs failed', status: 500, detail });
  }
});

// ── GET /album ────────────────────────────────────────────────────────────────
router.get('/album', async (req, res) => {
  try {
    const catValidation = validateQueryString(req.query.cat, 'cat', 100);
    if (!catValidation.ok) {
      return res.status(400).json({ error: catValidation.reason });
    }
    const titleValidation = validateQueryString(req.query.title, 'title', 200);
    if (!titleValidation.ok) {
      return res.status(400).json({ error: titleValidation.reason });
    }
    const artistValidation = validateQueryString(req.query.artist, 'artist', 200);
    if (!artistValidation.ok) {
      return res.status(400).json({ error: artistValidation.reason });
    }

    const cat = catValidation.value;
    const title = titleValidation.value;
    const artist = artistValidation.value;
    const limit = Math.max(1, Math.min(1000, Number.parseInt(req.query.limit || '100', 10)));

    const cacheKey = `album:${cat}:${title}:${artist}:${limit}`;
    const cached = albumCache.get(cacheKey);
    if (cached) {
      logAlbum.debug(`cache hit: ${cacheKey.slice(0, 50)}...`);
      res.setHeader('X-Cache-Hit', 'true');
      return res.json(cached);
    }

    let queries = [];

    if (cat) {
      queries = [{ 'Reference Catalogue Number': cat }];
    } else if (title && artist) {
      queries = [{ 'Album Title': title, 'Album Artist': artist }];
    } else if (title) {
      queries = [{ 'Album Title': title }];
    } else {
      return res.status(400).json({ error: 'Missing cat or title' });
    }

    const payload = { query: queries, limit, offset: 1 };
    const r = await fmPost(`/layouts/${encodeURIComponent(FM_LAYOUT)}/_find`, payload);
    const json = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = json?.messages?.[0]?.message || 'FM error';
      const code = json?.messages?.[0]?.code;
      const httpStatus = fmErrorToHttpStatus(code, r.status);
      return res.status(httpStatus).json({ error: 'Album lookup failed', status: httpStatus, detail: `${msg} (FM ${code})` });
    }

    const rawData = json?.response?.data || [];
    const data = rawData.filter(d => hasValidAudio(d.fieldData || {}));
    const actualTotal = json?.response?.dataInfo?.foundCount ?? rawData.length;

    const response = {
      ok: true,
      items: data.map((d) => ({ recordId: d.recordId, modId: d.modId, fields: d.fieldData || {} })),
      total: actualTotal,
      offset: 0,
      limit
    };

    albumCache.set(cacheKey, response);
    return res.json(response);
  } catch (err) {
    const detail = err?.message || String(err);
    return res.status(500).json({ error: 'Album lookup failed', status: 500, detail });
  }
});

export default router;
