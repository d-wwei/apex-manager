# CLI Binary ERR_MODULE_NOT_FOUND — ESM .js Import Resolution

**Category**: bug
**Date**: 2026-04-16
**Commit**: 29792a9

## Context

`apex-manager worker check` (and all other subcommands) failed with `ERR_MODULE_NOT_FOUND` when invoked via the npm-linked global binary.

## Problem (Root Cause)

Node v25.8.0 `--experimental-strip-types` (unflagged since v23.6) strips TypeScript types but does NOT rewrite `.js` → `.ts` import specifiers. The project uses standard ESM TypeScript convention (`import("./commands/worker.js")` to load `worker.ts`), which works with tsc output or tsx but not with Node's native type stripping.

The `package.json` `"bin"` pointed directly at `src/cli.ts` with `#!/usr/bin/env node`, so the global binary ran with plain Node.js — no tsx loader, no import rewriting.

## What Was Tried

1. `--experimental-transform-types` flag → still doesn't rewrite `.js` → `.ts` in dynamic imports
2. `node:module` register API with `tsx/esm` → tsx rejects it on Node v25 ("must be loaded with --import instead of --loader")
3. `node --import tsx/esm` → works from project dir but not from other dirs (can't resolve bare specifier `tsx` from CWD)

## Solution

Shell wrapper (`bin/apex-manager.sh`) that:
1. Resolves its own real path (follows symlinks from npm link)
2. Constructs an absolute `file://` URL to `tsx/dist/esm/index.mjs` with percent-encoded spaces
3. Runs `node --import <tsx-url> src/cli.ts "$@"`

Also: moved tsx from devDependencies to dependencies, added `"os": ["darwin", "linux"]`.

## Why It Worked

`--import` registers tsx's ESM hooks before any user module loads, so by the time `cli.ts` runs `import("./commands/worker.js")`, tsx intercepts the resolution and correctly maps `.js` → `.ts`. The absolute file URL bypasses CWD-based resolution issues.

## Generalized Pattern

**Node's native TypeScript support is type-stripping only — it is not a TypeScript runtime.** Any project using ESM `.js` extension convention without a build step needs a proper TypeScript loader (tsx, ts-node, etc.) even on Node v25+. For CLI tools distributed via npm link/install, use a shell wrapper with `--import` to preload the loader.

## Prevention

- CLI entry points in `package.json` `"bin"` should never point directly at `.ts` files with `#!/usr/bin/env node`
- Test global install path (`npm link` + run from unrelated directory) as part of release checklist
- Any `file://` URL construction must percent-encode special characters (spaces, etc.)
