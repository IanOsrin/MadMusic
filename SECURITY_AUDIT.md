# MadMusic — Security Audit (June 2026)

Full-codebase audit: backend routes, core/server/lib, frontend, and config/deps/secrets.
Cross-checked against the prior `CODE_REVIEW.md` (29 findings). Severity uses CVSS-style
judgment (unauthenticated + high impact = Critical).

Legend: ☐ = to fix · ✅ = fixed in this pass · 🔧 = needs your action (external/coordination)

---

## CRITICAL

- 🔧 **C1. Live secrets committed to git history.** `.env` was committed in `0c0d937`
  (Feb 2026) and is still recoverable via `git show 0c0d937:.env`, even though it's
  gitignored now. Exposed: FileMaker password, `AUTH_SECRET`, email password, Paystack key.
  The remote is a GitHub repo. **Action (yours): rotate all of those credentials now**, then
  purge history (`git filter-repo --path .env --invert-paths` or BFG) and force-push.
  Assume already-leaked → rotation is the real fix.
- ✅ **C2. Telkom webhooks unauthenticated → mint unlimited free access tokens.**
  `routes/telkom.js` `/subscription` and `/billing` had no signature/secret. Anyone could
  POST a payload and receive a live token; `billingDays` was also unclamped (multi-year
  tokens). Fixed: shared-secret verification (env-gated `TELKOM_WEBHOOK_SECRET`) + `clampDays`.
- ✅ **C3. Hardcoded `abc123` Audio Lab key.** `server.js` `process.env.AUDIO_LAB_KEY || 'abc123'`
  let anyone unlock the Audio Lab entitlement. Removed the fallback; now fails closed (503)
  when `AUDIO_LAB_KEY` is unset.

## HIGH

- ✅ **H1. Paid-download / ringtone `ref` = replayable bearer token leaked in URLs/logs.**
  Signed, time-limited tokens; ref removed from success redirects.
- ✅ **H2. Stale-cache grace kept revoked/expired tokens alive ~24h.** Grace now applies only
  to FM-unreachable, not to authoritative deny (disabled/expired/conflict).
- ✅ **H3. `/my-stats` token-in-URL IDOR.** Now requires the `X-Access-Token` header and ignores
  any query token.
- ✅ **H4. FileMaker find-operator injection.** User input interpolated into FM `_find` values
  across lib stores. Added an FM-value escaper and applied it; tightened share-id lookup.
- ✅ **H5. Stored XSS across the entire mobile app.** `public/js/mobile/*` did no output
  escaping; FileMaker metadata + user playlist names rendered into `innerHTML`. Added
  escaping to all mobile rails/cards/modals.
- ✅ **H6. DOM XSS in desktop card `onclick` handlers.** `escapeHtml` is wrong for a JS-string
  context; refactored to escaped `data-` attributes + delegated listeners.
- ✅ **H7. Reflected XSS in `audio-lab.html` `?title=` param.** NEUTRALISED by the Audio Lab
  kill-switch: `AUDIO_LAB_ENABLED` defaults to off, so the page, its static HTML, and all
  `/api/audio-lab/*` endpoints return 404 and the vulnerable param is unreachable. The
  locked file is untouched. When you revive Audio Lab (set `AUDIO_LAB_ENABLED=true`), the
  one-line escape fix in `audio-lab.html` still needs applying — unlock the file then.
- 🔧 **H8. Access token in `localStorage`** turns any XSS into token theft. Mitigated by fixing
  H5/H6; full fix (HttpOnly session cookie) is a larger follow-up.

## MEDIUM

