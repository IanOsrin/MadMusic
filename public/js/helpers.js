/**
 * MADMusic Shared Helper Functions
 * 
 * These functions are extracted from app.html and home.html/albums.html
 * to provide a shared interface for common operations.
 */

// Ensure window.MADHelpers exists
if (!window.MADHelpers) {
  window.MADHelpers = {};
}

/**
 * Get the first matching field value from a list of candidate field names
 * @param {Object} fields - The record fields object
 * @param {string[]} fieldNames - Ordered list of field names to try
 * @returns {*} The first matching value, or null
 */
function getFieldValue(fields, fieldNames) {
  if (!fields) return null;
  for (const name of fieldNames) {
    if (fields[name]) return fields[name];
  }
  return null;
}

/**
 * Get the artwork URL from a record's fields
 * Handles both S3 URLs and FileMaker container URLs
 * @param {Object} fields - The record fields object
 * @returns {string|null} The artwork URL or null if not found
 */
function getArtworkUrl(fields) {
  const artworkFields = ['Artwork_S3_URL', 'Tape Files::Artwork_S3_URL', 'Artwork::Picture', 'Artwork Picture', 'Picture'];
  const artwork = getFieldValue(fields, artworkFields);
  if (!artwork) return null;

  // Handle FileMaker container URLs
  if (typeof artwork === 'string') {
    if (artwork.startsWith('http')) {
      // Check if it's an S3 URL - return directly without proxying
      if (/^https?:\/\/.*\.s3[.-]/.test(artwork) || /^https?:\/\/s3[.-]/.test(artwork)) {
        return artwork;
      }
      return `/api/container?u=${encodeURIComponent(artwork)}`;
    }
    return artwork;
  }
  return null;
}

/**
 * Get the audio URL from a record's fields
 * Handles both S3 URLs and FileMaker container URLs
 * @param {Object} fields - The record fields object
 * @param {string|number} recordId - The record ID for container fallback
 * @returns {string|null} The audio URL or null if not found
 */
function getAudioUrl(fields, recordId) {
  // Canonical superset (was duplicated 3 ways): same Tape Files::* / Stream URL
  // fallbacks as hasValidAudio so a track judged playable actually resolves a URL.
  const audioFields = ['S3_URL', 'Tape Files::S3_URL', 'mp3', 'MP3', 'Tape Files::mp3', 'Tape Files::MP3', 'Audio File', 'Audio::mp3', 'Stream URL', 'Audio URL'];
  const audio = getFieldValue(fields, audioFields);
  if (!audio) return null;

  if (typeof audio === 'string' && audio.startsWith('http')) {
    // Check if it's an S3 URL - return directly without proxying
    if (/^https?:\/\/.*\.s3[.-]/.test(audio) || /^https?:\/\/s3[.-]/.test(audio)) {
      return audio;
    }
    return `/api/container?u=${encodeURIComponent(audio)}`;
  }
  return `/api/track/${recordId}/container`;
}

/**
 * Get the title from a record's fields
 * @param {Object} fields - The record fields object
 * @returns {string} The title or 'Unknown Track' as default
 */
function getTitleField(fields) {
  const titleFields = ['Track Name', 'Song Name', 'Track Title', 'Song Title', 'Title'];
  return getFieldValue(fields, titleFields) || 'Unknown Track';
}

/**
 * Get the artist from a record's fields
 * @param {Object} fields - The record fields object
 * @returns {string} The artist or 'Unknown Artist' as default
 */
function getArtistField(fields) {
  // Track-level artist for DISPLAY: prefer a track-specific artist, then generic
  // Artist, then the album artist. Matches discovery.js rail rendering.
  const artistFields = ['Track Artist', 'Artist', 'Artist Name', 'Album Artist'];
  return getFieldValue(fields, artistFields) || 'Unknown Artist';
}

// Album-level artist for GROUPING keys and album cards: prefer the album artist.
// Use this (NOT getArtistField) when collapsing tracks into albums — otherwise a
// compilation/various-artists album fragments into one card per track artist.
function getAlbumArtist(fields) {
  const albumArtistFields = ['Album Artist', 'Artist', 'Artist Name'];
  return getFieldValue(fields, albumArtistFields) || 'Unknown Artist';
}

/**
 * Get the album from a record's fields
 * @param {Object} fields - The record fields object
 * @returns {string} The album or 'Unknown Album' as default
 */
function getAlbumField(fields) {
  const albumFields = ['Album Title', 'Album', 'Album Name'];
  return getFieldValue(fields, albumFields) || 'Unknown Album';
}

/**
 * Format seconds into MM:SS format
 * @param {number} secs - The duration in seconds
 * @returns {string} The formatted duration (e.g., "3:45")
 */
function formatDuration(secs) {
  if (!secs || !isFinite(secs)) return '';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60).toString().padStart(2, '0');
  return m + ':' + s;
}

/**
 * Render a catalogue Duration value as a clean M:SS string for display.
 * The field is a FileMaker time field, so good rows arrive as "HH:MM:SS"
 * (e.g. "00:06:58") — show them as "6:58". Leftover corrupt "N:00:00" rows
 * (the data is corrected at source; these are unrecoverable stragglers) and
 * zero values render blank.
 * @param {string|number} raw
 * @returns {string}
 */
function displayDuration(raw) {
  if (raw == null || raw === '') return '';
  const s = String(raw).trim();
  if (/^\d+:00:00$/.test(s)) return '';                       // corrupt remnant / zero → blank
  const m = s.match(/^(\d+):([0-5]?\d):([0-5]?\d)$/);          // HH:MM:SS → M:SS
  if (m) return formatDuration((+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]));
  return s;                                                    // already M:SS / unknown → leave as-is
}


