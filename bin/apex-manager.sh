#!/bin/sh
# Resolve the real path of this script (follows symlinks)
SCRIPT="$0"
while [ -L "$SCRIPT" ]; do
  DIR="$(cd "$(dirname "$SCRIPT")" && pwd)"
  SCRIPT="$(readlink "$SCRIPT")"
  case "$SCRIPT" in
    /*) ;;
    *) SCRIPT="$DIR/$SCRIPT" ;;
  esac
done
SCRIPT_DIR="$(cd "$(dirname "$SCRIPT")" && pwd)"
PACKAGE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Path corresponds to the "tsx/esm" package export (stable within tsx 4.x)
TSX_ESM="$PACKAGE_DIR/node_modules/tsx/dist/esm/index.mjs"
CLI="$PACKAGE_DIR/src/cli.ts"

# Percent-encode spaces for RFC 8089 compliant file:// URL
TSX_URL="file://$(echo "$TSX_ESM" | sed 's/ /%20/g')"
exec node --import "$TSX_URL" "$CLI" "$@"