- ✅ M1. Open redirect via `/api/container?u=` — redirect targets allowlisted.
- ✅ M2. `streamTotalMap` unbounded memory growth — bounded LRU + TTL.
- ✅ M3. `/api/access/email/start` email-bomb — per-token/per-destination throttle.
- ✅ M4. No per-user library size cap — capped.
- ✅ M5. Bulk playlist import uncapped — capped at 500.
- ✅ M6. Import-code length unvalidated before base64 decode — length cap added.
- ✅ M7. Unauthenticated Replicate proxy with server-key fallback — token required; no fallback.
- ✅ M8. Host-header injection into share/callback URLs — built from configured base only.
- ✅ M9. `publish-to-filemaker` write-IDOR into global catalogue field — admin-gated + validated.
- ✅ M10. File-lock TOCTOU (stale-lock breaking) — atomic owner-id break.
- ✅ M11. SSRF guards hostname-string-only — DNS-resolve + encoding normalisation.
- ✅ M12. `validators.url()` permitted SSRF/redirect targets — scheme/host tightened.
- ✅ M13. Email HTML built without escaping — all interpolated values escaped.
- ✅ M14. Session/email cookies missing `HttpOnly`/`Secure` — flags added.
- 🔧 M15. Dependency CVEs (path-to-regexp ReDoS, express-rate-limit IPv6 bypass, body-parser
  DoS, ip-address XSS, protobufjs) — fix is non-breaking but must be run on your machine:
  `npm audit fix` (the sandbox can't write node_modules). Then commit the updated lockfile.
- 🔧 M16. `nodemailer` SMTP-injection fix requires a major bump (breaking) — see end.
- ✅ M17. `script-src 'unsafe-inline'` documented; low-risk header hardening applied where safe.

## LOW / INFO

- ✅ L1. `trust proxy` spoofable — defaults hardened; `true` rejected in production.
- ✅ L2. FM operator filter not applied to `/search` — now applied.
- ✅ L3. Internal error detail leaked on public endpoints — sanitized in production.
- ✅ L4. Paystack payload (PII) logged in full — redacted.
- ✅ L5. Dead `mass.email` cookie + stale comment — removed.
- ✅ L6. Unreadable error log in `lib/paystack.js` — fixed.
- ✅ L7. `postMessage` handlers without origin check — origin check added.
- ✅ L8. Weak `INGEST_ADMIN_SECRET` / stale `UPLOAD_TMP_DIR` — removed from `.env`.
- ✅ L9. Token / URL query-string leakage — stripped from URL after handoff where feasible.

## Needs your action (cannot be done safely from here)

1. **Rotate the leaked secrets** (C1): FileMaker password, `AUTH_SECRET`, email password,
   Paystack keys — then purge `.env` from git history and force-push.
2. **Set new env vars** on Render: `AUDIO_LAB_KEY`, `TELKOM_WEBHOOK_SECRET`, `TRUST_PROXY=1`,
   `APP_URL` (e.g. `https://musicafricadirect.com`). Without `AUDIO_LAB_KEY`, Audio Lab returns
   503 by design; without `TELKOM_WEBHOOK_SECRET`, Telkom webhooks log a warning and (in prod)
   reject — coordinate the secret/signature with Telkom.
3. **Audio Lab is now OFF** (`AUDIO_LAB_ENABLED` unset/false) — page + APIs 404, UI hidden,
   H7 unreachable. To revive it later: set `AUDIO_LAB_ENABLED=true`, then unlock
   `public/audio-lab.html` and apply the one-line `?title=` escape fix before going live.
4. **Decide on `nodemailer@8`** (M16) — breaking major bump; test email sending after.
5. **Run `npm audit fix`** locally (M15) for the non-breaking dependency CVEs.
6. **Confirm the paid-download timestamp field** on the FM purchase layouts so the
   download-link TTL actually enforces (currently it allows if it can't find the field —
   see the TODO in `routes/download.js`). Add the real field name to the candidate list.

## Verification

All non-breaking fixes applied on disk. `npm test` → **172/172 passing**. Server boots clean
with no import/runtime errors. The frontend structural-contract baseline was regenerated
(`tests/frontend/contract.baseline.json`) to reflect the intentional XSS-hardening edits —
note it was already stale (predated the two-pane search feature). Nothing was committed.
