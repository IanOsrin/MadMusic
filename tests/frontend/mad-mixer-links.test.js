// public/js/mad-mixer-links.js — where the 🎚 Mad Mixer buttons and the left-menu item point.
// Runs the real file in a vm sandbox with a tiny fake DOM (no jsdom in this repo):
//   · MIXER_URL set (window.__MAD_MIXER_URL) → plain links to MIXER_URL/?song=<MADMixer id>, the
//     menu item to MIXER_URL/ in a new tab — and still ONLY on tracks in the /mixable map;
//   · MIXER_URL unset → exactly as before: /mixer?song=<id>, menu item /mixer in the same tab;
//   · Mad Mixer off, or a guest → nothing.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = readFileSync(join(root, 'public', 'js', 'mad-mixer-links.js'), 'utf8');

function el(tagName, attrs = {}) {
  const a = { ...attrs };
  return {
    tagName, style: { display: 'none' }, href: tagName === 'A' ? (a.href || '') : undefined, target: '', rel: '',
    getAttribute: (k) => (k in a ? a[k] : null),
    setAttribute: (k, v) => { a[k] = String(v); },
    hasAttribute: (k) => k in a,
    closest(sel) { return sel === 'button[data-mix-song]' && tagName === 'BUTTON' && 'data-mix-song' in a ? this : null; },
  };
}

async function run({ mixer = true, mixerUrl = false, token = 'MASS-TST-001', map = { 11: '282' } } = {}) {
  const nav = el('A', { href: '/mixer' });
  nav.href = '/mixer';
  const rows = [el('A', { 'data-mix-rec': '11' }), el('BUTTON', { 'data-mix-rec': '11' }), el('A', { 'data-mix-rec': '12' })];
  const listeners = {};
  const opened = [];
  const fetched = [];
  const document = {
    readyState: 'complete',
    documentElement: {},
    getElementById: (id) => (id === 'navMadMixer' ? nav : null),
    querySelectorAll: () => rows.filter((r) => !r.hasAttribute('data-mix-done')),
    addEventListener: (type, fn) => { listeners[type] = fn; },
  };
  const window = {
    __MAD_MIXER: mixer, __MAD_MIXER_URL: mixerUrl, massAccessReady: true,
    open: (...a) => opened.push(a),
    addEventListener: () => {},
  };
  const ctx = vm.createContext({
    window, document, console,
    localStorage: { getItem: () => token },
    MutationObserver: class { observe() {} },
    setTimeout: () => 0, clearTimeout: () => {},
    fetch: async (url) => { fetched.push(url); return { json: async () => ({ ok: true, ready: true, tracks: map }) }; },
  });
  vm.runInContext(SRC, ctx);
  await new Promise((r) => setImmediate(r));
  const clickButton = () => listeners.click?.({ target: rows[1], stopPropagation() {} });
  return { nav, rows, opened, fetched, clickButton };
}

describe('mad-mixer-links.js', () => {
  it('MIXER_URL set: the 🎚 links and the menu item go to Mad Mixer’s own home', async () => {
    const { nav, rows, opened, clickButton } = await run({ mixerUrl: 'https://mixer.test' });
    expect(nav.style.display).toBe('');
    expect(nav.href).toBe('https://mixer.test/');
    expect(nav.target).toBe('_blank');
    expect(nav.rel).toBe('noopener');
    expect(rows[0].style.display).toBe('');
    expect(rows[0].href).toBe('https://mixer.test/?song=282');
    clickButton();
    expect(opened).toEqual([['https://mixer.test/?song=282', '_blank', 'noopener']]);
  });

  it('only tracks in the MADMixer map get a button (ISRC + title matched on the server)', async () => {
    const { rows } = await run({ mixerUrl: 'https://mixer.test' });
    expect(rows[2].style.display).toBe('none');
    expect(rows[2].href).toBe('');
    expect(rows[1].style.display).toBe('');
  });

  it('MIXER_URL unset: exactly as before — /mixer inside MAD, same tab for the menu item', async () => {
    const { nav, rows, opened, clickButton } = await run({ mixerUrl: false });
    expect(nav.href).toBe('/mixer');
    expect(nav.target).toBe('');
    expect(rows[0].href).toBe('/mixer?song=282');
    clickButton();
    expect(opened[0][0]).toBe('/mixer?song=282');
  });

  it('ignores a malformed address (falls back to /mixer)', async () => {
    const { nav, rows } = await run({ mixerUrl: 'javascript:alert(1)' });
    expect(nav.href).toBe('/mixer');
    expect(rows[0].href).toBe('/mixer?song=282');
  });

  it('does nothing when Mad Mixer is off; a guest gets the menu item but no buttons', async () => {
    const off = await run({ mixer: false, mixerUrl: 'https://mixer.test' });
    expect(off.nav.style.display).toBe('none');
    expect(off.fetched).toEqual([]);
    const guest = await run({ token: '', mixerUrl: 'https://mixer.test' });
    expect(guest.fetched).toEqual([]);
    expect(guest.nav.style.display).toBe('');
    expect(guest.rows.every((r) => r.style.display === 'none')).toBe(true);
  });
});