/**
 * Upgrade a small artwork derivative (…/artwork/resized/NAME_300.webp or _800)
 * back to the full-resolution master (…/artwork/NAME.jpg). No-op when the URL is
 * already a master or isn't an artwork derivative. Used by the High-quality
 * images preference.
 * @param {string} url
 * @returns {string}
 */
function toMasterArtwork(url) {
  if (typeof url !== 'string' || url.indexOf('/artwork/resized/') === -1) return url;
  return url.replace('/artwork/resized/', '/artwork/').replace(/_\d+\.webp(\?.*)?$/i, '.jpg$1');
}

/**
 * Utility functions for helper operations
 */

    function cleanGenreLabel(value) {
      if (typeof value !== 'string') return '';
      return value.replace(/\s+/g, ' ').trim();
    }

    function escapeHtml(unsafe) {
      if (typeof unsafe !== 'string') {
        unsafe = String(unsafe ?? '');
      }
      return unsafe
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }

    function formatRelativeTime(value) {
      if (!value) return '';
      const date = value instanceof Date ? value : new Date(value);
      if (Number.isNaN(date.getTime())) return '';
      const diffMs = Date.now() - date.getTime();
      const minutes = Math.max(0, Math.round(diffMs / 60000));
      if (minutes < 1) return 'Just now';
      if (minutes < 60) return `${minutes}m ago`;
      const hours = Math.round(minutes / 60);
      if (hours < 24) return `${hours}h ago`;
      const days = Math.round(hours / 24);
      return `${days}d ago`;
    }

    function formatTrendingMeta(metrics = {}) {
      const plays = Number(metrics.playCount) || 0;
      const playLabel = plays ? `${plays} play${plays === 1 ? '' : 's'}` : '';
      const relative = metrics.lastEventUTC ? formatRelativeTime(metrics.lastEventUTC) : '';
      return [playLabel, relative].filter(Boolean).join(' · ');
    }

    function getGenreField(fields) {
      const genreFields = ['Local Genre', 'Song Files::Local Genre'];
      return getFieldValue(fields, genreFields) || '';
    }

    function groupByAlbum(items) {
      const albumMap = new Map();

      items.forEach(item => {
        const fields = item.fields || {};
        const album = getAlbumField(fields);
        // Group by ALBUM artist, not the track artist — otherwise a compilation
        // (many track artists on one album) fragments into one card per artist.
        const artist = getAlbumArtist(fields);
        const albumKey = `${album}|||${artist}`; // Use delimiter to avoid conflicts

        if (!albumMap.has(albumKey)) {
          albumMap.set(albumKey, {
            album,
            artist,
            artwork: getArtworkUrl(fields),
            tracks: []
          });
        }

        albumMap.get(albumKey).tracks.push(item);
      });

      return Array.from(albumMap.values());
    }

    function hasValidAudio(item) {
      if (!item || !item.fields) return false;
      // Canonical superset (was duplicated 4 ways): includes the Tape Files::*
      // and Stream/Audio URL fallbacks the catalog actually uses — the shorter
      // 5-field copy could wrongly hide playable tracks.
      const audioFields = ['S3_URL', 'Tape Files::S3_URL', 'mp3', 'MP3', 'Tape Files::mp3', 'Tape Files::MP3', 'Audio File', 'Audio::mp3', 'Stream URL', 'Audio URL'];
      const audio = getFieldValue(item.fields, audioFields);

      // Check if audio field exists and is not empty
      if (!audio) return false;
      if (typeof audio === 'string' && audio.trim() === '') return false;

      return true;
    }

    function normalizeGenreLabel(value) {
      if (!value && value !== 0) return '';
      return value
        .toString()
        .toLowerCase()
        .replace(/&/g, 'and')
        .replace(/[^a-z0-9]+/g, '')
        .trim();
    }

    function shuffleArray(array) {
      const shuffled = [...array];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      return shuffled;
    }

    function toSeconds(value) {
      const numeric = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(numeric)) return 0;
      return Math.max(0, Math.round(numeric));
    }

// Export to window.MADHelpers namespace
window.MADHelpers.getFieldValue = getFieldValue;
window.MADHelpers.getArtworkUrl = getArtworkUrl;
window.MADHelpers.getAudioUrl = getAudioUrl;
window.MADHelpers.getTitleField = getTitleField;
window.MADHelpers.getArtistField = getArtistField;
window.MADHelpers.getAlbumArtist = getAlbumArtist;
window.MADHelpers.getAlbumField = getAlbumField;
window.MADHelpers.formatDuration = formatDuration;
window.MADHelpers.displayDuration = displayDuration;
window.MADHelpers.toMasterArtwork = toMasterArtwork;
window.MADHelpers.cleanGenreLabel = cleanGenreLabel;
window.MADHelpers.escapeHtml = escapeHtml;
window.MADHelpers.formatRelativeTime = formatRelativeTime;
window.MADHelpers.formatTrendingMeta = formatTrendingMeta;
window.MADHelpers.getGenreField = getGenreField;
window.MADHelpers.groupByAlbum = groupByAlbum;
window.MADHelpers.hasValidAudio = hasValidAudio;
window.MADHelpers.normalizeGenreLabel = normalizeGenreLabel;
window.MADHelpers.shuffleArray = shuffleArray;
window.MADHelpers.toSeconds = toSeconds;
