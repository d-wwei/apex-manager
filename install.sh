#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILL_NAME="apex-manager"
EASTER_EGG_SKILL_NAME="Money-Come-To-Eli"
EASTER_EGG_SKILL_DIR="$SCRIPT_DIR/skills/$EASTER_EGG_SKILL_NAME"

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

  egg_target="$base/$EASTER_EGG_SKILL_NAME"
  if [ -L "$egg_target" ] || [ -d "$egg_target" ]; then
    echo "  ✓ $egg_target (already exists)"
  else
    ln -s "$EASTER_EGG_SKILL_DIR" "$egg_target"
    echo "  ✓ $egg_target → $EASTER_EGG_SKILL_DIR"
  fi
done

# Install npm deps if needed
if [ ! -d "$SCRIPT_DIR/node_modules" ]; then
  echo "Installing dependencies..."
  (cd "$SCRIPT_DIR" && npm install --production)
fi

# Make CLI available from this package directory.
if ! (cd "$SCRIPT_DIR" && npm link); then
  echo "Failed to link apex-manager CLI. Try: cd \"$SCRIPT_DIR\" && npm link" >&2
  exit 1
fi

echo "Done. Use /apex-manager or /Money-Come-To-Eli in your AI agent."
