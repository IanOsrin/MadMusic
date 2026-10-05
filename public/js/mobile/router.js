// Browser Back/Forward history for the mobile app — the twin of app.html's MADRouter.
//
// Every tab switch and every drill-down track-list modal records a browser history
// entry, so Back/Forward stay INSIDE the app and step through visited destinations
// instead of leaving to the previous site on the first Back.
//
//   history.state = { mad:true, seq, kind:'root'|'view'|'overlay', view,
//                     overlay?:{ type, id } }
//
// Overlay entries store a STABLE id only — never display data or expiring FM
// streaming URLs (CLAUDE.md invariant #2). Forward-reopening a closed drill-down
// DEGRADES to the base tab; we never restore stale track data (tracks re-resolve by
// recordId at play time).
//
// Seed = a 'root' floor entry + the live 'view' entry. First Back from home lands on
// the floor (re-assert home, stay in app); a second Back leaves — "stay on home once,
// then exit".

import { state, elements } from './state.js?v=42';
import { switchTab } from './nav.js?v=42';

const HOME = 'newreleases';
let _seq = 0;
let _restoring = false;

// Read by nav.js's switchTab so a popstate-driven restore doesn't re-push history.
export function isRestoring() { return _restoring; }

export function initRouter() {
  const v = state.currentTab || HOME;
  try {
    history.replaceState({ mad: true, seq: 0, kind: 'root', view: v }, '');
    history.pushState({ mad: true, seq: 1, kind: 'view', view: v }, '');
    _seq = 1;
  } catch { /* history API unavailable */ }
  window.addEventListener('popstate', _onPop);
}

// Record a tab switch. No-op while restoring (see nav.js guard).
export function pushTab(tab) {
  if (_restoring) return;
  try { history.pushState({ mad: true, seq: ++_seq, kind: 'view', view: tab }, ''); } catch { /* history API unavailable */ }
}

// Record a drill-down modal so Back closes it. Stores only {type,id}.
export function pushOverlay(type, id) {
  if (_restoring) return;
  try {
    history.pushState({ mad: true, seq: ++_seq, kind: 'overlay',
                        view: state.currentTab, overlay: { type: type, id: id || '' } }, '');
  } catch { /* history API unavailable */ }
}

// Swap the CURRENT overlay entry for another (one sheet opened from inside another — an album
// from "You might also like", an artist page from an album header, an album from Now Playing):
// still one Back to close, and no dead entry left behind.
export function replaceOverlay(type, id) {
  if (_restoring) return;
  try {
    history.replaceState({ mad: true, seq: _seq, kind: 'overlay',
                           view: state.currentTab, overlay: { type: type, id: id || '' } }, '');
  } catch { /* history API unavailable */ }
}

// Close the TOP modal WITHOUT touching history (popstate already moved us). Now Playing sits
// above an album/playlist sheet, so Back closes it first and a second Back closes the sheet —
// each has its own history entry (client, 2026-09-29: Back must return to the previous screen).
function _closeAnyModal() {
  // "Add to Playlist" opened on top of Now Playing: Back closes only that sheet. It never had a
  // history entry of its own, so this Back used up Now Playing's — put one back for it.
  if (elements.modalOverlay && elements.modalOverlay.classList.contains('over-player')
      && elements.modalOverlay.classList.contains('show')) {
    elements.modalOverlay.classList.remove('show', 'over-player');
    pushOverlay('player');
    return true;
  }
  if (elements.playerModal && elements.playerModal.classList.contains('show')) {
    if (state.playerModal) state.playerModal.visible = false;
    elements.playerModal.classList.remove('show');
    return;
  }
  if (elements.modalOverlay) elements.modalOverlay.classList.remove('show');
}

function _onPop(e) {
  const st = e.state;
  if (!st || !st.mad) return;          // foreign entry — not ours
  if (_closeAnyModal()) return;         // hardware Back closes an open modal first
  const target = st.kind === 'root' ? (st.view || HOME) : st.view;
  if (target && target !== state.currentTab) {
    _restoring = true;
    try { switchTab(target); } finally { _restoring = false; }
  }
}
