/**
 * lib/format.js — Pure string / value formatting utilities.
 * No dependencies on other app modules.
 */

import { randomUUID, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// lib/ is one level below the project root, so public/ is ../public
export const PUBLIC_DIR = path.join(__dirname, '..', 'public');

export const PLAYLIST_IMAGE_EXTS = ['.webp', '.jpg', '.jpeg', '.png', '.gif', '.svg'];

// ── Internal regex constants ────────────────────────────────────────────────
const REGEX_WHITESPACE                  = /\s+/g;
const REGEX_CURLY_SINGLE_QUOTES         = /[\u2018\u2019]/g;
const REGEX_CURLY_DOUBLE_QUOTES         = /[\u201C\u201D]/g;
const REGEX_LEADING_NONWORD              = /^\W+/;
const REGEX_TRAILING_NONWORD             = /\W+$/;
const REGEX_SLUGIFY_NONALPHA             = /[^a-z0-9]+/g;
const REGEX_SLUGIFY_TRIM_LEADING_DASHES  = /^-+/;
const REGEX_SLUGIFY_TRIM_TRAILING_DASHES = /-+$/;
const REGEX_UUID_DASHES                 = /-/g;
export const PUBLIC_PLAYLIST_NAME_SPLIT = /[,;|\r\n]+/;

// ── Functions ───────────────────────────────────────────────────────────────

export function normalizeEmail(email) {
  if (typeof email !== 'string') return '';
  return email.trim().toLowerCase();
}

export function normTitle(str) {
  return String(str || '')
    .replaceAll(REGEX_WHITESPACE, ' ')
    .replaceAll(REGEX_CURLY_SINGLE_QUOTES, "'")
    .replaceAll(REGEX_CURLY_DOUBLE_QUOTES, '"')
    .replace(REGEX_LEADING_NONWORD, '')
    .replace(REGEX_TRAILING_NONWORD, '')
    .trim();
}

export function makeAlbumKey(catalogue, title, artist) {
  const cat = String(catalogue || '').trim();
  if (cat) return `cat:${cat.toLowerCase()}`;
  const normT = normTitle(title || '').toLowerCase();
  const normA = normTitle(artist || '').toLowerCase();
  return `title:${normT}|artist:${normA}`;
}

export const normalizeRecordId = (value) => {
  if (value === undefined || value === null) return '';
  return String(value).trim();
};

export function parsePositiveInt(value, fallback) {
  const num = Number.parseInt(value, 10);
  if (Number.isFinite(num) && num > 0) return num;
  return fallback;
}

export function parseNonNegativeInt(value, fallback) {
  const num = Number.parseInt(value, 10);
  if (Number.isFinite(num) && num >= 0) return num;
  return fallback;
}

export function normalizeSeconds(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.round(value));
  }
  const parsed = Number(value);
  if (Number.isFinite(parsed)) return Math.max(0, Math.round(parsed));
  return 0;
}

export function toCleanString(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  return String(value);
}

export function escapeHtml(unsafe) {
  if (typeof unsafe !== 'string') {
    unsafe = String(unsafe ?? '');
  }
  return unsafe
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function formatTimestampUTC(dateInput = new Date()) {
  const d = dateInput instanceof Date ? dateInput : new Date(dateInput);
  if (Number.isNaN(d.getTime())) return formatTimestampUTC(new Date());
  const pad = (num) => String(num).padStart(2, '0');
  const month   = pad(d.getUTCMonth() + 1);
  const day     = pad(d.getUTCDate());
  const year    = d.getUTCFullYear();
  const hours   = pad(d.getUTCHours());
  const minutes = pad(d.getUTCMinutes());
  const seconds = pad(d.getUTCSeconds());
  return `${month}/${day}/${year} ${hours}:${minutes}:${seconds}`;
}

export function parseFileMakerTimestamp(value) {
  if (value instanceof Date) {
    const ts = value.getTime();
    return Number.isNaN(ts) ? 0 : ts;
  }
  if (typeof value !== 'string') {
    if (value === null || value === undefined) return 0;
    return parseFileMakerTimestamp(String(value));
  }
  const trimmed = value.trim();
  if (!trimmed) return 0;
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) {
    const fallback = new Date(trimmed.replaceAll('-', '/'));
    const ts = fallback.getTime();
    return Number.isNaN(ts) ? 0 : ts;
  }
  return parsed;
}

export function splitPlaylistNames(raw) {
  if (typeof raw !== 'string') return [];
  return raw.split(PUBLIC_PLAYLIST_NAME_SPLIT).map((v) => v.trim()).filter(Boolean);
}

export const slugifyPlaylistName = (name) =>
  String(name || '')
    .trim()
    .toLowerCase()
    .replaceAll(REGEX_SLUGIFY_NONALPHA, '-')
    .replace(REGEX_SLUGIFY_TRIM_LEADING_DASHES, '')
    .replace(REGEX_SLUGIFY_TRIM_TRAILING_DASHES, '');

export const normalizeShareId = (value) => {
  if (typeof value !== 'string') return '';
  return value.trim();
};

export const generateShareId = () => {
  if (typeof randomUUID === 'function') {
    return randomUUID().replaceAll(REGEX_UUID_DASHES, '');
  }
  return randomBytes(16).toString('hex');
};
