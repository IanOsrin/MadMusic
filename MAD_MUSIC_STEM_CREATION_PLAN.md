# MAD Music — Stem Creation & Walled Garden Plan

**Status:** Draft v1 — for review and iteration
**Repo:** `madmusicV2.1` (branch `main`)
**Related docs:** `MAD_MUSIC_INGEST_SPEC.md`, `CODE_REVIEW.md`, `Possible FX.docx`

---

## 1. Vision

Let any user take any track from the MAD catalogue, get its stems (vocals / drums / bass / other), mix them in a browser, save the arrangement, and share it via a MAD link — all without the stems or the final mix ever leaving the platform. Listener-first at launch; the same engine becomes a producer surface in a later phase.

**Success criteria (MVP):**
- A listener can click "Remix this" on any catalogue track, hear stems split within ~30–90 s the first time (cached thereafter), mix them, save the project, and share a link a friend can play in-browser.
- Nothing catalogue-derived leaves the app as a downloadable file.
- Per-user cost of AI inference is bounded and predictable.

---

## 2. Foundation we already have

Roughly 70% of what people would consider "the hard part" is already shipped:

- **Audio engine** — `public/audio-lab.html` (~4,600 lines, ~200 Web Audio API calls): file load, waveform, zoom, LUFS / phase / peak metering, transport (play/stop/record/jump/undo/paste/auto-trim), record-and-export to WAV/MP3 with selectable bitrate.
- **AI stem separation, two paths**:
  - Local **Demucs HTDemucs** (4-stem) server users can run on Mac/Windows.
  - Server-side **Replicate** proxy: `POST /api/audio-lab/replicate/predictions` + `GET /api/audio-lab/replicate/predictions/:id` (poll). No key on the server — the browser passes its key forward.
- **Stems UI scaffolding** — `.stems-panel`, accordion view, multi-stem `.stems-transport`, "Export Mix" button.
- **Per-user gating** — `Audio_Lab_Enabled` flag on FileMaker tokens + `POST /api/audio-lab/validate-key` unlock flow.
- **Audio delivery** — `GET /api/audio-proxy` (CORS / auth wrapper around S3 audio).
- **Streaming + auth** — Token-based access, `/api/access/*`, full event tracking (now: one record per play).
- **Ingest pipeline spec** — `MAD_MUSIC_INGEST_SPEC.md` already plans a Postgres catalogue alongside the FM archive vault.

The big things still ahead are integration, policy and packaging — not building a DAW from scratch.

---

## 3. Decisions captured

- **Audience:** Listener-first MVP. Producer tools stack on the same engine in a later phase.
- **Stem source:** AI on demand for *any* track via Replicate. Cache aggressively so we pay once per track. (Curated stems for hero tracks can be slotted in later as overrides.)
- **Export policy:** Pure walled garden. Save, replay, share by MAD link. No external download of catalogue-derived audio.

---

## 4. Architecture (target state)

```
       ┌────────────────────────────────┐
       │  app.html  (streamer UI)       │
       │   • Album/track card → Remix   │
       └──────────────┬─────────────────┘
                      │ open /audio-lab?trackId=…
                      ▼
       ┌────────────────────────────────┐
       │  audio-lab.html  (Web Audio)   │
       │   • loads stems for trackId    │
       │   • mix, save, share           │
       └──────────────┬─────────────────┘
                      │
        ┌─────────────┼─────────────────┐
        ▼             ▼                 ▼
  /api/stems/*  /api/projects/*  /api/audio-proxy
        │             │                 │
        ▼             ▼                 ▼
   Replicate       Postgres            S3
   (Demucs)       (projects,       (stems +
                  shares)           masters)
```

**New components introduced:**

- **`/api/stems/*`** — request stems for a `trackId`, poll status, return stem URLs.
- **`/api/projects/*`** — CRUD on user mix projects.
- **`/share/{projectId}`** — public read-only player URL.
- **Stem storage** in S3: `stems/{trackRecordId}/{vocals|drums|bass|other}.mp3` (plus a manifest JSON: BPM, key, duration, source model, generated-at).
- **Project storage** in Postgres (per ingest spec) or extending FileMaker — leans Postgres for join-heavy queries.

---

## 5. Phased roadmap

Indicative totals assume one focused engineer plus product/QA. Phases overlap where they don't depend on each other.

### Phase 1 — Catalogue stems on demand · **4–6 weeks**
- `POST /api/stems/request` → kicks off Replicate Demucs job for a trackId.
- `GET  /api/stems/:trackId` → returns either `{ status: 'pending', etaSec }` or `{ status: 'ready', stems: { vocals: url, drums: url, … } }`.
- Worker / background job: poll Replicate, download stems, upload to S3, write manifest, mark ready.
- Cache hit path: subsequent requests for the same track return existing stems instantly.
- Audio Lab accepts `?trackId=…`, calls the API, loads stems via `/api/audio-proxy`.
- **Deliverable:** open `/audio-lab?trackId=12345` → first time waits ~60 s, second time loads instantly.

### Phase 2 — Save/load arrangements · **3–5 weeks**
- Postgres schema:
  - `projects (id, owner_token, name, base_track_id, created_at, updated_at)`
  - `project_state (project_id, mix_json)` — JSON blob of gain/mute/solo/FX/markers per stem.
- API: `GET / POST / PUT / DELETE /api/projects[/...]`.
- Audio Lab: Save / Open project picker, autosave every N seconds.
- Re-opening a project reloads stems from `/api/stems/...` and restores the mix state.

