# Semantic Search / RAG for MAD — proposal & architecture

*Drafted 2026-06-11. Status: **phase-1 spike built and verified, then PAUSED**
(2026-06-11) pending completion of the AI_* audio-analysis enrichment in FM —
at pause time only 59.1% of tracks had AI_Mood/AI_BPM (37,013/62,625), vs
genre 97.3% / year 95.1% / language 92.0%. Mood/energy queries are the
signature feature, so indexing waits for full coverage.*

*What exists and works: `scripts/semantic/build-index.mjs` (full-catalogue
ingest from the local FM snapshot, ~10 min for 63k tracks) and
`scripts/semantic/query.mjs` (CLI test harness; verified quality on mood /
language / era queries). **To resume:** re-upload a fresh DB copy to the M1,
run `node scripts/semantic/build-index.mjs`, spot-check with query.mjs, then
build the serving side (S3 upload, boot download, flagged route). Note for the
serving step: the full index came out at 124 MB — int8 vector quantization
(~4× smaller) is probably needed for the 512 MB Render tier.*

## 1. What we're building, in one story

A client types into search:

> *"upbeat zulu music from the early 90s for a braai playlist"*

Today's search would find nothing — it matches words against `Track Name` /
`Artist` / `Album Title`, and none of those words appear in any field. The
proposed system instead understands what the query *means* and returns, for
example, **Skipa Mchunu — "U Hlaza" (1992)**: Zulu-language (`Language Code:
zu`), Afro Folk (`Local Genre`), Happy/Energetic (`AI_Mood`), energy 92/100
(`AI_Energy`), produced by West Nkosi. With an optional Claude layer on top, the
result can come with a sentence of context: *"An early-90s Afro-fusion cut from
the Gallo vault, produced by the legendary West Nkosi."*

That combination — search that understands mood, language, era, and cultural
context, over a catalogue nobody else has — is the product. Spotify can't do
this for the Gallo archive because Spotify doesn't have this metadata.

## 2. Where the information comes from

**Almost all of it already exists in FileMaker.** This is the key point: we are
not starting a big data-entry project. A real record from `API_Album_Songs`
today:

| Field | Example value | What it gives search |
|---|---|---|
| `Track Name` / `Album Title` | U Hlaza | identity |
| `Track Artist` / `Album Artist` | Skipa Mchunu | identity |
| `Genre` + `Local Genre` | Afro Fusion / Afro Folk | dual taxonomy — international + local genre language |
| `Language Code` | `zu` (Zulu) | language queries ("zulu music", "isiXhosa") |
| `Year of Release` / `Original Release date` | 1992 | era queries ("early 90s", "70s") |
| **`AI_Mood`** | Happy / Energetic | mood queries ("upbeat", "melancholy") |
| **`AI_Energy`** | 92.2 | intensity ("chilled" vs "high-energy") |
| **`AI_BPM`** / **`AI_Key`** | 113.4 / F major | tempo/key (DJs, sync licensing!) |
| `Producer` / `Composer` | West Nkosi / Theni Mchunu | credit queries — a real differentiator for an archive |
| `Label` / `cLine` | The Gallo Record Company Vault | provenance |
| `ISRC` / `UPC` / catalogue numbers | ZAC032306708, GAL 2052 | exact-match for industry users |

The `AI_*` fields (someone already ran audio analysis over the catalogue) are
the big unlock — mood/energy/tempo are exactly what natural-language music
queries ask for, and they're already populated.

