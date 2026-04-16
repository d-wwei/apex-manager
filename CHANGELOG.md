# Changelog

## [0.1.1] - 2026-04-16

### Fixed

- **Claude/ft-claude 401 auth**: Spawned worker terminals now inherit API auth env vars via `buildEnvPrefix()` (forwards `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.)
- **Codex sandbox + exit**: Switched from one-shot `exec --full-auto` to interactive `--full-auto` mode with post-create protocol injection
- **Gemini immediate exit**: Removed one-shot `-p` flag, now uses interactive `--yolo` mode with post-create protocol injection
- **OpenCode wrong flag**: Corrected `-p` (password) misuse, removed unnecessary `run` subcommand, fixed `protocolInjection` metadata
- **Daemon crash misdetection**: Added `executionMode` (persistent/one-shot) to agent adapters and `exitedWithoutResult` health status — one-shot agent exits are no longer classified as crashes
- **Non-git repo empty worktree**: Detects non-git repos upfront, uses project root directly instead of creating empty mkdir fallback
- **cmdKill non-git**: Skips worktree/branch cleanup when worker ran without git isolation
- **cmdMerge non-git**: Guards against merge attempts on non-git workers with clear error message

### Added

- `buildEnvPrefix()` helper for forwarding auth env vars to spawned terminals
- `executionMode` and `needsPostCreateSend` fields on `AgentAdapter` interface
- `execution_mode` field on `WorkerMeta` (optional, backward-compatible)
- `exitedWithoutResult` field on `WorkerHealth`
- `isolated` option on `ProtocolBuildOptions` for non-git-repo mode
- Adaptive "Work Boundaries" protocol section for non-isolated workers
- `ft-claude` adapter in `BUILTIN_ADAPTERS` registry

## [0.1.0] - 2026-04-15

### Added

- Initial release: multi-agent orchestrator with three-layer architecture (Plan Agent / Daemon / Workers)
