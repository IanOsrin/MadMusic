# Mad Mixer on Vercel: judgement and final design

I checked the three designs against the code: `routes/mixer.js`, `server.js`, `lib/auth.js`, `lib/token-store.js`, `lib/pg.js`, `cache.js`, `public/js/mad-mixer.js`, `public/js/mad-mixer-links.js` and `scripts/build-mad-mixer.mjs` in `/Users/ianosrin/Downloads/madmusicv2.1`, and the master at `/Users/ianosrin/Downloads/DCAudio-mixer-fixes/frontend-src/app-stems.html` (uncommitted changes, HEAD 40859b1). I made no edits.

## 1. Scores

| Design | Correctness | Simplicity / time to first test | Safety for MAD streaming | Billing / security | Owner ease | Total |
|---|---|---|---|---|---|---|
| minimal | 7: the ticket → job id flow works through a stored map. But the MVSEP key and backend stay inside MAD, which goes against the "own home" decision. It writes to MAD's Postgres, which is a read mirror (`lib/pg.js:4-6`). It keeps the WAV upload and `/audio-proxy` paths. | 9 | 6: every Mixer call, plus edited-audio uploads, still lands on the single 0.5-CPU worker (`cluster.js:4-10`). A Mixer outage or traffic spike is MAD's problem. | 5: the race is fixed by an advisory lock. Still open: a long-enough own WAV tagged with a song id gets split (`routes/mixer.js:353-361`), `add_opt` is passed through (`:367`), poll ownership is only "optional", and `/audio-proxy` stays a generic MVSEP proxy. | 9 | 36 |
| separation | 7: the flow is sound. But trial confirmation would live in two places (Redis `trialconf` and the FileMaker Notes marker, `:492-500`). MAD's buttons would depend on Vercel through a reversed catalogue feed. The catch-all `api/[...path].js` routing is unverified. | 3 | 9 | 8 | 3: Upstash, a new read-only FileMaker account and about 8 env vars | 30 |
| integrity | 8: its diagnosis of today's faults is accurate (all 9 verified, see §2a). But it plans 13 function files plus a cron job and a webhook on Hobby. It misses that the HMAC check needs the raw request body, which `express.json` (`server.js:368`) would consume first. It also refactors MAD's busiest middleware (`server.js:634-694`). | 5 | 9 | 10: one atomic SQL reserve, idempotency, a state machine and allowlists | 5: Neon, about 5 secrets, and Ian running SQL by hand | 37 |

**Winner: integrity, trimmed.**
- **Why it wins:** it matches the owner's decision (Mixer's own home, MVSEP key on Vercel, DCMax untouched) and closes the billing holes.
- **Grafted from separation:**
  - one router function, in Frankfurt (`fra1`);
  - a hand-off page on MAD, so MAD users arrive already signed in;
  - email-confirm links that land on the Mixer itself;
  - the failure matrix.
- **Grafted from minimal:**
  - Vercel must not reverse-proxy MAD (the real-IP problem at `server.js:408-412`);
  - `loadSong` waits for the song to load, so the page can tell an untouched song from edited audio;
  - the build fails if the master changes shape;
  - `#code=` fragments instead of `?code=` in email links.

## 2. Final design

