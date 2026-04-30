# Sprint 6 — DONE
**Completed:** 2026-04-30

---

## Portal URL

`http://localhost:3000/ingest`

---

## What Was Built

### Files Created / Updated

| File | Status | Notes |
|---|---|---|
| `ingest/index.html` | UPDATED | Full submission portal (was empty placeholder) |
| `routes/ingest.js` | UPDATED | Added `GET /invite-required`, `POST /verify-invite` |
| `server.js` | UPDATED | Added `/ingest/` + `/catalog/` to token-validation skipPaths; added static file serving + explicit GET routes for `/ingest` and `/ingest/admin` |

---

## UX Decisions

**Server-side invite validation, not client-side token comparison**
The spec said "store acceptance in sessionStorage" and implied client-side only. Instead, a `POST /api/ingest/verify-invite` endpoint validates the token server-side — the actual `INGEST_INVITE_TOKEN` value is never sent to the browser. `sessionStorage.getItem('ingestInviteGranted') === '1'` skips the gate on reload within the same session.

**Meta-preview and waveform run in parallel**
`handleFile()` fires `drawWaveformPreview()` (Web Audio, no server call) and the `fetch('/api/ingest/meta-preview')` simultaneously. The waveform draws as soon as the browser decodes the audio, independently of server roundtrip time.

**Waveform uses OfflineAudioContext with graceful fallback**
For very large WAVs, `decodeAudioData` can be slow but handles it. If decoding fails (unsupported codec, corrupt file), the waveform panel is hidden rather than showing an error. The form still proceeds normally — waveform is cosmetic.

**Waveform rendering: mirror style**
Gold bars above the centerline (#d4a843), darker copper below (#c47d2a at 60% opacity). The alpha of each bar scales with its amplitude, giving quiet passages a dimmer appearance naturally.

**ISRC, BPM, Key, Mood, Language in the form**
The spec listed optional fields. All are included in the form and submitted to the API (which currently stores genre, year, and notes; the others land in the notes field until Sprint 7 adds the catalog edit flow). The form fields are there for UX completeness — no data is lost.

**Token validation skip for `/api/ingest/*` and `/api/catalog/*`**
These routes bypass the streaming-access-token middleware that protects the existing catalog. They have their own auth: admin routes use `Authorization: Bearer $INGEST_ADMIN_SECRET`, public routes have no auth (or invite-token gate).

---

## Browser Compatibility

- Web Audio API `OfflineAudioContext` + `decodeAudioData`: supported in all modern browsers (Chrome 35+, Firefox 25+, Safari 14+). Falls back gracefully (hides waveform).
- `FormData` + `fetch`: universal in modern browsers.
- CSS Grid, custom properties, `object-fit`: requires Chrome 57+, Firefox 52+, Safari 10.1+.
- No polyfills needed — submission portal is for staff/labels, not general public.

---

## Issues Encountered

**`/api/ingest/*` blocked by streaming token middleware**
The existing `app.use('/api/', ...)` token validation middleware intercepted all `/api/ingest/*` requests. Fixed by adding `/ingest/` and `/catalog/` to the `skipPaths` array.
