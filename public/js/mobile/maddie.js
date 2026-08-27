// Maddie for mobile — the shop assistant behind the counter.
// Same API as desktop (POST /api/maddie/chat → { reply, tracks }), rendered as
// a full-screen chat sheet. Gated on window.__MADDIE (MADDIE_ENABLED).

import { state } from './state.js?v=8';
import { escapeHtml } from './fields.js?v=8';
import { playTrack, renderPlayerQueue } from './player.js?v=8';
import { showAlbumTracksModal } from './cards.js?v=8';

// Shorter greetings than desktop — a phone screen, not a panel.
const GREETINGS = [
  'Welcome to the shop. I’m Maddie — ask me for anything: a name, a song, a mood, a year. If it’s South African and it was ever pressed, there’s a good chance it’s on these shelves.',
  'I’m Maddie — I mind the counter here. Thousands of South African recordings behind me, more every week. What are you in the mood for?',
  'Welcome in. I’m Maddie. Describe what you’re after however it comes to you — an artist, a feeling, a decade. I’ll check the shelves.'
];

const history = []; // {role, content} — text only, capped server-side too
let greeted = false;

function log() { return document.getElementById('maddie-log'); }

function addMsg(role, text) {
  const div = document.createElement('div');
  div.className = 'maddie-msg ' + role;
  div.textContent = text;
  log().appendChild(div);
  log().scrollTop = log().scrollHeight;
  return div;
}

// Maddie's picks come back as flat objects — adapt to the track shape the
// mobile player expects ({recordId, fields}). Artwork goes in Artwork_S3_URL
// (first candidate in getArtworkUrl); audio resolves at play time by recordId
// (fresh container URL for subscribers, /api/preview/ for guests).
function toMobileTrack(t) {
  return {
    recordId: t.recordId,
    fields: {
      'Track Name': t.title || '',
      'Track Artist': t.artist || '',
      'Album Artist': t.albumArtist || t.artist || '',
      'Album Title': t.album || '',
      'Original Release date': t.year || '',
      'Artwork_S3_URL': t.artworkUrl || ''
    }
  };
}

function addCard(t, answerTracks) {
  const div = document.createElement('div');
  div.className = 'maddie-card';
  div.innerHTML = `<img loading="lazy" src="${escapeHtml(t.artworkUrl || '/img/placeholder.png')}" alt=""
      onerror="this.onerror=null;this.src='/img/placeholder.png'">
    <div class="m">
      <div class="t">${escapeHtml(t.title || '')}</div>
      <div class="a">${escapeHtml(t.artist || '')}${t.year ? ' · ' + escapeHtml(String(t.year)) : ''}</div>
      ${t.album ? `<div class="al" role="link" tabindex="0" title="Open this album">${escapeHtml(t.album)} ↗</div>` : ''}
    </div>
    <button type="button" title="Play">▶</button>`;

  div.querySelector('button').addEventListener('click', () => {
    // Queue = this answer's picks, so next/prev walk Maddie's selection
    const tracks = answerTracks.map(toMobileTrack);
    const idx = answerTracks.indexOf(t);
    state.playlistContext = { tracks, currentIndex: idx >= 0 ? idx : 0, name: 'Maddie’s picks', playFn: playTrack };
    playTrack(tracks[idx >= 0 ? idx : 0]);
    renderPlayerQueue();
  });

  const albumLink = div.querySelector('.al');
  if (albumLink) {
    albumLink.addEventListener('click', async () => {
      try {
        const res = await fetch(`/api/album?${new URLSearchParams({ title: t.album, artist: t.albumArtist || t.artist })}`);
        const data = await res.json();
        if (data.ok && data.items?.length) {
          closeSheet();
          showAlbumTracksModal({
            title: t.album,
            artist: t.albumArtist || t.artist,
            artwork: t.artworkUrl || '/img/placeholder.png',
            tracks: data.items
          });
        } else {
          addMsg('err', 'Couldn’t open that album just now.');
        }
      } catch {
        addMsg('err', 'Couldn’t open that album just now.');
      }
    });
  }

  log().appendChild(div);
  log().scrollTop = log().scrollHeight;
}

// What the waiting line says, per phase the server reports.
const WAITING = {
  shelves: 'Maddie is checking the shelves…',
  web: 'Maddie is at the computer, searching the web…',
};

// Read the turn. The server streams status events when we ask for them, so the
// waiting line can change as she moves from the shelves to the web; if anything
// in between strips the stream we still get one plain JSON body, same as before.
async function readTurn(res, onPhase) {
  if (!(res.headers.get('content-type') || '').includes('text/event-stream')) {
    return res.json().catch(() => ({}));
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let payload = {};
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop();
    for (const frame of frames) {
      const event = (frame.match(/^event: (.*)$/m) || [])[1];
      const data = (frame.match(/^data: (.*)$/m) || [])[1];
      if (!data) continue;
      let parsed; try { parsed = JSON.parse(data); } catch { continue; }
      if (event === 'status') onPhase(parsed.phase);
      else if (event === 'done' || event === 'error') payload = parsed;
    }
  }
  return payload;
}

async function sendMessage(text) {
  const send = document.getElementById('maddie-send');
  const input = document.getElementById('maddie-input');
  addMsg('user', text);
  history.push({ role: 'user', content: text });
  input.value = '';
  send.disabled = true;
  const thinking = addMsg('err', WAITING.shelves);
  try {
    const res = await fetch('/api/maddie/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ messages: history })
    });
    const data = res.ok
      ? await readTurn(res, (phase) => {
          thinking.textContent = WAITING[phase] || WAITING.shelves;
          log().scrollTop = log().scrollHeight;
        })
      : await res.json().catch(() => ({}));
    thinking.remove();
    if (res.status === 401 || res.status === 403) {
      // Maddie is subscriber-only (every message costs real money, 2026-07-17)
      addMsg('maddie', 'I chat with subscribers — but your first seven days are free. Start the trial and come ring my bell again.');
      return;
    }
    if (!res.ok) {
      addMsg('err', data.error || 'Maddie stepped away for a moment — try again shortly.');
      return;
    }
    // Picks first, her words last — see the same ordering in app.html. On a
    // phone this matters more: a few cards fill the sheet, so a reply appended
    // above them starts off-screen and the auto-scroll never comes back to it.
    const tracks = data.tracks || [];
    tracks.forEach((t) => addCard(t, tracks));
    if (data.reply) {
      addMsg('maddie', data.reply);
      history.push({ role: 'assistant', content: data.reply });
    }
  } catch {
    thinking.remove();
    addMsg('err', 'Lost the connection to the counter — try again.');
  } finally {
    send.disabled = false;
    input.focus();
  }
}

function openSheet() {
  document.getElementById('maddie-sheet').classList.add('open');
  if (!greeted) {
    greeted = true;
    addMsg('maddie', GREETINGS[Math.floor(Math.random() * GREETINGS.length)]);
  }
  document.getElementById('maddie-input').focus();
}

function closeSheet() {
  document.getElementById('maddie-sheet').classList.remove('open');
}

export function initMaddie() {
  if (!window.__MADDIE) return; // flag off → bell stays hidden
  const bell = document.getElementById('maddie-bell');
  if (!bell) return;
  bell.hidden = false;
  bell.addEventListener('click', openSheet);
  document.getElementById('maddie-close').addEventListener('click', closeSheet);
  document.getElementById('maddie-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = document.getElementById('maddie-input');
    const text = input.value.trim();
    if (!text || document.getElementById('maddie-send').disabled) return;
    sendMessage(text);
  });
}