### 2a. Verified facts the design depends on
- **Quota race:** the quota is read at `routes/mixer.js:335` but only counted at `:387`, after MVSEP replies. Usage lives in `data/mixer-usage.json` (`:76-77`) on a disk wiped at every deploy.
- **Codes:** `MASS-` plus 6 characters from 32 symbols, about 2^30 combinations (`lib/token-store.js:99-108`). `lib/auth.js:230` already logs **full** codes on every lookup (an existing MAD issue).
- **No session side effect:** `validateAccessToken(code)` without a sessionId registers no device. It does stamp First_Used and Expiration_Date on first use (`lib/auth.js:258-268`), the same as today's `/api/mixer/auth`.
- **Token cache is importable:** `tokenValidationCache` is exported from `cache.js` (`server.js:41`), so a new resolver can reuse it without touching the middleware.
- **Raw-body precedent:** Paystack's raw-body route is mounted before `express.json` (`server.js:363-368`).
- **What the master expects:**
  - create returns `data.hash` and a 402 shows `cj.error` (`app-stems.html:5936-5955`);
  - a 4xx poll (other than 408/429) is final;
  - `failed` and `not_found` clear the saved job (`:6024-6038`);
  - stems are fetched via `${API_BASE}/audio-proxy?url=` with auth headers (`:6086`), so the adapter must strip those headers or the direct fetch from MVSEP triggers a CORS preflight;
  - every export POSTs the whole file to `/dcx/register` (`:5197-5205`);
  - `add_opt` options come from `algorithm_fields[].options` (`:5459-5476`), so the server can allowlist them;
  - `runAiSplitMVSEP` needs `accessCode` to be truthy (`:5923`).

### 2b. Where each responsibility lives

| Responsibility | Where | Storage |
|---|---|---|
| Code → valid / plan / entitled / trial / confirmed | **MAD**, signed internal endpoint, reusing `tokenValidationCache` + `validateAccessTokenDeduped`. `entitled = audioLabEnabled \|\| isMixerPlan` (`:87`) | FileMaker `API_Access_Tokens` (unchanged) |
| Browser session | **Vercel**, HttpOnly cookie `__Host-mm`, sealed with AES-256-GCM: `{code, plan, trial, confirmed, entitled, email, claimsAt}`. Page JavaScript never holds a code. | cookie |
| Trial signup and email | **MAD** internal endpoint: existing dedupe, `createAccessToken`, MAD's SMTP | FileMaker |
| Trial confirm | Email link `MIXER_URL/#confirm=CODE.SIG` → page → Vercel → MAD internal confirm (checks the signature with `AUTH_SECRET`, stamps "[email confirmed" in Notes) | FileMaker |
| Split metering, ledger, job state, DCX registry | **Vercel + Neon Postgres** (Frankfurt) | `mm_usage`, `mm_splits`, `mm_events`, `mm_dcx` |
| Song catalogue | **MAD** internal `/songs` (existing SWR cache), cached 5 min per Vercel instance. The MVSEP URL is built on the server and must start with `https://media.musicafricadirect.com/`. | — |
| Which MAD tracks show the Mad Mixer button (`/mixable`) | **MAD**, unchanged | — |
| MVSEP create / get-remote / get, and `MVSEP_KEY` | **Vercel only** | env (Production, Sensitive) |
| Polling: ticket → real job id → stems | Browser polls Vercel with **our split id**; Vercel resolves `get-remote`, then `get`. Upstream calls are capped at one per split every 3 s. | `mm_splits` |
| Stem download | **Browser, straight from `*.mvsep.com`** (CORS `*`) | — |

**Region:** `fra1`, next to MAD on Render (Frankfurt), Neon and MVSEP. Static files are still served from the nearest edge.

### 2c. Files

**MAD repo** (`/Users/ianosrin/Downloads/madmusicv2.1`, on `main` → test site first)

