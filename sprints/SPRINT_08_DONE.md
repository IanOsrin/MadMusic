# Sprint 8 — DONE
**Completed:** 2026-04-30

---

## What Was Built

### Files Created / Updated

| File | Status | Notes |
|---|---|---|
| `lib/ddex.js` | UPDATED | Full implementation — ZIP parsing, ns-stripping, version detection, delegation |
| `lib/ddex-ern382.js` | CREATED | ERN 3.8.2 field extractor |
| `lib/ddex-ern41.js` | CREATED | ERN 4.1 field extractor |
| `lib/excel-ingest.js` | UPDATED | Full implementation — flexible column mapper, normalization, validation |
| `migrations/003_submissions_source.sql` | CREATED | Adds `source TEXT DEFAULT 'manual'` to submissions |
| `routes/ingest.js` | UPDATED | Added DDEX preview, DDEX import, Excel parse, Excel confirm, match_audio routes |
| `ingest/admin.html` | UPDATED | Added DDEX and Excel tabs with full UI |
| `package.json` | UPDATED | Moved `xlsx` from devDependencies to dependencies |

---

## DDEX Versions Tested

No real distributor package was available at build time. The implementation was designed against:
- DDEX ERN 3.8.2 spec (`http://ddex.net/xml/ern/382`)
- DDEX ERN 4.1 spec (`http://ddex.net/xml/ern/41`)

Both versions are detected from the `xmlns:ern` namespace attribute on the root element. The `stripNs()` function recursively removes namespace prefixes from all parsed keys, so the field access code is the same regardless of whether the sender uses `ern:ResourceList` or `ResourceList` on inner elements.

---

## DDEX Field Paths

| Field | ERN 3.8.2 Path | ERN 4.1 Difference |
|---|---|---|
| ISRC | `SoundRecordingId[].ISRC` | Same |
| Audio filename | `TechnicalDetails.File.FileName` | `TechnicalSoundRecordingDetails.File.FileName` (falls back to `TechnicalDetails`) |
| Artist name | `DisplayArtist.PartyName.FullName` | Same; `ArtistRole` may be `{ ArtistRoleType: '...' }` object rather than string |
| Rights holder | `PLine.PLineText` | `RightsController.PartyName.FullName` preferred; also `CLine.CLineText` |
| Artwork | `ResourceList.Image.TechnicalDetails.File.FileName` | `TechnicalImageDetails.File.FileName` |
| Duration | `Duration` ISO 8601 `PT3M45S` | Same |
| Territories | `DealList.ReleaseDeal.Deal.DealTerms.TerritoryCode` | Same |

Key design decision: the `_ref` field tracks the `ResourceReference` to deduplicate tracks that appear in both an Album release and individual track releases — common in packages with both a bundle and per-track releases.

---

## Excel Column Mapping

All columns from the spec are mapped. Additional aliases added beyond spec:

| Added Alias | Maps To |
|---|---|
| `Song` | `title` |
| `Edit` | `version_title` |
| `Mix` | `version_title` |
| `Ft` | `featuring` |
| `Style` | `subgenre` |
| `Tempo` | `bpm` |
| `Barcode` | `album_upc` |
| `EAN` | `album_upc` |
| `CD` | `disc_number` |
| `Date` | `year` |
| `Comments` | `notes` |
| `Sync Cleared` | `sync_licensed` |
| `Master Rights` | `rights_holder` |
| `P Line` | `rights_holder` |
| `Copyright Year` | `rights_year` |
| `Collecting Society` | `pro_name` |
| `Contact Email` | `submitter_email` |

Duration accepts `MM:SS`, `HH:MM:SS`, or raw seconds (integer/float). Track number accepts `4/12` format (takes the first number). Year accepts ISO date strings (takes first 4-digit match). Explicit and sync_licensed normalised from yes/no/true/false/1/0/e/explicit/cleared.

---

## New Routes

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/api/ingest/ddex/preview` | adminAuth | Parse only, no writes |
| POST | `/api/ingest/ddex` | adminAuth | Parse + create submissions |
| POST | `/api/ingest/excel` | adminAuth | Parse only, return rows + errors |
| POST | `/api/ingest/excel/confirm` | adminAuth | Create submissions from confirmed rows |
| POST | `/api/ingest/submissions/:id/audio` | adminAuth | Attach audio to metadata-only submission |

---

## New Admin UI

**DDEX tab** — drag-drop ZIP zone, Preview button shows track table with per-row checkboxes (deselect before importing), Import Selected runs full import and shows log.

**Excel tab** — file picker, auto-preview on selection, colour-coded validation table (red rows = missing required fields), error/warning summary, Confirm Import creates metadata-only submissions.
