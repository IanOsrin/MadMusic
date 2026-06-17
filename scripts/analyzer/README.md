# MAD Music Analyzer — Render-ready

Analyses tracks with Essentia (BPM, key, mood, energy, quality) and writes the
`AI_*` fields back to FileMaker. Stateless and unattended: it asks FileMaker for
records whose `AI_BPM` is empty, so it auto-processes new tracks and never needs
a local progress file.

## Run as a Render Cron Job (machine-independent)

| Field | Value |
|---|---|
| **Runtime** | Python — set `PYTHON_VERSION` = `3.11.9` (Essentia ships wheels for 3.8–3.11) |
| **Branch** | `main` |
| **Build Command** | `cd scripts/analyzer && pip install -r requirements.txt` |
| **Command** | `cd scripts/analyzer && python mad_analyzer.py --limit 300` |
| **Schedule** | `30 2 * * *` (nightly, after the artwork cron) |
| **Environment** | `FM_USER`, `FM_PASS`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION=eu-north-1` |

Non-secret settings (FM host/db/layout/field names, S3 bucket/prefix) have built-in
defaults; override with `FM_HOST` / `FM_DB` / `FM_LAYOUT` / `S3_BUCKET` / `S3_PREFIX`
if they ever change. **No secrets are committed** — creds come only from env.

Notes:
- `--limit` bounds each run; the nightly job clears the small backlog of new tracks.
- Tracks that can't be analysed (missing/corrupt audio) get `AI_BPM = -1` + a note
  in `AI_QualityNotes`, so the find-for-empty query excludes them and they don't loop.
- Essentia install is the one thing to watch — if the wheel doesn't resolve on the
  chosen Python, drop `PYTHON_VERSION` to 3.10/3.9.

## Run locally

```bash
# uses env vars, or a local config.json (gitignored) with the same shape as the original tool
ANALYZER_CONFIG=/path/to/config.json python mad_analyzer.py --limit 50 --dry-run
```

`--dry-run` analyses without writing to FileMaker.
