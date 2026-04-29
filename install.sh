#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILL_NAME="apex-manager"

echo "Installing $SKILL_NAME..."

# Install to skill directories
for base in ~/.agents/skills ~/.claude/skills ~/.codex/skills ~/.gemini/skills; do
  mkdir -p "$base"
  target="$base/$SKILL_NAME"
  if [ -L "$target" ] || [ -d "$target" ]; then
    echo "  ✓ $target (already exists)"
  else
    ln -s "$SCRIPT_DIR" "$target"
    echo "  ✓ $target → $SCRIPT_DIR"
  fi
done

# Install npm deps if needed
if [ ! -d "$SCRIPT_DIR/node_modules" ]; then
  echo "Installing dependencies..."
  (cd "$SCRIPT_DIR" && npm install --production)
fi

# Make CLI available
npm link 2>/dev/null || true

echo "Done. Use /apex-manager in your AI agent."
