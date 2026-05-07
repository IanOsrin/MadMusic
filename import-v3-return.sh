#!/usr/bin/env bash
# ── import-v3-return.sh ───────────────────────────────────────────────────────
# Run this when the developer returns the MadMusic V3.0 folder.
#
# What it does:
#   1. Lists which files were changed, added, or deleted (plain text,
#      easy to read).
#   2. Produces a unified-diff report showing the exact line-level changes,
#      saved to ~/Desktop/v3-changes-diff.txt
#   3. If the returned folder still has its git history, also produces a
#      patch file ~/Desktop/v3-changes.patch that you can apply onto a
#      branch in V2.1 using:
#         git apply --3way --reject ~/Desktop/v3-changes.patch
#
# Usage:
#   bash import-v3-return.sh ~/Desktop/MadMusicV3.0-returned
#
# (Where the argument is the path to the folder the developer sent back.)
# ──────────────────────────────────────────────────────────────────────────────

set -euo pipefail

BASELINE="$HOME/Desktop/MadMusicV3.0-baseline"
RETURNED="${1:-}"
REPORT_LIST="$HOME/Desktop/v3-changes-list.txt"
REPORT_DIFF="$HOME/Desktop/v3-changes-diff.txt"
REPORT_PATCH="$HOME/Desktop/v3-changes.patch"

# ── Sanity checks ─────────────────────────────────────────────────────────────
if [[ -z "$RETURNED" ]]; then
  echo "Usage: bash import-v3-return.sh <path-to-returned-folder>" >&2
  exit 1
fi
if [[ ! -d "$RETURNED" ]]; then
  echo "ERROR: returned folder not found at $RETURNED" >&2
  exit 1
fi
if [[ ! -d "$BASELINE" ]]; then
  echo "ERROR: baseline reference folder not found at $BASELINE" >&2
  echo "       (It should have been created when you ran make-v3-handoff.sh.)" >&2
  exit 1
fi

echo "→ Comparing:"
echo "    baseline  = $BASELINE"
echo "    returned  = $RETURNED"
echo

# ── Step 1: plain list of added/changed/removed files ────────────────────────
echo "→ Writing change list to $REPORT_LIST ..."
{
  echo "MadMusic V3.0 — change list"
  echo "Baseline: $BASELINE"
  echo "Returned: $RETURNED"
  echo "Generated: $(date)"
  echo
  echo "=== Files changed, added, or removed ==="
  diff -rq \
    --exclude='.git' \
    --exclude='node_modules' \
    --exclude='.DS_Store' \
    "$BASELINE" "$RETURNED" || true
} > "$REPORT_LIST"

# ── Step 2: unified diff with line-level changes ─────────────────────────────
echo "→ Writing line-level diff to $REPORT_DIFF ..."
{
  echo "MadMusic V3.0 — line-level diff"
  echo "Baseline: $BASELINE"
  echo "Returned: $RETURNED"
  echo "Generated: $(date)"
  echo
  diff -ruN \
    --exclude='.git' \
    --exclude='node_modules' \
    --exclude='.DS_Store' \
    "$BASELINE" "$RETURNED" || true
} > "$REPORT_DIFF"

# ── Step 3: if returned folder has git history, produce a proper patch ────────
if [[ -d "$RETURNED/.git" ]]; then
  echo "→ Returned folder has git history — generating $REPORT_PATCH ..."
  (
    cd "$RETURNED"
    if git rev-parse v3-baseline >/dev/null 2>&1; then
      git format-patch v3-baseline --stdout > "$REPORT_PATCH"
      echo "  Patch covers commits since the v3-baseline tag."
    else
      echo "  NOTE: v3-baseline tag missing in returned folder — skipping patch." >&2
    fi
  )
else
  echo "→ No git history in returned folder — skipping patch file."
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo
echo "✓ Done."
echo
echo "  Plain list of changes:  $REPORT_LIST"
echo "  Line-level diff:        $REPORT_DIFF"
if [[ -f "$REPORT_PATCH" ]]; then
  echo "  Git patch:              $REPORT_PATCH"
fi
echo
echo "  Open the change list first to see which files moved — it's the quickest"
echo "  way to get a feel for the scope of the work."
