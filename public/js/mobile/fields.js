// Field/format accessors for the mobile app. Thin delegations to
// window.MADHelpers (shared canonical helpers), plus the getters mobile keeps
// local on purpose (getArtworkUrl/getAudioUrl/getYearField/hasValidArtwork).
// Do NOT re-grow local copies of the delegated ones — that reintroduces drift.

// Canonical HTML escaper (escapes & < > " ') shared by all mobile modules.
// Thin delegation to the same window.MADHelpers helper the rest of the app uses.
export function escapeHtml(s) {
  return window.MADHelpers.escapeHtml(s);
}

export function getFieldValue(fields, fieldNames) {
  return window.MADHelpers.getFieldValue(fields, fieldNames);
}

export function getArtworkUrl(fields) {
  const artworkFields = ['Artwork_S3_URL', 'Tape Files::Artwork_S3_URL', 'Artwork::Picture', 'Artwork Picture', 'Picture'];
  const artwork = getFieldValue(fields, artworkFields);
  if (!artwork) return '/img/placeholder.png';

  // Handle FileMaker container URLs
  if (artwork.startsWith('https://') || artwork.startsWith('http://')) {
    return artwork;
  }
  return artwork;
}

export function getTitleField(fields) {
  return window.MADHelpers.getTitleField(fields);
}

export function getArtistField(fields) {
  return window.MADHelpers.getArtistField(fields);
}

// Album-level artist for grouping keys/album cards (album-first). Using the
// track-first getArtistField here would split a compilation album into one
// card per track artist.
export function getAlbumArtist(fields) {
  return window.MADHelpers.getAlbumArtist(fields);
}

export function getAlbumField(fields) {
  return window.MADHelpers.getAlbumField(fields);
}

export function getYearField(fields) {
  const yearFields = ['Year', 'Year Recorded', 'Year_Recorded', 'Release Year', 'Release_Year', 'Date'];
  return getFieldValue(fields, yearFields) || '';
}

export function getAudioUrl(fields) {
  const audioFields = ['S3_URL', 'mp3', 'MP3', 'Audio File', 'Audio::mp3'];
  return getFieldValue(fields, audioFields);
}

// Check if an item has valid audio. Delegates to the canonical 10-field
// helper (was a 5-field copy here that wrongly hid tracks whose audio lives
// in Tape Files::* fields — e.g. missing New Releases).
export function hasValidAudio(item) {
  return window.MADHelpers.hasValidAudio(item);
}

// Check if an item has valid artwork
export function hasValidArtwork(item) {
  if (!item || !item.fields) return false;
  const artworkFields = ['Artwork_S3_URL', 'Tape Files::Artwork_S3_URL', 'Artwork::Picture', 'Artwork Picture', 'Picture'];
  const artwork = getFieldValue(item.fields, artworkFields);

  // Must be a non-empty string that is a real HTTP/HTTPS URL
  if (!artwork || typeof artwork !== 'string') return false;
  const trimmed = artwork.trim();
  if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) return false;
  // Must look like an image URL (has some path/extension after the host)
  if (trimmed.length < 12) return false;

  return true;
}

// Group tracks by album
export function groupTracksByAlbum(tracks) {
  const albums = new Map();

  tracks.forEach(track => {
    const fields = track.fields || {};
    const albumTitle = getAlbumField(fields);
    const albumArtist = getAlbumArtist(fields);
    const albumKey = `${albumTitle}|||${albumArtist}`.toLowerCase();

    if (!albums.has(albumKey)) {
      albums.set(albumKey, {
        title: albumTitle,
        artist: albumArtist,
        artwork: getArtworkUrl(fields),
        tracks: []
      });
    }

    albums.get(albumKey).tracks.push(track);
  });

  // Convert to array, filter out albums with no real cover art, sort by track count
  return Array.from(albums.values())
    .filter(album => album.artwork && album.artwork !== '/img/placeholder.png')
    .sort((a, b) => b.tracks.length - a.tracks.length);
}

export function getGenreField(fields) {
  return window.MADHelpers.getGenreField(fields);
}
