# Sprint 7 — DONE
**Completed:** 2026-04-30

---

## Admin URL

`http://localhost:3000/ingest/admin`

---

## What Was Built

### Files Created / Updated

| File | Status | Notes |
|---|---|---|
| `ingest/admin.html` | CREATED | Full three-tab admin dashboard |
| `routes/ingest.js` | UPDATED | Added `GET /submissions/:id/audio-preview` |
| `routes/ingest-catalog.js` | UPDATED | Added `GET /tracks`, `GET /tracks/:id`, `PATCH /tracks/:id`, `GET /import/fm/preview`, `POST /import/fm` |

---

## UX Decisions

**Polling interval: 5 seconds**
The submissions tab polls `GET /api/ingest/submissions` every 5 seconds when the tab is active. This is adequate for a low-volume admin workflow — new submissions arrive infrequently and 5s lag is acceptable. Polling stops when the tab is hidden (visibilitychange) to avoid unnecessary requests.

**Audio player uses `?token=` query param**
`<audio src="...">` elements cannot send custom `Authorization` headers. The audio-preview route accepts the admin token as either a `Bearer` header or `?token=` query param. The token is assembled client-side from `localStorage` and appended to the URL at play time, not embedded in the HTML at render time.

**Inline edit panel instead of modal**
The spec described an edit flow without specifying a modal vs. inline. A slide-in panel anchored to the right was used instead of a modal to keep the track list visible while editing. Saves via `PATCH /api/catalog/tracks/:id`.

**Toast notifications instead of alert()**
All API feedback (approve, reject, save, import) uses a non-blocking toast that auto-dismisses after 3 seconds. No native `alert()` or `confirm()` dialogs.

**Import tab preserves last-run stats in localStorage**
After a full FM import, the stats (created, updated, error count, timestamp) are written to `localStorage.ingestLastImport` and displayed on next load. This gives admins a quick reference without re-running.

**FM Import preview is first-50 only**
The preview endpoint intentionally samples only the first 50 FM records (matches `fetchAllTracks(50, 1)` in the route). The UI labels this clearly: "Preview — first 50 records only". The full import runs via `POST /import/fm` which pages through all records.

**Approve button disabled for non-standard formats without override**
If `format_flag` is set on a submission, the approve button is replaced with a format-override form requiring the reviewer to enter a written justification. This mirrors the API-level guard (`format_override_reason` required).

---

## Polling

- **Interval:** 5 seconds
- **Adequacy:** Yes for this use case. Submissions volume is low (label/staff uploads, not public). A 5s lag means a new submission appears within one polling cycle. If volume scales significantly, replace with a WebSocket or SSE push.
- **Tab visibility guard:** Polling is paused when `document.hidden` is true to avoid keeping a background tab active indefinitely.
