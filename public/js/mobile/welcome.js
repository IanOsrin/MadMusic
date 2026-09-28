// Three-slide welcome — MAD Streamer design, step 6 (2026-09-28). Shown once, to a first-time
// visitor with no access code, before anything else. "Skip" sits on every slide (Ian); the last
// slide's button reads "Discover Now" and opens Discover.
//
// Copy is the design's, which is the live site's (LIVE-SITE-FACTS). The price card on slide 3
// is filled from the site's own plan list (/api/payments/plans + /subscription-plan), so it can
// never show a stale price — and inside the store app (isNativeApp) it shows only the free trial:
// naming outside prices there breaks Google/Apple rules.
import { switchTab } from './nav.js?v=31';
import { isNativeApp } from './auth.js?v=31';

const KEY = 'mad_welcome_seen_v1';
const COVERS = [   // real MAD artwork, from the live image server
  'https://media.musicafricadirect.com/artwork/resized/playlist-mad-about-ladysmith-black-mambazo_300.webp',
  'https://media.musicafricadirect.com/artwork/resized/GMVi12020_300.webp',
  'https://media.musicafricadirect.com/artwork/resized/GMVic101289_300.webp',
];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function seen() { try { return !!localStorage.getItem(KEY); } catch (_) { return true; } }
function markSeen() { try { localStorage.setItem(KEY, String(Date.now())); } catch (_) { /* private mode */ } }

// Not for returning subscribers, and not when the visitor arrived for something specific
// (a shared track, a payment result, a link from one of our emails).
export function maybeShowWelcome() {
  let token = '';
  try { token = localStorage.getItem('mass_access_token') || ''; } catch (_) {}
  const p = new URLSearchParams(location.search);
  if (seen() || token || ['t', 'token', 'payment', 'buy', 'contact', 'code'].some((k) => p.has(k))) return;
  showWelcome();
}

const slide = ({ eyebrow, title, body, visual }) => `
  <section class="wel-slide">
    <div class="wel-glow wel-glow-a"></div><div class="wel-glow wel-glow-b"></div>
    <div class="wel-visual">${visual}</div>
    <div class="wel-text">
      <div class="wel-eyebrow">${eyebrow}</div>
      <h2 class="wel-title">${title}</h2>
      <p class="wel-body">${body}</p>
    </div>
  </section>`;

export function showWelcome() {
  document.getElementById('welcome')?.remove();
  const native = isNativeApp();
  const el = document.createElement('div');
  el.id = 'welcome';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'Welcome to MAD');
  el.innerHTML = `
    <button type="button" class="wel-skip">Skip</button>
    <div class="wel-track">
      ${slide({
        eyebrow: 'A HUNDRED YEARS, ONE VAULT',
        title: 'The vault is open.',
        body: 'A hundred years of South African music, digitised from the original master tapes. Browsing is free, always.',
        visual: `<div class="wel-covers">${COVERS.map((u, i) => `<img class="wel-cover wel-cover-${i}" src="${u}" alt="" onerror="this.style.visibility='hidden'">`).join('')}</div>`,
      })}
      ${slide({
        eyebrow: 'YOUR MAD GUIDE',
        title: 'Maddie knows the way in.',
        body: 'Your AI powered guide to the archive. Ask her for an era, an artist or a mood and she takes you straight to it.',
        visual: '<img class="wel-maddie" src="/img/maddie-guide.webp?v=2" alt="Maddie, the MAD guide">',
      })}
      ${slide({
        eyebrow: native ? 'START HERE' : 'THE OFFER',
        title: native ? 'Start with 7 days free.' : 'Start free. <span class="wel-from"></span>',
        body: 'Your access code arrives by email and works on up to 3 devices.',
        visual: `<div class="wel-offer">
            <div class="wel-offer-badge">7 DAYS FREE, NO CARD NEEDED</div>
            ${native ? '<div class="wel-offer-note">Full listening for a week. No payment details.</div>' : '<div class="wel-offer-rows"></div>'}
          </div>`,
      })}
    </div>
    <div class="wel-foot">
      <div class="wel-dots"><span class="on"></span><span></span><span></span></div>
      <button type="button" class="wel-next">Next</button>
    </div>`;
  document.body.appendChild(el);
  document.body.classList.add('welcome-open');

  const track = el.querySelector('.wel-track');
  const next = el.querySelector('.wel-next');
  const dots = [...el.querySelectorAll('.wel-dots span')];
  let idx = 0;
  const sync = () => {
    dots.forEach((d, i) => d.classList.toggle('on', i === idx));
    next.textContent = idx >= 2 ? 'Discover Now' : 'Next';
  };
  const close = (goDiscover) => {
    markSeen();
    el.classList.add('wel-out');
    document.body.classList.remove('welcome-open');
    setTimeout(() => el.remove(), 220);
    if (goDiscover) switchTab('discover', { viaDock: true });
  };
  track.addEventListener('scroll', () => {
    const i = Math.round(track.scrollLeft / track.clientWidth);
    if (i !== idx && i >= 0 && i < 3) { idx = i; sync(); }
  }, { passive: true });
  next.addEventListener('click', () => {
    if (idx >= 2) return close(true);
    idx += 1;
    track.scrollTo({ left: idx * track.clientWidth, behavior: 'smooth' });
    sync();
  });
  el.querySelector('.wel-skip').addEventListener('click', () => close(false));

  if (!native) fillPrices(el);
}

// Slide 3's price card and "Then from R…" — from the same lists the site sells from.
async function fillPrices(el) {
  const rows = el.querySelector('.wel-offer-rows');
  const from = el.querySelector('.wel-from');
  try {
    const [p, s] = await Promise.all([
      fetch('/api/payments/plans').then((r) => r.json()).catch(() => ({})),
      fetch('/api/payments/subscription-plan').then((r) => r.json()).catch(() => ({})),
    ]);
    const plans = Array.isArray(p.plans) ? p.plans : [];
    const list = plans.map((x) => ({ label: x.label, price: x.display, sub: '' }));
    if (s && s.plan && /R\s?\d/.test(s.plan.display || '')) list.push({ label: s.plan.label || 'Monthly Subscription', price: s.plan.display, sub: 'Renews automatically' });
    if (!list.length) { rows.remove(); return; }
    rows.innerHTML = list.map((x) => `<div class="wel-offer-row"><span>${esc(x.label)}${x.sub ? `<em>${esc(x.sub)}</em>` : ''}</span><b>${esc(x.price)}</b></div>`).join('');
    const cheapest = plans.filter((x) => x.amount > 0).sort((a, b) => a.amount - b.amount)[0];
    if (cheapest && from) from.textContent = `Then from ${cheapest.display}.`;
  } catch (_) {
    rows?.remove();
  }
}
