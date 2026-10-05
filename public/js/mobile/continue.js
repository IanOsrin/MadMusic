// "Pick up where you left off" — the resume row at the top of Home (MAD Streamer design, step 2,
// 2026-09-28). Kept on this device only (localStorage): the last tracks played, newest first,
// with how far into each one the listener got. Hidden until something has been played.
//
// The design's rule applies: nothing invented. A row shows the track's own title and artist and a
// progress bar — never a "time left" guess (per-track position and duration are real here, but the
// bar is what the design specifies). Guests hear 30-second previews, so they always start at 0.
import { elements, state } from './state.js?v=40';
import { getArtworkUrl, getTitleField, getArtistField, escapeHtml } from './fields.js?v=40';
import { playTrack } from './player.js?v=40';
import { openAlbumForTrack } from './cards.js?v=40';

const KEY = 'mad_continue_v1';
const MAX = 12;
// Only what a row and a replay need — not the whole FileMaker record.
const KEEP = ['Track Name', 'Track Artist', 'Album Title', 'Album Artist', 'Artwork_S3_URL', 'Tape Files::Artwork_S3_URL',
  'S3_URL', 'Duration', 'Album Catalogue Number', 'Sequence Number', 'Tape Files::Album Title', 'Tape Files::Album Artist'];

function load() {
  try { const v = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(v) ? v : []; } catch (_) { return []; }
}
function save(list) {
  try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX))); } catch (_) { /* storage full or blocked */ }
}

function remember(track) {
  if (!track || !track.recordId) return;
  const f = track.fields || {};
  const fields = {};
  for (const k of KEEP) if (f[k] != null && f[k] !== '') fields[k] = f[k];
  const list = load().filter((x) => String(x.recordId) !== String(track.recordId));
  const prev = load().find((x) => String(x.recordId) === String(track.recordId));
  list.unshift({ recordId: String(track.recordId), fields, pos: prev?.pos || 0, dur: prev?.dur || 0, at: Date.now() });
  save(list);
  render();
}

// Position, saved every few seconds while playing (and on pause).
let lastSave = 0;
function savePosition(force) {
  const t = state.currentTrack;
  const a = elements.audio;
  if (!t || !t.recordId || !a || !Number.isFinite(a.duration) || window.__GUEST) return;
  if (!force && Date.now() - lastSave < 5000) return;
  lastSave = Date.now();
  const list = load();
  const row = list.find((x) => String(x.recordId) === String(t.recordId));
  if (!row) return;
  row.pos = Math.floor(a.currentTime);
  row.dur = Math.floor(a.duration);
  save(list);
}

function resumeAt(row) {
  // Only when it's worth it: past the first 10 s and not in the last 15 s.
  if (window.__GUEST || !(row.pos > 10) || !(row.dur > 0) || row.pos > row.dur - 15) return;
  const a = elements.audio;
  const seek = () => { try { a.currentTime = row.pos; } catch (_) { /* not seekable yet */ } };
  if (a.readyState >= 1) seek(); else a.addEventListener('loadedmetadata', seek, { once: true });
}

export function render() {
  const wrap = document.getElementById('home-continue');
  const rail = document.getElementById('home-continue-rail');
  if (!wrap || !rail) return;
  const list = load();
  wrap.hidden = !list.length;
  if (!list.length) return;
  rail.innerHTML = list.map((x, i) => {
    const pct = x.dur > 0 ? Math.min(100, Math.round((x.pos / x.dur) * 100)) : 0;
    return `<button type="button" class="cont-card" data-i="${i}">
        <img class="cont-art" src="${escapeHtml(getArtworkUrl(x.fields))}" alt="" loading="lazy" onerror="this.onerror=null;this.src='/img/placeholder.png'">
        <span class="cont-text">
          <span class="cont-title">${escapeHtml(getTitleField(x.fields) || 'Track')}</span>
          <span class="cont-meta">${escapeHtml(getArtistField(x.fields) || '')}</span>
        </span>
        <span class="cont-play" aria-hidden="true"><svg width="10" height="11" viewBox="0 0 13 14" fill="currentColor"><path d="M2 1.6 12 7 2 12.4z"/></svg></span>
        <span class="cont-bar" style="width:${pct}%"></span>
      </button>`;
  }).join('');
}

export function initContinue() {
  const rail = document.getElementById('home-continue-rail');
  if (rail && !rail.dataset.wired) {
    rail.dataset.wired = '1';
    rail.addEventListener('click', (e) => {
      const card = e.target.closest('.cont-card');
      if (!card) return;
      const row = load()[Number(card.dataset.i)];
      if (!row) return;
      const track = { recordId: row.recordId, fields: { ...row.fields } };
      // The cover opens the song's album; the rest of the card resumes the song.
      if (e.target.closest('.cont-art')) { openAlbumForTrack(track); return; }
      state.playlistContext = { tracks: [track], currentIndex: 0, name: 'Pick up where you left off', playFn: playTrack };
      playTrack(track);
      resumeAt(row);
    });
  }
  // player.js announces every play; the audio element reports progress.
  window.addEventListener('mad:played', (e) => remember(e.detail && e.detail.track));
  if (elements.audio) {
    elements.audio.addEventListener('timeupdate', () => savePosition(false));
    elements.audio.addEventListener('pause', () => savePosition(true));
  }
  render();
}
