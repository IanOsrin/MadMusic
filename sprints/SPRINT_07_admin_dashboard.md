# Sprint 7 — Admin Dashboard
## Estimated session time: 2–3 hours
## Prerequisite: Sprint 6 complete. Read SPRINT_06_DONE.md first.
## Note: Sprint 3 is deferred — the streamer still reads FileMaker directly. That is fine.

---

## Context

Read before starting:
1. `MAD_MUSIC_INGEST_SPEC.md` — "Screen 2: Admin Dashboard"
2. `sprints/SPRINT_06_DONE.md`
3. `lib/admin-auth.js` — the simple bearer token auth middleware

This sprint builds `ingest/admin.html` — the internal tool for reviewing submissions,
approving/rejecting, editing catalog metadata and monitoring the pipeline.

---

## Goal

A tabbed single-page admin UI covering:
- Submissions review queue
- Catalog management (tracks)
- FM import trigger

Same visual style as the submission portal.

---

## Tasks

### 1. Auth gate

On page load, check for stored admin token:
```javascript
let adminToken = sessionStorage.getItem('admin_token')

async function checkAuth() {
  if (!adminToken) { showLoginScreen(); return }
  const res = await fetch('/api/ingest/submissions?limit=1',
    { headers: { Authorization: `Bearer ${adminToken}` } })
  if (res.status === 401) { showLoginScreen(); return }
  showDashboard()
}

function login() {
  adminToken = $('tokenInput').value.trim()
  sessionStorage.setItem('admin_token', adminToken)
  checkAuth()
}
```

### 2. Tab structure

```html
<nav class="admin-tabs">
  <button class="tab-btn active" data-tab="submissions">Submissions</button>
  <button class="tab-btn"        data-tab="catalog">Catalog</button>
  <button class="tab-btn"        data-tab="import">Import</button>
</nav>
```

### 3. Submissions Tab

List with status filter buttons (All / Received / Processing / Awaiting Review / Approved / Rejected):

```javascript
async function loadSubmissions(status = '') {
  const res  = await api(`/api/ingest/submissions?status=${status}`)
  const list = await res.json()
  renderSubmissionsTable(list)
}
```

Table columns: ID · Submitted · Artist · Title · Format · Status · Actions

Click a row → expand inline detail panel showing:
- Full metadata as editable fields
- Audio player (`<audio>` element, src = `/api/ingest/submissions/:id/audio-preview`)
- Waveform from pre-filled data (if available)
- Technical spec (sample rate, bit depth, channels, duration, loudness)
- Approve button (if status = received / awaiting_review)
- Reject button with notes textarea
- Format override textarea (shown only if `format_flag` is set)

Add an audio preview route so the admin can listen before approving:
```javascript
// GET /api/ingest/submissions/:id/audio-preview
// Streams the temp WAV file for browser playback
// Admin auth required
router.get('/submissions/:id/audio-preview', adminAuth, async (req, res) => {
  const [sub] = await query('SELECT wav_temp_path FROM submissions WHERE id = $1', [req.params.id])
  if (!sub?.wav_temp_path) return res.status(404).json({ error: 'File not found' })
  res.setHeader('Content-Type', 'audio/wav')
  createReadStream(sub.wav_temp_path).pipe(res)
})
```

Approve flow:
```javascript
async function approve(submissionId, overrideReason = null) {
  const body = overrideReason ? { format_override_reason: overrideReason } : {}
  const res  = await api(`/api/ingest/submissions/${submissionId}/approve`, 'PATCH', body)
  const data = await res.json()
  if (!res.ok) { showError(data.error); return }
  showToast('Queued for processing')
  // Poll job status every 3 seconds until done
  pollJobStatus(submissionId)
}

async function pollJobStatus(submissionId) {
  const interval = setInterval(async () => {
    const res  = await api(`/api/ingest/submissions/${submissionId}`)
    const sub  = await res.json()
    updateRowStatus(submissionId, sub.status)
    if (['approved','rejected'].includes(sub.status)) clearInterval(interval)
  }, 3000)
}
```

### 4. Catalog Tab

Paginated table of all tracks (not just live ones):
- Columns: ID · Title · Artist · Album · Status · Visibility · ISRC · Actions
- Inline edit: click any cell to edit title, artist, genre, mood, BPM, ISRC, featured
- Status/visibility dropdowns (pending / approved / live / rejected, private / public)
- Save button per row (PATCH `/api/catalog/tracks/:id`)

```javascript
async function saveTrackEdits(trackId, fields) {
  const res = await api(`/api/catalog/tracks/${trackId}`, 'PATCH', fields)
  if (res.ok) showToast('Saved')
  else showError('Save failed')
}
```

### 5. Import Tab

Simple panel:
- "Import from FileMaker" section
  - "Preview" button → GET `/api/catalog/import/fm/preview` → shows table of what will change
  - "Run Import" button → POST `/api/catalog/import/fm` → shows progress log
  - Last import: timestamp + stats (stored in localStorage)

### 6. Toast notifications

```javascript
function showToast(msg, type = 'success') {
  // Fixed-position overlay, auto-dismiss after 3s
  // Green for success, amber for warning, red for error
}
```

### 7. Serve admin page

The admin page is at `ingest/admin.html`, already served by the static middleware from Sprint 6.
No additional server changes needed.

---

## Completion Criteria

- [ ] `http://localhost:3000/ingest/admin` shows login screen
- [ ] After token entry, dashboard loads with submissions list
- [ ] Can play audio preview of a submission before approving
- [ ] Approve button triggers job and row updates to 'processing' → 'approved'
- [ ] Can edit track metadata from Catalog tab
- [ ] FM Import tab shows preview before committing

---

## On Completion

Write `sprints/SPRINT_07_DONE.md` with:
- Admin URL
- Any UX decisions deviating from spec
- Polling interval used and whether it's adequate

Then commit: `git add -A && git commit -m "Sprint 7: admin dashboard"`
