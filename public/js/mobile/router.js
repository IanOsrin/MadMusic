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

import { state, elements } from './state.js';
import { switchTab } from './nav.js';

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

// Close any open modal WITHOUT touching history (popstate already moved us).
function _closeAnyModal() {
  if (elements.modalOverlay) elements.modalOverlay.classList.remove('show');
  if (elements.playerModal) {
    if (state.playerModal) state.playerModal.visible = false;
    elements.playerModal.classList.remove('show');
  }
}

function _onPop(e) {
  const st = e.state;
  if (!st || !st.mad) return;          // foreign entry — not ours
  _closeAnyModal();                     // hardware Back closes an open modal first
  const target = st.kind === 'root' ? (st.view || HOME) : st.view;
  if (target && target !== state.currentTab) {
    _restoring = true;
    try { switchTab(target); } finally { _restoring = false; }
  }
}