| File | Purpose |
|---|---|
| NEW `lib/mixer-catalogue.js` | MADMixer FileMaker client, `songSummary`, `songsSwr` moved from `routes/mixer.js:160-213`. Exports `allSongs()` and `songsWithAudio()`. |
| NEW `lib/mixer-trial.js` | `trialSig`, `trialConfirmed`, `startTrial({email, links})`, `confirmTrial(code, sig)`, moved from `:487-563` |
| NEW `lib/mixer-bridge.js` | HKDF keys from `MIXER_SHARED_SECRET`, `verifySig` (constant-time), `sealHandoff` |
| NEW `routes/mixer-internal.js` | `createMixerInternalRouter({resolveToken})` with signature middleware, endpoints in §2d, a trial limiter keyed on the signed `ip` (5 per hour), and a backstop of 300 calls per minute |
| CHANGE `routes/mixer.js` | Import the two libs (no behaviour change). Add `POST /handoff`. The trial route builds links via `lib/mixer-trial`. |
| CHANGE `server.js` | (a) Before `:368`: `app.use('/internal/mixer', express.raw({type:'*/*', limit:'16kb'}))`. (b) Before `apiLimiter` (`:486`), and only when `MIXER_SHARED_SECRET` is set: mount the internal router with `resolveTokenForMixer(code)`. That function reads `tokenValidationCache`, calls `validateAccessTokenDeduped`, applies the 24 h stale grace and returns `source: cache\|fm\|stale\|json`. The streaming middleware is not edited. (c) When `MIXER_URL` is set: `/mixer` serves `mixer-handoff.html`, and `/api/mixer/*` is cut to `/mixable` and `/handoff` (guard before `:888`). (d) Inject `window.__MAD_MIXER_URL` (`:747`). |
| CHANGE `lib/auth.js` | Additive only: `source:'fm'` on the success return, `source:'json'` on the fallbacks |
| CHANGE `lib/email.js:443-447` | `sendMixerTrialEmail(email, code, {confirmUrl, openUrl})`. Links become `MIXER_URL/#confirm=…` and `MIXER_URL/#code=…`. |
| NEW `public/mixer-handoff.html` and `public/js/mixer-handoff.js` | Reads `mass_access_token`. If present, `POST /api/mixer/handoff` and then `location.replace(url)`; otherwise `location.replace(MIXER_URL/?song=)`. **`mad-mixer-links.js` needs no change**: its `/mixer?song=` links land here. |
| NEW `tests/integration/mixer-internal.test.js` | Signature, clock skew, raw-body ordering, entitlement shapes (Mixer-only codes, MAD-only codes give 402), trial dedupe, handoff seal vectors (the same vectors as the Vercel repo) |
| CHANGE `.env.example` | `MIXER_URL`, `MIXER_SHARED_SECRET` |

**Vercel repo** (new private repo `IanOsrin/mad-mixer`, local `/Users/ianosrin/Downloads/mad-mixer`; `git config user.email ian@digitalcupboard.net` before the first commit)

| File | Purpose |
|---|---|
| `public/index.html` | GENERATED and committed; header names the master commit; never hand-edited |
| `public/mad-mixer.js` | Adapter, Vercel edition (below) |
| `public/mad-mixer.css`, `public/img/Madmusiclogonew-dark.png` | Copied from MAD |
| `api/router.js` | The **only** function: route table, cookie session, Origin check, JSON-only POSTs, 64 KB body cap |
| `lib/crypto.js` | HKDF, seal/unseal, HMAC signing for MAD, `acct = HMAC(MIXER_DATA_KEY, CODE)` |
| `lib/db.js` | Neon client, `ensureSchema()` (CREATE IF NOT EXISTS once per instance, so Ian runs no SQL), reserve / release / idempotency SQL |
| `lib/mvsep.js` | Algorithms (cached 1 h), create-by-URL, get-remote, get, file-URL check (https, mvsep hosts) |
| `lib/mad.js` | Signed client: entitlement, songs, trial, confirm |
| `lib/session.js` | Claims refresh: older than 15 min, or older than 30 s for an unconfirmed trial |
| `lib/catalogue.js` | 5-min in-memory song cache |
| `lib/limits.js` | `mm_rate` buckets, daily caps |
| `lib/log.js` | Redacts `api_token=` and anything shaped like `MASS-…` |
| `scripts/build-page.mjs` | Port of `build-mad-mixer.mjs` (below) |
| `scripts/dev-server.mjs` | Zero-dependency local server; MVSEP key from the Keychain as at `routes/mixer.js:55-72`; `MVSEP_DRY_RUN=true` local only |
| `tests/*.test.mjs` | `node:test`: crypto vectors, MVSEP state machine with mocked fetch, response shapes against the master, a quota race test (skipped unless `DATABASE_URL` is set) |
| `vercel.json` | Settings below |
| `package.json` and lock | `"type":"module"`, one dependency `@neondatabase/serverless`, Node 22 |
| `.gitignore`, `CONTRACT.md` | `.env*`, `.vercel`; the §2d internal contract |