### Phase 3 — Streamer entry point ("Remix this") · **2–3 weeks**
- New button on album/track cards in `app.html` (live alongside ♡ / +Playlist / 🔀 Shuffle).
- Click opens `/audio-lab?trackId=…` in a new tab (or in-app modal — TBD).
- Gating: existing token check + `Audio_Lab_Enabled`; if not enabled, show upgrade/unlock prompt.

### Phase 4 — Walled-garden enforcement · **2–4 weeks**
- Tag every stem loaded into the Lab with `origin: 'catalogue' | 'upload'`.
- When *any* catalogue stem is in the project, disable the Export WAV/MP3 button and the "Save to ringtone" path.
- Server-side rendered share audio carries a soft watermark (sub-audible MAD ID, or an audible tag at start — pick one).
- Audit log: `/api/stems/log/use` POSTed every time a stem is loaded into a project.

### Phase 5 — Share links · **2–3 weeks**
- `GET /share/{projectId}` → minimal player UI: artwork, title, "made on MAD by {handle}", play / pause / progress, like.
- No edit, no export. Stems streamed via the same `/api/audio-proxy`.
- Plays + likes counted for the project owner.

### Phase 6 — Cost & quality controls · **runs throughout**
- **Pre-generation:** nightly job stems the top N most-played tracks (e.g. top 200) so most "Remix this" clicks are instant.
- **LRU eviction:** stems for cold tracks aged out of S3 after X months (regenerate on next request).
- **Per-user budget:** rate-limit new Replicate jobs per token (e.g. 10/day for free, higher for paid).
- **Monitoring:** Replicate spend dashboard, alarms on anomalous job counts.

### Phase 7 — Producer surface (post-MVP) · **2–4 months when started**
- Track-level BPM + key detection (cache on the manifest).
- Tempo / pitch matching across stems from different tracks (Rubber Band or similar).
- More FX (currently see `Possible FX.docx` for the slate).
- Optional MIDI / sampler / piano-roll if going further.

---

## 6. Indicative timeline

| Workstream | Weeks |
|---|---|
| Phase 1 — Stems on demand | 4–6 |
| Phase 2 — Save / load | 3–5 *(can start late in P1)* |
| Phase 3 — Remix entry point | 2–3 *(parallel)* |
| Phase 4 — Walled garden enforcement | 2–4 *(parallel)* |
| Phase 5 — Share links | 2–3 |
| Phase 6 — Cost / caching | continuous |
| **MVP launch-ready** | **~12–16 weeks (3–4 months)** |
| Phase 7 — Producer tools | +2–4 months after |

---

## 7. Open decisions

| # | Decision | Recommendation |
|---|---|---|
| 1 | Replicate model | **Demucs HTDemucs** — matches the local quality already in use; 4-stem default, 6-stem upgrade later. |
| 2 | Project storage | **Postgres** (per ingest spec) — joins / scale are easier. Extend FM only for archival cross-refs. |
| 3 | Share URL design | Opaque short IDs, no expiry by default, optional password. Owner can delete. |
| 4 | Per-user inference cap | Start at **10 new tracks / day** free, higher on paid tier. Pre-generated tracks don't count. |
| 5 | Anti-extraction strength | Signed URLs + audible / inaudible watermark. Defer Widevine/FairPlay DRM unless a label requires it. |
| 6 | Remix entry UX | Same-tab Lab? New tab? In-app modal? Lean **same-tab** with breadcrumb back. |
| 7 | Stem quality fallback | If Demucs result fails muddiness checks, allow a "report bad split" button + manual curation override. |

---

## 8. Risks & mitigations

- **Replicate cost spiral** — mitigated by aggressive caching, pre-generation of popular tracks, per-user caps, dashboards.
- **Latency on first split** — 30–90 s is unavoidable; communicate with a clear progress UI and offer "Notify me when ready" / start with pre-generated hero tracks at launch.
- **Stem quality variance** — Demucs is strong but imperfect; report-bad-split channel + curated overrides for hero tracks.
- **Browser CPU/RAM with 4 stems + FX** — load stems at preview bitrate while editing, swap to full quality on save / share.
- **Walled-garden circumvention via system audio recording** — accept that no client-side scheme is perfect; raise the bar with watermarking + audit, and lean on the licensing model rather than DRM.
- **Licensing exposure** — even in walled-garden mode, splitting copyrighted masters is a derivative-work act. Confirm catalogue rights cover this use *before* turning on AI-on-demand for the full archive. Hero tracks first (cleared) is the safe sequencing.

---

## 9. What to do next

Three good starting points; we can sequence whichever you want first:

1. **Prove the loop, end to end.** A tiny script: pick 5 catalogue tracks → send each to Replicate Demucs → store stems in S3 → manifest → confirm the Audio Lab can load and mix them. Minimal infra change, maximum learning. Recommended first step.
2. **Scaffold the API.** Stub out `/api/stems/request` and `/api/stems/:trackId`, wire the worker, make `/audio-lab?trackId=…` actually call them (with mock data first). This is the framing the rest of the plan plugs into.
3. **Settle the licensing question.** Before AI-on-demand goes wide, confirm catalogue rights cover stem-splitting + walled-garden remix use. This unblocks scope; if it's hero-tracks-only, the plan becomes "Phase 1 with curated stems first."

Recommended order: **3 → 1 → 2.**

---

*Edit freely — this is a working document.*
