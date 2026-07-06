// Server-side metadata for social share landing pages.
//
// Social crawlers (facebookexternalhit, WhatsApp, Twitterbot, iMessage…) do
// NOT execute JavaScript — a shared link unfurls from server-rendered Open
// Graph tags or not at all. server.js injects the tags built here into the
// app HTML when a share URL (/?t=<recordId> or /?share=<playlistShareId>) is
// requested, and also injects window.__SHARE_TRACK so the app can deep-link
// straight to the shared content without re-fetching what we already read.
import { fmGetRecordById } from '../fm-client.js';
import { trackRecordCache } from '../cache.js';
import { FM_LAYOUT, ARTWORK_FIELD_CANDIDATES, CATALOGUE_FIELD_CANDIDATES } from './fm-fields.js';

const TITLE_FIELDS        = ['Track Name', 'Tape Files::Track Name'];
const TRACK_ARTIST_FIELDS = ['Track Artist', 'Tape Files::Track Artist'];
const ALBUM_FIELDS        = ['Album Title', 'Tape Files::Album Title'];
const ALBUM_ARTIST_FIELDS = ['Album Artist', 'Tape Files::Album Artist'];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function firstField(fieldData, candidates) {
  for (const name of candidates) {
    const raw = fieldData?.[name];
    if (raw === undefined || raw === null) continue;
    const str = String(raw).trim();
    if (str) return str;
  }
  return '';
}

/**
 * Track metadata for a share page, by recordId. Reads through the same
 * trackRecordCache the play path warms (no new FM read path — a shared track
 * is usually hot from the sharer having just played it). Returns null when
 * the record can't be resolved.
 */
export async function getTrackShareMeta(recordId) {
  const rid = String(recordId || '').trim();
  if (!/^\d+$/.test(rid)) return null;

  const cacheKey = `${FM_LAYOUT}::${rid}`;
  let record = trackRecordCache.get(cacheKey);
  if (!record) {
    record = await fmGetRecordById(FM_LAYOUT, rid);
    if (record) trackRecordCache.set(cacheKey, record);
  }
  if (!record) return null;

  const f = record.fieldData || {};
  const title = firstField(f, TITLE_FIELDS);
  if (!title) return null;

  // og:image must be a stable public absolute URL. S3 artwork qualifies; an
  // FM container URL expires within the session and would unfurl as broken.
  const artRaw = firstField(f, ARTWORK_FIELD_CANDIDATES);
  const artworkUrl = /^https?:\/\//i.test(artRaw) ? artRaw : '';

  return {
    recordId: rid,
    title,
    artist: firstField(f, TRACK_ARTIST_FIELDS),
    album: firstField(f, ALBUM_FIELDS),
    albumArtist: firstField(f, ALBUM_ARTIST_FIELDS) || firstField(f, TRACK_ARTIST_FIELDS),
    catalogue: firstField(f, CATALOGUE_FIELD_CANDIDATES),
    artworkUrl
  };
}

/**
 * Render the OG/Twitter meta block for a share page. All values escaped.
 * `audio` (the public 30 s preview URL) renders og:audio so platforms that
 * support inline audio players can offer one.
 */
export function buildOgTags({ type, url, title, description, image, audio }) {
  const lines = [
    `<meta property="og:site_name" content="MAD Music — Music Africa Direct">`,
    `<meta property="og:type" content="${esc(type || 'website')}">`,
    url && `<meta property="og:url" content="${esc(url)}">`,
    `<meta property="og:title" content="${esc(title)}">`,
    description && `<meta property="og:description" content="${esc(description)}">`,
    image && `<meta property="og:image" content="${esc(image)}">`,
    image && `<meta property="og:image:width" content="800">`,
    image && `<meta property="og:image:height" content="800">`,
    audio && `<meta property="og:audio" content="${esc(audio)}">`,
    audio && `<meta property="og:audio:type" content="audio/mpeg">`,
    `<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">`,
    `<meta name="twitter:title" content="${esc(title)}">`,
    description && `<meta name="twitter:description" content="${esc(description)}">`,
    image && `<meta name="twitter:image" content="${esc(image)}">`
  ];
  return lines.filter(Boolean).join('\n');
}

/** JSON payload safe to inline into a <script> tag (blocks </script> escape). */
export function inlineJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}