**`vercel.json`**
```json
{ "regions": ["fra1"],
  "rewrites": [{ "source": "/api/:path*", "destination": "/api/router" }],
  "functions": { "api/router.js": { "maxDuration": 30 } },
  "headers": [
    { "source": "/(.*)", "headers": [
      { "key": "Content-Security-Policy", "value": "default-src 'self'; script-src 'self' 'unsafe-inline' blob: https://cdnjs.cloudflare.com; worker-src 'self' blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' https: data: blob:; media-src 'self' https: blob:; connect-src 'self' blob: data: https://media.musicafricadirect.com https://mvsep.com https://*.mvsep.com; font-src 'self' https:; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'" },
      { "key": "Referrer-Policy", "value": "no-referrer" },
      { "key": "X-Content-Type-Options", "value": "nosniff" },
      { "key": "Permissions-Policy", "value": "microphone=()" } ] },
    { "source": "/api/(.*)", "headers": [{ "key": "Cache-Control", "value": "private, no-store" }] } ] }
```
The router reads the original path from `req.url`; the common Express-on-Vercel setup relies on rewrites keeping it. Check this with `/api/health` on the first deploy. If it doesn't hold, the fallback is `"/api/router?p=:path*"`.

**Build script changes** (port of `build-mad-mixer.mjs`):
- Output goes to `public/index.html`; assets are `/mad-mixer.css` and `/mad-mixer.js`.
- The logo `href` becomes `https://musicafricadirect.com/`.
- **The build refuses a dirty master** unless `--allow-dirty` is passed. Today it only notes it (`:40-41`).
- **Anchor assertions:** the build stops if any of these is missing from the master: `${API_BASE}/mvsep/create?`, `/mvsep/get?hash=`, `/audio-proxy?url=`, `/dcx/register?`, `_mvsepSaveJob(`, `let audioBuf`, `async function loadFile(`, `function _hasSplittableAudio`.

**Adapter (`public/mad-mixer.js`, Vercel edition).** The DCMax master is untouched in v1; everything Mad Mixer needs is switched on here.
- **Sign-in:**
  - set `API_BASE='/api'` and `accessCode='cookie'` (a placeholder);
  - drop the `localStorage` code keys (`:22-31`);
  - sign-in is `GET /api/session`;
  - read `#code=`, `#h=` or `#confirm=` from the URL, POST it to `/api/session`, then `history.replaceState` at once.
- **The fetch wrapper:**
  - **create** → JSON `{song: currentSong, idem}`. The same `idem` is reused for the same song, model and options while an earlier attempt is unanswered (kept in `sessionStorage` for 10 min).
  - **edited audio:** if `audioBuf !== catalogueBuf`, answer locally with a 400: "Splitting edits and stems comes later — nothing was charged."
  - **stems:** `/audio-proxy?url=X` → `X`, only for https `mvsep.com` / `*.mvsep.com`. The signal is kept; **no headers** are sent.
  - **DCX:** `/dcx/register` → JSON `{bytes: blob.size, song, split}`.
