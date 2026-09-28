/* Help panel (desktop) — the left-menu "Help" item opens #modalHelp, a short guide to the
 * site plus a "Contact us" form. The panel lives inside #accountModalBackdrop, so the existing
 * backdrop/× handlers close it. Messages go to POST /api/contact (routes/contact.js), which
 * emails the support inbox with Ian as a silent BCC — the same route the phone site uses.
 */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);

  function openHelp() {
    const backdrop = $('accountModalBackdrop'), modal = $('modalHelp');
    if (!backdrop || !modal) return;
    document.querySelectorAll('.account-modal').forEach((m) => { m.hidden = true; });
    modal.hidden = false;
    backdrop.style.display = 'flex';
    const form = $('helpContactForm');
    if (form && !form.email.value) {
      try { form.email.value = localStorage.getItem('mass_token_email') || ''; } catch (_) {}
    }
  }
  window.openHelp = openHelp;

  function wire() {
    $('navHelp')?.addEventListener('click', openHelp);
    const form = $('helpContactForm');
    if (!form) return;
    const status = $('helpContactStatus');
    const say = (msg, ok) => { status.textContent = msg; status.className = 'help-contact-status' + (ok ? ' ok' : ''); status.hidden = false; };
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = form.email.value.trim(), message = form.message.value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { say('Please enter a valid email address so we can reply.'); form.email.focus(); return; }
      if (message.length < 3) { say('Please tell us what’s wrong.'); form.message.focus(); return; }
      const btn = form.querySelector('button[type="submit"]');
      btn.disabled = true; btn.textContent = 'Sending…'; status.hidden = true;
      try {
        const r = await fetch('/api/contact', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, message, website: form.website.value, page: location.pathname + ' (desktop Help)' }),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || !d.ok) throw new Error(d.error || 'We couldn’t send your message. Please try again.');
        form.message.value = '';
        say(`Thanks — your message is on its way. We’ll reply to ${email}.`, true);
      } catch (err) {
        say(err.message);
      } finally {
        btn.disabled = false; btn.textContent = 'Send message';
      }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();
})();
