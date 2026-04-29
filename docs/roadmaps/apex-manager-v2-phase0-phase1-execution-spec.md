# Spec: Apex Manager v2 Phase 0-1 Execution

## Objective

Deliver the first practical slice of the Team Kernel upgrade without destabilizing the existing worktree + daemon architecture.

This slice focuses on two outcomes:

1. Fix the current command/protocol mismatches so generated worker instructions are executable in a real repo.
2. Introduce the first generic Team Kernel primitives that improve the manager-to-worker experience without forcing a full rewrite.

The user outcome for this slice is:

- `apex-manager init` can initialize a repo idempotently.
- Worker instructions no longer reference missing commands.
- Workers can claim, complete, and block tasks through real commands.
- Workers and humans can submit generic artifacts.
- Manager-to-worker terminal messaging has a real command surface and audit trail.

## Evaluation Of The Roadmap

The attached roadmap is directionally correct and worth implementing.

The main adjustment for execution is sequencing:

- Do not jump straight to a full Team Kernel rewrite.
- First stabilize the existing CLI and worker protocol.
- Then add terminal-first generic messaging on top of the current transport.
- Defer pending delivery queues, event rebuilding, MCP, A2A, and ACP until the current core is self-consistent.

This keeps the architecture aligned with the roadmap while reducing migration risk.

## Commands

Build:

```bash
npm run typecheck
```

Test:

```bash
npm test
```

Focused tests during iteration:

```bash
node --import tsx --test tests/commands/*.test.ts
node --import tsx --test tests/worker/*.test.ts
node --import tsx --test tests/daemon/*.test.ts
```

Manual CLI validation:

```bash
npx tsx src/cli.ts --help
npx tsx src/cli.ts init
npx tsx src/cli.ts task help
npx tsx src/cli.ts artifact help
npx tsx src/cli.ts worker help
```

## Project Structure

- `src/cli.ts`: top-level command dispatch
- `src/commands/`: user-facing command surface
- `src/types/`: persisted state shapes
- `src/worker/`: worker protocol and terminal transport behavior
- `src/daemon/`: deterministic orchestration loop
- `tests/commands/`: command-level behavior coverage
- `tests/worker/`: worker protocol and adapter behavior coverage
- `docs/roadmaps/`: roadmap and execution spec

## Code Style

Use additive, compatibility-preserving changes with small helpers instead of wide rewrites.

Example style:

```ts
function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}
```

Conventions:

- Prefer explicit state transitions over implicit mutation.
- Keep persistence formats simple and inspectable.
- Preserve existing command behavior unless the change is fixing a broken contract.
- Favor idempotent filesystem commands for repo initialization.

## Testing Strategy

- Add command tests for every new CLI surface.
- Update protocol-builder tests when instruction text changes.
- Keep existing daemon and worker tests green to prove compatibility.
- Use full `npm test` and `npm run typecheck` before claiming completion.

## Boundaries

- Always:
  - Preserve current worktree/daemon architecture.
  - Keep new storage local-first and file-inspectable.
  - Maintain backward compatibility where practical.
- Ask first:
  - Replacing the existing daemon loop with an event-sourced engine.
  - Introducing a database dependency.
  - Removing old subcommands that may still be used externally.
- Never:
  - Add remote services or heavy runtime dependencies for this slice.
  - Hardcode domain-specific testing or review semantics into the new generic commands.

## Success Criteria

- `apex-manager init` exists and is idempotent.
- `worker spawn` no longer relies on missing top-level commands.
- Worker protocol text references only real commands.
- `task claim`, `task complete`, and `task block` exist and persist meaningful task metadata.
- `artifact submit` exists and records generic artifact metadata.
- Manager can send a structured terminal message through a real command.
- Tests and typecheck pass.

## Open Questions

- Whether `artifact list/show` should land in this same slice or immediately after it.
  - Working assumption: include them if they are low-risk once submit exists.

# Implementation Plan: Apex Manager v2 Phase 0-1

## Overview

Implement the missing command/kernel foundation first, then layer terminal-first messaging on top of the current worker transport.

## Architecture Decisions

- Keep `.apex-manager/` as the source of truth for this slice.
- Use explicit JSON/JSONL files instead of introducing SQLite now.
- Model new behavior through generic commands first; keep old `task update` for compatibility.
- Add messaging as an auditable command surface before building idle-aware delivery automation.

## Task List

### Phase 1: CLI Foundation

- [ ] Task 1: Add `apex-manager init`
  - Acceptance: repo initialization creates the required `.apex-manager` structure and default config files without overwriting existing user data.
  - Verify: command tests plus `npx tsx src/cli.ts init`
  - Files: `src/cli.ts`, new init command module, related tests

- [ ] Task 2: Add generic task lifecycle commands
  - Acceptance: `task claim`, `task complete`, and `task block` work against persisted task state and capture actor/reason metadata.
  - Verify: task command tests
  - Files: `src/commands/task.ts`, `src/types/task.ts`, tests

- [ ] Task 3: Add generic artifact commands
  - Acceptance: artifacts can be submitted and are linked back to tasks without domain-specific logic.
  - Verify: artifact command tests
  - Files: new artifact command/types/helpers, task status integration, tests

### Checkpoint: Foundation

- [ ] No protocol output references nonexistent commands
- [ ] CLI help exposes the new commands
- [ ] Foundation tests pass

### Phase 2: Protocol And Messaging

- [ ] Task 4: Update worker protocol generation to use the real generic command surface
  - Acceptance: generated worker instructions use `task claim/complete/block` and `artifact submit`, and `task.protocol` is passed through correctly.
  - Verify: protocol-builder tests and dry-run worker spawn
  - Files: `src/commands/worker.ts`, `src/worker/protocol-builder.ts`, tests

- [ ] Task 5: Add terminal-first structured messaging
  - Acceptance: manager can send a structured message to a worker using a real command, persisted metadata, and a clear terminal envelope.
  - Verify: command tests and event-log assertions
  - Files: `src/commands/worker.ts`, new message helpers/types, tests

### Checkpoint: Complete

- [ ] `npm test` passes
- [ ] `npm run typecheck` passes
- [ ] Main acceptance criteria from this spec are satisfied

## Risks And Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Breaking existing worker/daemon expectations | High | Keep old files and flows intact; add generic commands around them |
| Overreaching into full Team Kernel rewrite | High | Limit this slice to Phase 0 and the first useful part of Phase 1 |
| Storage shape drift across commands | Medium | Introduce shared types/helpers for task, artifact, and message persistence |
| Protocol text changes causing regressions | Medium | Update protocol tests before final verification |
