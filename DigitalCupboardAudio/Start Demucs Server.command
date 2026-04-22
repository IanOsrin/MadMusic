#!/bin/bash
# ─────────────────────────────────────────────────────────────
#  Digital Cupboard — Demucs AI Stem Server Launcher
#  Double-click this file to start the server.
#  Keep this window open while using AI Split in the audio app.
#  Press Ctrl+C or close this window to stop the server.
# ─────────────────────────────────────────────────────────────

clear

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER="$SCRIPT_DIR/demucs-server.py"

echo "🎛️  Digital Cupboard — Demucs AI Stem Server"
echo "────────────────────────────────────────────"

# Check Python3
if ! command -v python3 &>/dev/null; then
  echo ""
  echo "❌  Python 3 not found."
  echo "    Install it from https://www.python.org or via Homebrew:"
  echo "    brew install python"
  echo ""
  read -p "Press Enter to close..."
  exit 1
fi

echo "✓  Python $(python3 --version | cut -d' ' -f2) found"
echo ""
echo "    Starting server — first run downloads the Demucs model (~330 MB)."
echo "    Subsequent runs start instantly."
echo ""
echo "────────────────────────────────────────────"
echo ""

python3 "$SERVER"

echo ""
echo "────────────────────────────────────────────"
echo "  Server stopped."
read -p "  Press Enter to close this window..."