- **`loadSong`:** `await loadFile(...)` (today `handToApp` doesn't wait, `:138`), then `catalogueBuf = audioBuf`.
- **Greying out AI Split:** override `_hasSplittableAudio`, guarded with `typeof`, to also require `audioBuf === catalogueBuf`. The pill override calls `_syncAiSplitBtn()` instead of setting `disabled=false` (`:117`, `:128`).

### 2d. Endpoints

**Browser → Vercel** (same origin; POSTs need JSON plus `Origin` equal to `https://${Host}`)

| Endpoint | Request | Response |
|---|---|---|
| `GET /api/session` (also `POST /api/auth`) | cookie | 200 `{ok, plan, trial, confirmed, entitled, used, quota, remaining, splitterReady}`; 401 `{signedOut:true}`; `/auth` gives 402 when not entitled |
| `POST /api/session` | `{code}` \| `{h}` \| `{confirm:"CODE.SIG"}` | 200 as above + Set-Cookie; 401 `{error, definitive}`; 402 `{upgrade:true}` (MAD-only code, no cookie); 409 hand-off already used; 429 (10 per 15 min per IP, 300 per hour in total); 503 MAD unreachable |
| `DELETE /api/session` | — | 204, cookie cleared |
| `GET /api/usage` | cookie | `{ok, gated:true, used, quota, remaining, splitterReady, trial, confirmed}` (the shape `_renderCreditsPill` already reads) |
| `GET /api/songs` | cookie, entitled | `{ok, count, songs:[{id,title,artist,album,duration,genre,isrc,playable,hasMaster}]}` |
| `GET /api/songs/:id` | cookie, entitled | `{ok, …song, audioUrl}` / 404 |
| `GET /api/mvsep/algorithms` | cookie | The 4 MVSEP entries (`display_name`, `is_default`, `is_active:1`, `order_id`, `algorithm_fields`). A trial gets Quick only, if Ian agrees (decision 2). |
| `POST /api/mvsep/create?sep_type&add_opt1..4` | `{song, idem}` | 200 `{success:true, data:{hash:<splitId>}, used, remaining}`; 400 bad song/model/option; 401; 402 `{upgrade, error}`; 403 `{needsConfirm}`; 409 (2 splits already unfinished); 415 not JSON; 502 `{error:"…not counted"}`; 503 (daily cap, no key, plan can't be checked) |
| `GET /api/mvsep/get?hash=<splitId>` | cookie, owner of the split | Always 200 and MVSEP-shaped: `{success, status: waiting\|processing\|distributing\|merging\|done\|failed\|not_found, data:{current_order, queue_count, finished_chunks, all_chunks, message, algorithm, files:[{url,download,type}]}}`. Not the owner, or unknown → `not_found`. |
| `POST /api/dcx/register?id&sha&name&source` | `{bytes, song, split}` | `{ok,id}`; 400 (id must match `^DCX-\d{8}-[A-Z2-9]{6}$`); 429 (200 per account per day) |
| `POST /api/dcx/check` | — | 501 (as today) |
| `POST /api/trial` | `{email}` | 200 `{ok, plan:'mixer-trial', confirmed:false}` + cookie; 400; 409 already used; 429 (3 per hour per IP plus a daily trial cap); 502 email failed; 503 |
| `GET /api/health` | — | `{ok, region, db, mad, splitterReady}` (no secrets) |

**What create does, in order:**
1. Reads the cookie.
2. Gets a fresh entitlement from MAD. If MAD is unreachable, it accepts cookie claims up to 20 min old, matching MAD's own cache. If the plan can only be checked against fallback data (`source: stale` or `json`) and the claims are older, it returns 503.
3. A trial must be confirmed.
4. The song must be in the catalogue with a CDN URL, the model must be one of the 4, and the options must be in that model's `algorithm_fields`. `output_format` is forced to 1.
5. If this account already used the same `idem`, the existing split is returned.
6. It applies the in-flight guard and the daily cap.
7. It reserves the split in one statement:
   ```sql
   WITH bump AS (INSERT INTO mm_usage AS u (acct,period,used) SELECT $1,$2,1 WHERE $3::int>0
     ON CONFLICT (acct,period) DO UPDATE SET used=u.used+1 WHERE u.used<$3::int RETURNING used)
   INSERT INTO mm_splits (id,acct,period,idem_key,song_id,sep_type,add_opts,plan,state)
   SELECT $4,$1,$2,$5,$6,$7,$8,$9,'reserved' FROM bump RETURNING id;
   ```
   No row back means 402. Concurrent requests serialise on the row lock. A duplicate `(acct, idem_key)` rolls the whole statement back.
8. It calls MVSEP `create` with `url=<CDN mp3>&remote_type=direct&is_demo=0` (25 s timeout).
   - **Accepted:** state `ticketed`, ticket stored.
   - **Clear refusal:** released. A single CTE moves `reserved`/`ticketed` → `released` and decrements usage only if that row changed.
   - **Timeout or 5xx:** state `unknown`, still counted.

**What a poll does:**
- `ticketed` → `get-remote?hash=ticket`.
  - On `done`: store the real job id, state `running`.
  - On an explicit failure, or still fetching after 10 min: `failed`, and the split is released if Ian agrees (decision 3).
  - Unrecognised status values are treated as still waiting.
- `running` → `get?hash=jobId`. Fields are whitelisted. On `done`, the file URLs are checked and stored, and later polls are answered from the database.
- Every transition only moves forward and is logged to `mm_events`.

**Vercel → MAD** (`MAD_INTERNAL_URL/internal/mixer/*`, outside `/api/`)
- **Signing:** headers `X-MM-Ts` (±60 s) and `X-MM-Sig = b64url(HMAC-SHA256(HKDF(secret,'mm-sign-v1'), ts\nMETHOD\npath\nsha256(body)))`.
- **The user's code always travels in the body**, never in a URL.

| Endpoint | Body | Response |
|---|---|---|
| `POST /entitlement` | `{code}` | `{valid, definitive, source, entitled, plan, trial, confirmed, email, expiresAt}` |
| `GET /songs` | — | `{builtAt, songs:[…summary, audioUrl]}` (playable only) |
| `POST /trial` | `{email, ip}` | `{ok, code}`; 409; 429; 502 (code revoked); 503 |
| `POST /trial/confirm` | `{code, sig}` | `{ok, confirmed:true}`; 400 `{reason:'bad-link'\|'ended'}` |

**MAD, browser-facing:**
- `POST /api/mixer/handoff {song}` (normal token middleware) → `{url:"MIXER_URL/?song=ID#h=<AES-GCM{code,exp:+120s,nonce}>"}`. The nonce is burned in `mm_handoff_used`.
- `GET /mixer[?song=]` → the hand-off page.
- `GET /api/mixer/mixable` → unchanged.

### 2e. Env vars

| Where | Name | Secret? | Value |
|---|---|---|---|
| Vercel (Production only, Sensitive) | `MVSEP_KEY` | **SECRET, Ian types** | MVSEP key (decision 1) |
| Vercel (Prod + Preview, Sensitive) | `MIXER_SHARED_SECRET` | **SECRET, Ian types** | Same value as Render |
| Vercel (Prod + Preview, Sensitive) | `MIXER_DATA_KEY` | **SECRET, Ian types** | Never change it: it keys usage rows and sessions |
| Vercel | `DATABASE_URL` | SECRET, auto-injected by the Neon integration | — |
| Vercel | `MAD_INTERNAL_URL` | no | `https://madmusic.onrender.com` now; the live service's `*.onrender.com` address at launch (bypasses Cloudflare bot checks) |
| Vercel | `MIXER_SPLITS_PER_MONTH` / `MIXER_MAX_SPLITS_PER_DAY` / `MIXER_MAX_TRIALS_PER_DAY` | no | 30 / 20 while testing / 10 while testing |
| Render, test service now, live at launch | `MIXER_SHARED_SECRET` | **SECRET, Ian types** | Same as Vercel |
| Render | `MIXER_URL` | no | `https://mad-mixer.vercel.app` → `https://mixer.musicafricadirect.com` |
| Render, live at launch | `MAD_MIXER_ENABLED=true`, `MADMIXER_FM_HOST/DB` (no), `MADMIXER_FM_USER/PASS` | **USER/PASS are SECRET, Ian types**, if not already set | Do not set `MVSEP_KEY` on live. Never set `MIXER_OPEN_TO_ALL_TOKENS`. |

The secrets are generated without ever being shown: `openssl rand -base64 48 | pbcopy`.

**Vercel project settings:**
- team `music-africa-direct`, project `mad-mixer`;
- Framework "Other", Root `./`, Build Command empty, Output Directory `public`, Install `npm install`, Node 22.x;
- Production branch `main`; region comes from `vercel.json`;
- Deployment Protection Standard (previews need a Vercel login).

### 2f. Build order (Claude)
1. **MAD:** extract the catalogue and trial libs with no behaviour change; run `npm test`.
2. **MAD:** internal router, `server.js` mounts (raw body first), `resolveTokenForMixer`, the `source` field in `auth.js`; tests.
3. **MAD:** email links, `MIXER_URL` gating, the hand-off route and page; tests; push `main` (test site only).
4. **mad-mixer:** scaffold with the git identity set; `lib/crypto` with the shared test vectors.
5. **mad-mixer:** `lib/db`, `lib/mvsep` (mocked tests), `lib/mad`, `lib/session`, `api/router.js`.
6. **mad-mixer:** adapter and `build-page.mjs`. Generate `index.html` **only after the other agent's resume work is committed in DCMax**.
7. **Local end to end:** `dev-server.mjs` against local MAD with `MVSEP_DRY_RUN`, then one real Quick split (Ian's go).
8. **Push:** Ian's Vercel steps; check `/api/health`; run the test matrix:
   - sign in by code, MAD button hand-off, trial plus confirm;
   - a Quick split, with stems coming from `*.mvsep.com`;
   - close the tab and Resume;
   - 3 parallel creates on a free-split code: exactly 1 succeeds;
   - replay the same `idem`: no second charge;
   - edited audio: AI Split greyed and not charged;
   - out of splits: the 402 message;
   - `MAD_INTERNAL_URL` pointed at a dead host: running splits finish, new sign-ins get a clear error;
   - each of the 4 models once;
   - an export writes a `mm_dcx` row.
9. **Launch** (§3, steps 11-15). About 2 weeks later, clean up MAD:
   - remove the old `/api/mixer/mvsep/*`, `/audio-proxy`, `/dcx`, `/songs`, `/auth` routes;
   - remove `public/mad-mixer.html` and `scripts/build-mad-mixer.mjs`;
   - remove the compression exception and the 30-min timeout (`server.js:344-346`, `:1181-1183`) and `MVSEP_KEY`.

### 2g. Security notes
- **Codes:** never in server URLs or logs; `acct` is an HMAC with a separate key; one session cookie per host.
- **Stem links:** a stem link works as a bearer URL for about 72 h. That is accepted: they are catalogue stems.
- **Shared IPs:** all MVSEP calls now leave from Vercel's shared IPs, so polls are throttled per split.
- **Previews:** no `MVSEP_KEY`, so a preview can never spend credits.
- **Existing MAD issue:** `lib/auth.js:230` logs full codes. This design doesn't add to it, but it is worth fixing separately.

### 2h. Cost and latency per split (3-minute song)
- **MVSEP:** Quick about 2–3 credits (2 measured, 34 s); Best about 13 credits (about 5 min).
- **Vercel:** about 12 invocations for Quick, about 65 for Best, a few KB each.
- **Neon:** about 20–70 queries, on the free tier. The first query after idle takes 0.5–1 s.
- **MAD:** 1–2 small JSON calls; Render audio bytes go from about 400 MB to **0**.
- **Create:** about 1–2 s.
- **Stems:** about 160–190 MB, straight from MVSEP (roughly 70 s at 20 Mbps).
- **Wasted work in v1:** the browser still encodes a 32 MB WAV for 1–2 s until the master gets a hook (v1.1).
- **Fixed cost:** Vercel Pro, about $20 a month, before public launch.

### 2i. Failure matrix
| What is down | What happens |
|---|---|
| Vercel | MAD is unaffected. |
| MAD | Running splits and stem downloads keep working. Creates continue for up to 20 min on cookie claims; after that, a clear 503. |
| Neon | Creates and polls return 503, which the page retries and then offers Resume. Mixing still works. |
| MVSEP | Create fails with 502 and the split is not counted. |
| Master changes shape | The build stops; the live page is unaffected. |

## 3. Ian's steps (one at a time; I wait for him between steps)
1. Answer the decisions below.
2. Say yes to me creating the private GitHub repo `IanOsrin/mad-mixer` (or click New repository → Private → `mad-mixer` yourself).
3. In Terminal, run `openssl rand -base64 48 | pbcopy`. It copies a secret without showing it.
4. Render → test service (madmusic) → Environment → Add `MIXER_SHARED_SECRET` → paste → Save.
5. Vercel → Add New → Project → Import `mad-mixer` → Framework "Other" → Build Command blank → Output Directory `public` → Deploy.
6. Vercel project → Storage → Create Database → Neon → region Frankfurt → Free → Connect to `mad-mixer` (all environments).
7. Vercel → Settings → Environment Variables → `MIXER_SHARED_SECRET` (paste the same value as step 4; Production + Preview; Sensitive).
8. Run `openssl rand -base64 48 | pbcopy` again → add `MIXER_DATA_KEY` (Production + Preview; Sensitive).
9. Run `security find-generic-password -s mvsep -w | pbcopy` (or copy the new account's key from the MVSEP site) → add `MVSEP_KEY` (**Production only**; Sensitive).
10. Tell me. I add the non-secret variables, redeploy, and give you the address. Then add `MIXER_URL` = that address on the Render test service.
11. Test with me (one real Quick split, about 2 credits).
12. **Launch:** upgrade the Vercel team to Pro.
13. Vercel → Domains → add `mixer.musicafricadirect.com` → in Cloudflare DNS, add the CNAME Vercel shows, set to grey cloud (DNS only).
14. Render live service: add `MIXER_SHARED_SECRET`, `MIXER_URL=https://mixer.musicafricadirect.com`, `MAD_MIXER_ENABLED=true`, and `MADMIXER_FM_USER`/`PASS` if missing. Send me the live service's `onrender.com` address.
15. Say "push it live". I merge `main` into `live` and switch Vercel Production's `MAD_INTERNAL_URL`.

**Decisions for Ian:**
1. A separate MVSEP account for Mad Mixer? I recommend yes; otherwise DCMax and Mixer share one pool of credits.
2. Free split limited to Quick (about 2 credits rather than about 13)? I recommend yes.
3. If MVSEP cannot fetch the song (our failure, no stems produced), give the split back? I recommend yes. It isn't a refund.
4. v1 without splitting edits or stems? I recommend yes.
5. Subdomain `mixer.musicafricadirect.com`?
6. Best costs about 5× Quick but counts as one split. Keep that, or count Best as 2?
7. Monthly reset on the UTC calendar month (as today), or per subscription month?
8. When to buy Pro: needed before the public launch.

**Open questions to test (mine):**
- Does `get-remote` need `api_token`, and what is its full list of statuses?
- Is MVSEP charged at create or after the song is fetched?
- Do the result hosts for all 4 models send CORS?
- Will Cloudflare's bot rules on the media CDN ever block MVSEP's fetcher?
- Does Vercel keep `req.url` through the rewrite?

## 4. What v1 leaves out, and how it degrades
- **Splitting edited audio, a stem, or an undone edit** (undo clones the buffer, `app-stems.html:12405`): AI Split is greyed with "Mad Mixer splits the original song — reopen it". If it is forced, the result is a local 400 and "nothing was charged". Mixing, export and stem download all still work.
  - **v1.1:** stem-of-stem by passing MVSEP's own result URL, if MVSEP accepts it (the server checks it belongs to the user's own finished split).
  - **v2:** presigned S3 uploads. That is a product decision, because it breaks the catalogue-only rule.
- **MVSEP webhook and cron settlement:** splits settle when they are polled. Abandoned ones stay counted, which matches no refunds.
- **Master host hooks** that skip the WAV encode: v1.1, after the other agent's work lands. DCMax is unchanged until then and stays on Render with all models and the Ensemble default.
- **Cross-device split list, result reuse, FLAC stems, MVSEP balance alerts, Paystack subscribe buttons:** later.
- **Old MAD `/mixer` page and API:** they stay as a fallback behind `MIXER_URL` until the cleanup about 2 weeks after launch.