**What's missing today** (optional enrichment, not a blocker):
- Free-text context — liner notes, artist bios, cultural significance ("the
  Mahotella Queens connection"). Lives nowhere structured today. Can be added
  gradually by curators in FM, or batch-drafted by Claude from existing
  metadata and reviewed by a human.
- `Visibility: Hide` must be respected — the example record above is hidden;
  the index must only contain visible, playable tracks (same
  `recordIsVisible`/`hasValidAudio` filters the rails already use).

## 3. How it works — the 3 concepts

**Track document.** For each track we compose one paragraph of text from the
fields above. For the record shown:

> "U Hlaza — Skipa Mchunu. Album: U Hlaza (1992). Genre: Afro Fusion / Afro
> Folk. Language: Zulu. Mood: happy, energetic (energy 92/100, 113 BPM, F
> major). Produced by West Nkosi. Composed by Theni Mchunu. Label: The Gallo
> Record Company Vault."

**Embedding.** An embedding model turns that paragraph into a list of numbers
(a "vector") where *similar meanings land near each other*. "Upbeat zulu music
from the early 90s" lands near the U Hlaza vector even though they share almost
no words. This is bought, not built — one API call per track, once.

**Vector index + retrieval.** All ~catalogue vectors sit in a small file-based
index inside the Node app (sqlite-vec — same pattern as the v3.1 SQLite charts
ingest). At query time: embed the user's query (one cheap API call), find the
nearest vectors, get back `recordId`s, hydrate them through the existing
`trackRecordCache`. **FileMaker is never touched at query time** — the
architecture rule that protects the 10k-concurrent target stays intact.

"RAG" (retrieval-augmented generation) is just this retrieval plus, optionally,
a model writing something with the results (phase 3 below).

## 4. The two pipelines

**Ingest (offline, nightly or on-demand):**

```
FileMaker API_Album_Songs
  │  paged read of visible+playable records (existing fm-client)
  ▼
compose track documents (pure code, fields → paragraph)
  │  only re-embed records whose fields changed (hash check)
  ▼
embedding model — private options in §8 (FM AI Model Server or local-in-Node)
  ▼
data/semantic.db (sqlite-vec, ~25–100 MB quantized — fine on the 512 MB tier)
```

**Query (request path — no FM, no LLM in phase 1):**

```
GET /api/semantic-search?q=upbeat+zulu+early+90s+braai
  │ embed query (~$0.0001) ──┐
  ▼                          ▼
keyword search (existing)   vector search (sqlite-vec)
  └────────── merge/rank ────┘
               ▼
recordIds → trackRecordCache hydrate → SWR cache → JSON
```

Hybrid (keyword + vector) matters: exact artist/catalogue-number queries must
keep working exactly as today.

## 5. What runs where

| Concern | Lives in | Why |
|---|---|---|
| Source of truth, curation, `AI_*` enrichment | **FileMaker** | already true today |
| (optional) embedding generation | FM 2024+ script *or* the Node ingest job | FM's `Insert Embedding in Found Set` works if the server is v21+; otherwise Node calls the embedding API during ingest — same result |
| Vector index + query serving | **Node** (sqlite-vec file) | keeps FM off the request path |
| Query understanding / concierge (phases 2–3) | **Claude API** from Node | see below |
| Curator semantic find inside FM Pro | FileMaker (if v2024+) | internal tool, low concurrency — fine |

> **To confirm with fmcloud:** server version (needs FM Server 2024/v21+ for
> any FM-side AI features). If older, everything still works — Node does the
> embedding instead of FM.

## 6. Phases, cost, effort

| Phase | What the user gets | Running cost | Build effort |
|---|---|---|---|
| **1. Semantic retrieval** | mood/era/language/credit queries work | ~$5 one-time embed + ~$0.0001/query | ~2–4 days: ingest job, index, route, hybrid merge, tests |
| **2. Query understanding** | truly conversational queries — Claude parses *"something like Mahlathini but slower, in Sotho"* into filters + semantic query (structured outputs, guaranteed-parseable JSON) | ~$0.008/query on Claude Opus 4.8 ($5/$25 per MTok); ~$8/day at 1k searches; prompt caching cuts input ~90%. Haiku 4.5 is ~6× cheaper if cost ever matters | ~2–3 days |
| **3. Concierge / full RAG** | annotated playlists with cultural context, premium feature ("build me a 60s mbaqanga education playlist, explain each pick") | per-use; an Opus 4.8 playlist-with-notes ≈ $0.05–0.15 | ~1 week incl. UI |

Each phase ships independently and phase 1 alone is already a visible product
improvement.

## 7. What does NOT change

- FileMaker stays the single source of truth; the index is a derived,
  rebuildable artifact (delete `semantic.db` → re-ingest → identical).
- The SWR/no-FM-on-request-path rule is preserved — strengthened, even, since
  semantic queries never reach FM at all.
- Existing `/api/search` keeps working untouched; the new route is additive and
  feature-flagged (`SEMANTIC_SEARCH_ENABLED`, default off, same pattern as
  `EDITORIAL_HERO_ENABLED`).

## 8. Privacy-first variant (client requirement, 2026-06-11)

The client wants catalogue data kept private. Phase 1 supports this fully —
semantic search does **not** require any external AI service:

**Option A — embed in FileMaker (preferred if fmcloud enables it).**
FM Server 2025's AI Model Server runs an embedding model *locally on the FM
box*. `Insert Embedding in Found Set` computes vectors for the whole catalogue
on-server; the nightly Node job just exports them into `data/semantic.db`.
Query-time embedding calls the same FM Model Server endpoint (a single light
HTTP call — not a Data API find). Nothing ever leaves your infrastructure.
Trade-off: search gains a runtime dependency on the FM box being up, and
fmcloud must support the AI Model Server component.

**Option B — embed in Node with a local open-source model.**
The ingest job and the query path both use the same small multilingual
embedding model (e.g. multilingual-E5-small via ONNX) loaded *inside the Node
app*. Zero external calls, zero FM dependency at query time — the most private
AND most architecture-pure option. Trade-off: the model occupies ~60–120 MB of
RAM on the 512 MB Render tier, so it needs a memory check (or a one-tier bump).
Multilingual matters here: queries in/about isiZulu, Sesotho etc. must embed
well — E5-multilingual handles this.

**Option C — DECIDED 2026-06-11: local FM copy + dev-Mac embedding.**
Ian's M1 Mac mini (8 GB) hosts a FileMaker Server with a *copy* of MADStreamer
— data source only. The FM AI Model Server is deliberately **not** enabled
there (it's a heavyweight ML stack; on 8 GB alongside FM Server and the
machine's existing workload it would run in the red). Instead, the ingest
script runs on the dev Mac (M4, 16 GB): it pulls the catalogue from the mini's
Data API, runs a small quantized multilingual embedding model locally via ONNX
(~100–500 MB — far lighter than FM's model server), builds `semantic.db`, and
uploads it to S3, where the Render app downloads it at boot (the right pattern
anyway — Render disk is ephemeral across deploys). fmcloud is never touched;
no external AI service is involved at any step.

Prerequisites on the mini: FM Server's Data API enabled (Admin Console) and a
read-only account on the DB copy with the `fmrest` extended privilege.

**Constraint:** query-time embedding runs in-process on Render with the *same*
model file the ingest used, so the model is chosen for Render's memory budget
(quantized multilingual-E5-small class, ~30–60 MB) — the M4 simply uses that
same small model rather than a bigger one.

Whichever option: **the embedding model must be identical for catalogue and
queries** — that's the deciding constraint between A, B and C, not cost (all
three are free).

**Phases 2–3 and privacy:** the Claude layers send the user's query text and
retrieved catalogue metadata to the Anthropic API. Under Anthropic's commercial
terms, API inputs/outputs are not used for model training; if that's still too
much exposure for the client, phases 2–3 simply stay off — phase 1 is a
complete, shippable product on its own.

## 9. Open decisions

1. **Option C (local-server ingest) is the working plan.** The fmcloud AI
   Model Server question is now optional — only worth asking if we want
   FM-side embedding as a convenience later. External embedding APIs are off
   the table per the client's privacy requirement.
2. **Render memory check** — confirm the quantized query-embedding model
   (~30–60 MB) fits alongside the app on the 512 MB tier; if tight, one tier
   bump or a leaner model.
3. **Enrichment ambition** — ship with today's fields (good), or also draft
   free-text context for curator review (better). Note: using Claude for
   drafting sends metadata to the API — same privacy consideration as
   phases 2–3, and equally optional.
4. **Where phase 2+ lands in the UI** — upgrade the existing search box, or a
   separate "Ask MAD" surface — and whether phases 2–3 are acceptable to the
   client at all given the API data flow (§8).
