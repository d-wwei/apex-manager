#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

"$REPO_ROOT/bin/apex-manager.sh" orch Money-Come-To-Eli "$@"
