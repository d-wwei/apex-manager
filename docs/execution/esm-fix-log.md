# Execution Log: CLI binary ESM module resolution fix

## Root Cause
Node v25.8.0 natively strips TypeScript types but does NOT rewrite `.js` → `.ts` import specifiers.
`cli.ts` uses `import("./commands/worker.js")` (standard ESM TS convention), but only `.ts` files exist on disk.
The `tsx` runtime handles this rewriting; plain `node` does not.

## Fix Applied
- Created `bin/apex-manager.sh` — shell wrapper that resolves tsx's ESM loader path and passes it to `node --import`
- Updated `package.json` `"bin"` to point at the wrapper
- Moved tsx from devDependencies to dependencies

## Verification
- `apex-manager worker check` from `/tmp`: PASS
- `apex-manager --version` from `/tmp`: PASS
- `apex-manager orch status` from `/tmp`: PASS
- `npx tsx src/cli.ts worker check` (dev path): PASS
- `npm test`: 232/232 pass
