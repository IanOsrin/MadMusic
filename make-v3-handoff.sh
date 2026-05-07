#!/usr/bin/env bash
# ── make-v3-handoff.sh ────────────────────────────────────────────────────────
# Creates ~/Desktop/MadMusicV3.0 as a clean handoff copy of the streamer
# for an external developer, plus ~/Desktop/MadMusicV3.0-baseline as an
# untouched reference copy used later to spot changes.
#
# What it does:
#   1. Copies the streamer source from ~/Desktop/madmusicV2.1, excluding
#      notes/docs, the separate audio desktop app, node_modules, live user
#      data, and the GitHub link.
#   2. Drops in empty user-data stubs so the server still boots.
#   3. Copies docs/Code-Map.md (only) so the developer has an orientation doc.
#   4. Initialises a fresh local git repo with one baseline commit tagged
#      'v3-baseline'. No remote → cannot reach GitHub.
#   5. Writes a short README-HANDOFF.md at the root with the ground rules.
#   6. Duplicates the whole thing to MadMusicV3.0-baseline so you have a
#      pristine reference to diff against when the work comes back.
#
# Run from the madmusicV2.1 folder:
#   bash make-v3-handoff.sh
# ──────────────────────────────────────────────────────────────────────────────

set -euo pipefail

SRC="$HOME/Desktop/madmusicV2.1"
DEST="$HOME/Desktop/MadMusicV3.0"
BASELINE="$HOME/Desktop/MadMusicV3.0-baseline"

echo "→ Source:   $SRC"
echo "→ Handoff:  $DEST"
echo "→ Baseline: $BASELINE"
echo

# ── Sanity checks ─────────────────────────────────────────────────────────────
if [[ ! -d "$SRC" ]]; then
  echo "ERROR: source folder not found at $SRC" >&2
  exit 1
fi
if [[ -e "$DEST" ]]; then
  echo "ERROR: $DEST already exists. Move or delete it first." >&2
  exit 1
fi
if [[ -e "$BASELINE" ]]; then
  echo "ERROR: $BASELINE already exists. Move or delete it first." >&2
  exit 1
fi
if ! command -v rsync >/dev/null 2>&1; then
  echo "ERROR: rsync not found." >&2
  exit 1
fi
if ! command -v git >/dev/null 2>&1; then
  echo "ERROR: git not found." >&2
  exit 1
fi

# ── Copy source with exclusions ───────────────────────────────────────────────
echo "→ Copying source files (this takes a few seconds)..."
rsync -a \
  --exclude='.git/' \
  --exclude='node_modules/' \
  --exclude='.DS_Store' \
  --exclude='DigitalCupboardAudio/' \
  --exclude='docs/' \
  --exclude='PERFORMANCE_TEST_PLAN.md' \
  --exclude='make-v3-handoff.sh' \
  --exclude='import-v3-return.sh' \
  --exclude='data/users.json' \
  --exclude='data/playlists.json' \
  --exclude='data/playlist_requests.json' \
  --exclude='data/access-tokens.json' \
  --exclude='data/library.json' \
  --exclude='data/*.lock' \
  --exclude='*.log' \
  "$SRC/" "$DEST/"

# ── Stub user-data files ──────────────────────────────────────────────────────
echo "→ Writing empty user-data stubs..."
mkdir -p "$DEST/data"
echo '[]'                >  "$DEST/data/users.json"
echo '[]'                >  "$DEST/data/playlists.json"
echo '[]'                >  "$DEST/data/playlist_requests.json"
echo '{"tokens":[]}'     >  "$DEST/data/access-tokens.json"
echo '{}'                >  "$DEST/data/library.json"

# ── Copy just the Code-Map orientation doc ────────────────────────────────────
if [[ -f "$SRC/docs/Code-Map.md" ]]; then
  echo "→ Including docs/Code-Map.md for developer orientation..."
  mkdir -p "$DEST/docs"
  cp "$SRC/docs/Code-Map.md" "$DEST/docs/Code-Map.md"
fi

# ── Drop the handoff README ───────────────────────────────────────────────────
cat > "$DEST/README-HANDOFF.md" <<'README'
# MadMusic V3.0 — Handoff Copy

Hi — this is a working copy of the MadMusic streamer for you to edit locally.

## Getting it running

```bash
cd MadMusicV3.0
npm install
node server.js
```

Open http://localhost:3000 in your browser. The `.env` file already has the
credentials you need.

## Ground rules — please read

1. **Do not add a git remote.** This folder is a fresh local git repo with
   no connection to any hosted repository. Please don't add one. Commit
   freely on your local machine — your commits come back with the folder.

2. **Commit your changes as you go.** Small, descriptive commits help a lot
   when the work is being reviewed and merged.

3. **Don't overwrite files in `data/`.** Those are placeholder stubs to let
   the server boot. If you need test data, add it under a different path.

4. **Return the whole folder** (zipped is fine) when finished.

## Orientation

See `docs/Code-Map.md` for a plain-English walkthrough of how the code
is laid out and what each module does.

## Questions

Contact the project owner directly — contact details in `.env` or via the
email you received this from.
README

# ── Fresh git repo, no remote, tagged baseline ────────────────────────────────
echo "→ Initialising fresh local git repo with baseline tag..."
(
  cd "$DEST"
  git init --quiet --initial-branch=main
  git config user.name  "MadMusic Handoff"
  git config user.email "handoff@local"
  git add .
  git commit --quiet -m "V3.0 handoff baseline ($(date +%Y-%m-%d))"
  git tag v3-baseline
)

# ── Create pristine reference copy ────────────────────────────────────────────
echo "→ Duplicating handoff to reference copy (untouched baseline)..."
rsync -a "$DEST/" "$BASELINE/"

# ── Summary ───────────────────────────────────────────────────────────────────
echo
echo "✓ Done."
echo
echo "  Handoff folder:  $DEST"
echo "  Keep-safe copy:  $BASELINE"
echo
echo "  Hand the HANDOFF folder to the developer."
echo "  Keep the BASELINE copy in a safe place — you'll need it when the"
echo "  folder comes back to spot what they changed."
echo
echo "  Next step when the folder returns:  bash import-v3-return.sh <path>"
