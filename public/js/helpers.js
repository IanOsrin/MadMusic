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
  const audioFields = ['S3_URL', 'mp3', 'MP3', 'Audio File', 'Audio::mp3'];
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
  const artistFields = ['Album Artist', 'Artist', 'Artist Name'];
  return getFieldValue(fields, artistFields) || 'Unknown Artist';
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
      const genreFields = ['Local Genre', 'Tape Files::Local Genre', 'Genre'];
      return getFieldValue(fields, genreFields) || '';
    }

    function groupByAlbum(items) {
      const albumMap = new Map();

      items.forEach(item => {
        const fields = item.fields || {};
        const album = getAlbumField(fields);
        const artist = getArtistField(fields);
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
      const audioFields = ['S3_URL', 'mp3', 'MP3', 'Audio File', 'Audio::mp3'];
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
window.MADHelpers.getAlbumField = getAlbumField;
window.MADHelpers.formatDuration = formatDuration;
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
