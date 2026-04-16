---
status: DONE_WITH_CONCERNS
---

# Review: worker-spawn-fixes

**Commit**: 0cbea40 `fix: resolve all 5 worker spawn failures + daemon crash misdetection`
**Reviewer**: Multi-Persona Code Review (Opus 4.6)
**Date**: 2026-04-15

---

## Status: DONE_WITH_CONCERNS

One P1 finding (shell injection surface in `buildEnvPrefix`) and several P2 findings that should be addressed before the next feature increment. No critical (severity-zero) blockers.

---

## Security Reviewer

### Finding: `buildEnvPrefix` shell injection surface via env var keys/values
- **Severity**: P1
- **Persona**: Security Reviewer
- **Confidence**: high
- **File**: `/Users/admin/Documents/AI/agent better work/apex-manager/src/worker/agent-adapter.ts:33-46`
- **Description**: `buildEnvPrefix()` constructs a shell string by interpolating env var values into single-quoted shell fragments. The escaping `val.replace(/'/g, "'\\''")` is the standard POSIX single-quote escape idiom and is correct for well-formed values. However, the function is exported and the AUTH_ENV_KEYS list is hardcoded, so the attack surface is limited to the nine listed env vars. The real concern is that if a caller later extends the `skip` parameter to allow arbitrary key names (or if `AUTH_ENV_KEYS` is expanded to include user-controlled keys), the `key` variable itself is interpolated without any validation. An env var name containing `=`, backticks, or shell metacharacters would break the shell escaping assumption.
- **Evidence**: Line 42: `parts.push(\`\${key}='\${escaped}'\`)` -- `key` is not validated, only `val` is escaped. Currently the keys come from a hardcoded const array, so exploitation requires modifying `AUTH_ENV_KEYS`. The risk is low today but the function is exported as a public API.
- **Suggested fix**: Add a key validation guard: `if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) continue;` before the push. This is defense-in-depth against future changes and costs nothing.

### Finding: Env var values exposed in terminal command strings
- **Severity**: P2
- **Persona**: Security Reviewer
- **Confidence**: medium
- **File**: `/Users/admin/Documents/AI/agent better work/apex-manager/src/worker/agent-adapter.ts:122-123`
- **Description**: The `buildStartCommand` for claude and ft-claude embeds API keys directly in the shell command string (e.g., `ANTHROPIC_API_KEY='sk-...' cd "/path" && claude ...`). This command string is passed to `tmux new-window` or `cmux send`, which means it appears in the tmux scrollback buffer, potentially in process listings (`ps aux`), and in any logs that capture the spawn command. Other adapters (codex, gemini, opencode) inherit the parent process environment and do not have this issue because they do not call `buildEnvPrefix()`.
- **Evidence**: `claudeAdapter.buildStartCommand` and `ftClaudeAdapter.buildStartCommand` both prepend `buildEnvPrefix()` output, which includes `ANTHROPIC_API_KEY` values in cleartext shell syntax.
- **Suggested fix**: Consider using tmux's `set-environment` or passing env vars via the terminal adapter's `createWindow` method (e.g., adding an `env` option to `TerminalAdapter.createWindow`). This would keep secrets out of the command string. Alternatively, document the risk as accepted for the current tmux-based deployment model.

### Finding: `terminal.send()` trust boundary for protocol injection
- **Severity**: P2
- **Persona**: Security Reviewer
- **Confidence**: medium
- **File**: `/Users/admin/Documents/AI/agent better work/apex-manager/src/commands/worker.ts:214-218`
- **Description**: The post-create protocol injection uses `terminal.send(handle, ...)` which calls `tmux send-keys` to type text into the agent's terminal. The message content is a static string (the relative protocol path) and is not user-controlled, so there is no immediate injection risk. However, the `send` method has no escaping or quoting of the text before passing to `tmux send-keys`. If the protocol file path ever contains tmux special characters, the behavior could be unexpected. Additionally, the fixed 3-second sleep is a fragile timing assumption (see Correctness section).
- **Evidence**: Line 216-218 in `worker.ts`: `await new Promise((r) => setTimeout(r, 3000));` followed by `await terminal.send(handle, ...)`. The tmux `send-keys` command treats certain key names specially.
- **Suggested fix**: For robustness, consider using `tmux load-buffer` + `tmux paste-buffer` instead of `send-keys` for multi-word text, which avoids special character interpretation.

---

## Correctness Reviewer

### Finding: Fixed 3-second delay for post-create send is fragile
- **Severity**: P2
- **Persona**: Correctness Reviewer
- **Confidence**: high
- **File**: `/Users/admin/Documents/AI/agent better work/apex-manager/src/commands/worker.ts:216`
- **Description**: The code waits exactly 3 seconds after creating a terminal window before sending the protocol instruction. This is a race condition: on slow machines or when the agent CLI takes longer to initialize (e.g., codex downloading models on first run, gemini doing auth), 3 seconds may not be enough. On fast machines, it is wasted time. There is no verification that the agent is ready to receive input.
- **Evidence**: `await new Promise((r) => setTimeout(r, 3000));` -- hardcoded delay with no readiness check.
- **Suggested fix**: Implement a polling loop that reads the terminal screen (via `terminal.readScreen`) and checks for the agent's prompt indicator before sending. This is similar to the existing `isAgentIdle` pattern in `cmdInterrupt`. A fallback timeout (e.g., 30 seconds) should be used to avoid infinite waits.

### Finding: Non-git fallback silently drops worktree from previous git-repo run
- **Severity**: P3
- **Persona**: Correctness Reviewer
- **Confidence**: low
- **File**: `/Users/admin/Documents/AI/agent better work/apex-manager/src/commands/worker.ts:118-152`
- **Description**: When `isGitRepo` is false, the worker runs directly in `projectRoot` with `branch = ""` and `isolated = false`. This is correct for fresh non-git repos. However, if a project was previously a git repo and worktrees exist in `.apex-manager/worktrees/`, those stale worktrees are not cleaned up or warned about. This is an edge case with minimal real-world impact.
- **Evidence**: The non-git path does not check for stale `.apex-manager/worktrees/` directories.
- **Suggested fix**: Low priority. Could add a one-time warning if `.apex-manager/worktrees/` exists but the project is not a git repo.

### Finding: `execution_mode` field defaults to undefined for old meta.json files
- **Severity**: P3
- **Persona**: Correctness Reviewer
- **Confidence**: high
- **File**: `/Users/admin/Documents/AI/agent better work/apex-manager/src/worker/monitor.ts:41,156`
- **Description**: The `execution_mode` field on `WorkerMeta` is optional (`execution_mode?: "persistent" | "one-shot"`). For workers spawned before this commit, `meta.execution_mode` will be `undefined`. In `checkWorkerHealth`, `isOneShot = meta.execution_mode === "one-shot"` evaluates to `false` when undefined, which means old workers with no execution_mode will be treated as persistent. This is the correct backward-compatible behavior -- old workers that exit will be reported as "crashed" rather than "exited without result", which matches the pre-fix behavior.
- **Evidence**: Line 156: `const isOneShot = meta.execution_mode === "one-shot";` -- `undefined === "one-shot"` is `false`, so the default is "persistent" behavior.
- **Suggested fix**: No fix needed. This is correct backward-compatible behavior. The optional typing is appropriate.

### Finding: All current builtin adapters are "persistent" -- no one-shot adapters exist
- **Severity**: P3
- **Persona**: Correctness Reviewer
- **Confidence**: high
- **File**: `/Users/admin/Documents/AI/agent better work/apex-manager/src/worker/agent-adapter.ts:109,132,163,180,202,237`
- **Description**: Every single builtin adapter (claude, ft-claude, codex, gemini, opencode, and the default adapter factory) sets `executionMode: "persistent"`. The entire one-shot detection path in `monitor.ts` and `daemon.ts` is currently unreachable via builtin adapters. The code is correct as infrastructure for custom one-shot agents defined via config, but the specific bug this was meant to fix (codex/gemini exiting after one-shot) was resolved differently -- by switching them to interactive mode instead.
- **Evidence**: All `executionMode` values are `"persistent"` in the BUILTIN_ADAPTERS map. The one-shot code path can only activate via custom config adapters.
- **Suggested fix**: No code fix needed, but the commit message mentions "daemon crash misdetection" as bug #5. The implementation correctly addresses the class of problem by (a) switching agents to interactive mode so they don't exit, and (b) adding infrastructure to properly detect one-shot exits for future/custom agents. The documentation/commit message could be clearer about this two-pronged approach.

---

## Spec Compliance Reviewer

### Bug 1: Claude/ft-claude 401 auth -- added env var forwarding
- **Status**: ADDRESSED
- **Evidence**: `buildEnvPrefix()` added to `claudeAdapter.buildStartCommand` and `ftClaudeAdapter.buildStartCommand`. The function forwards `ANTHROPIC_API_KEY`, `CLAUDE_API_KEY`, and other auth-related vars. `ft-claude` adapter added as a new builtin.
- **Files**: `src/worker/agent-adapter.ts` lines 21-46, 120-124, 195-217

### Bug 2: Codex one-shot exit -- switched to interactive mode
- **Status**: ADDRESSED
- **Evidence**: `codexAdapter.buildStartCommand` changed from `cat "${opts.protocolPath}" | codex exec --full-auto` to `codex --full-auto` (interactive mode). `needsPostCreateSend: true` added for protocol delivery after window creation. `protocolInjection` changed from `stdin` (pipe) to `stdin` (post-create send).
- **Files**: `src/worker/agent-adapter.ts` lines 127-148, `src/commands/worker.ts` lines 213-219

### Bug 3: Gemini -p one-shot exit -- switched to interactive mode
- **Status**: ADDRESSED
- **Evidence**: `geminiAdapter.buildStartCommand` changed from `gemini --yolo -p "$(cat ...)"` to `gemini --yolo`. `protocolInjection` changed from `cli-argument` with `-p` to `stdin`. `needsPostCreateSend: true` added.
- **Files**: `src/worker/agent-adapter.ts` lines 150-171

### Bug 4: OpenCode wrong -p flag -- fixed metadata + command
- **Status**: ADDRESSED
- **Evidence**: `opencodeAdapter.buildStartCommand` changed from `opencode run -p "$(cat ...)"` to `opencode` (interactive). `protocolInjection` changed from `cli-argument` with `-p` to `stdin`. `needsPostCreateSend: true` added.
- **Files**: `src/worker/agent-adapter.ts` lines 173-193

### Bug 5: Daemon crash misdetection -- added executionMode + exitedWithoutResult
- **Status**: ADDRESSED
- **Evidence**: `WorkerMeta.execution_mode` optional field added. `WorkerHealth.exitedWithoutResult` field added. `checkWorkerHealth` now distinguishes `crashed` from `exitedWithoutResult` based on `execution_mode`. `daemon.ts` tick loop handles `exitedWithoutResult` as a separate notification path (step 3b). Status display in `cmdWorker` list/status views updated.
- **Files**: `src/worker/monitor.ts` lines 41, 49-50, 152-158; `src/daemon/daemon.ts` lines 28, 92, 162-172, 193, 236; `src/commands/worker.ts` lines 656, 693

### Bug 6: Non-git repo empty dir -- detect upfront, use project root
- **Status**: ADDRESSED
- **Evidence**: `cmdSpawn` now checks `isGitRepo` via `git rev-parse --git-dir` and branches into two paths. Non-git repos skip worktree creation and use project root directly. Protocol builder receives `isolated: false` and generates simpler boundaries. `cmdKill` and `cmdMerge` now handle non-git workers: `cmdKill` skips worktree cleanup when `meta.branch` is empty; `cmdMerge` rejects non-git workers with a clear error message.
- **Files**: `src/commands/worker.ts` lines 120-152, 267-271, 444-447; `src/worker/protocol-builder.ts` lines 31-32, 489-509

### Additional: Test updates
- **Status**: All three test files updated consistently to reflect the changes. Tests pass (30/30 agent-adapter, 33/33 protocol-template).

### File manifest
- `.gitignore` -- added agent data directories (cosmetic)
- `src/cli.ts` -- mode change only (644 -> 755)
- `src/commands/worker.ts` -- spawn/kill/merge/status changes
- `src/daemon/daemon.ts` -- exitedWithoutResult handling
- `src/worker/agent-adapter.ts` -- env forwarding, execution mode, ft-claude adapter
- `src/worker/monitor.ts` -- execution_mode + exitedWithoutResult
- `src/worker/protocol-builder.ts` -- non-isolated boundaries
- `src/worker/terminal.ts` -- cmux socket verification
- `tests/worker/agent-adapter.test.ts` -- updated for 5 adapters + interactive mode
- `tests/worker/capability-check.test.ts` -- updated for 5 agents
- `tests/worker/protocol-template.test.ts` -- updated for interactive mode

---

## Adversarial Reviewer

### Technique 1: Assumption Violation

### Finding: Assumption that `gemini`/`codex`/`opencode` accept typed input in interactive mode
- **Severity**: P2
- **Persona**: Adversarial Reviewer
- **Confidence**: medium
- **File**: `/Users/admin/Documents/AI/agent better work/apex-manager/src/commands/worker.ts:218`
- **Description**: The post-create send mechanism assumes that after 3 seconds, `codex --full-auto`, `gemini --yolo`, and `opencode` will all have an active input field that accepts the typed protocol-read instruction via `tmux send-keys`. This assumption may fail if: (a) the agent opens a TUI that requires navigation to an input field, (b) the agent prompts for confirmation before accepting input, (c) the agent has a splash screen or loading period exceeding 3 seconds. None of these agents are under apex-manager's control and their CLI behavior can change with updates.
- **Evidence**: The protocol injection path relies on `terminal.send(handle, text)` which maps to `tmux send-keys text Enter` -- this types the text character by character and presses Enter. If the agent's TUI has modal dialogs or doesn't accept raw text input at the top level, the instruction will be garbled or lost.
- **Suggested fix**: Add an agent-specific readiness check before sending. For each agent that `needsPostCreateSend`, define a prompt pattern to look for in `readScreen` output. Implement retry with backoff. This is the same P2 as the Correctness finding about the fixed 3-second delay.

### Technique 2: Composition Failures

### Finding: `cmux ping` verification could mask underlying issues
- **Severity**: P3
- **Persona**: Adversarial Reviewer
- **Confidence**: low
- **File**: `/Users/admin/Documents/AI/agent better work/apex-manager/src/worker/terminal.ts:227-232`
- **Description**: The new cmux socket verification (`cmux ping`) correctly prevents using a broken cmux socket. However, the fallthrough to tmux means that if cmux was previously being used (and has existing surfaces), falling through to tmux will create new windows in tmux that are not visible in cmux. This could confuse users who expect all agent windows to appear in their cmux UI. The behavior is correct (it works), but the UX implication of silently switching adapters mid-session is not communicated.
- **Evidence**: Lines 227-232: If `cmux ping` fails, code falls through to tmux adapter without any warning to the user.
- **Suggested fix**: Add a `console.warn` when falling through from cmux to tmux, e.g., `[warn] cmux socket unreachable, falling back to tmux`.

### Technique 3: Cascade Construction

### Finding: Non-git worker + daemon auto-spawn could create parallel file conflicts
- **Severity**: P2
- **Persona**: Adversarial Reviewer
- **Confidence**: medium
- **File**: `/Users/admin/Documents/AI/agent better work/apex-manager/src/commands/worker.ts:145-152`
- **Description**: In non-git mode, `isolated = false` and `worktreePath = projectRoot`. If the daemon's `spawnUnblockedTasks` spawns multiple workers for different tasks, all of them will operate on the same directory (project root) without any git worktree isolation. Two workers modifying overlapping files will corrupt each other's work. The protocol boundary section says "only modify files relevant to your task" and "do NOT modify other Workers' files", but this is a soft instruction to an LLM agent, not an enforced filesystem boundary.
- **Evidence**: `worktreePath = projectRoot` for all non-git workers. The daemon has no concurrency guard specific to non-git mode. `maxWorkers = 3` in daemon means up to 3 workers could be modifying the same directory simultaneously.
- **Suggested fix**: In non-git mode, either (a) set `maxWorkers = 1` to prevent parallel file conflicts, or (b) create per-task subdirectories as a lightweight isolation mechanism, or (c) add a clear warning when spawning a second non-git worker. Option (a) is simplest and safest.

### Technique 4: Abuse Cases

### Finding: Malicious env var values could inject shell commands despite escaping
- **Severity**: P3
- **Persona**: Adversarial Reviewer
- **Confidence**: low
- **File**: `/Users/admin/Documents/AI/agent better work/apex-manager/src/worker/agent-adapter.ts:40-42`
- **Description**: The single-quote escape `val.replace(/'/g, "'\\''")` is the standard POSIX technique and is correct against direct shell injection via single-quoted strings. However, if the resulting command string is ever eval'd in a context other than a POSIX shell (e.g., passed to a non-POSIX shell, logged to a system that interprets escape sequences, or used in a double-quoted context by an intermediate layer), the escaping may be insufficient. This is a theoretical concern given the current tmux-based execution model, where the command is passed directly to `sh -c`.
- **Evidence**: The escaping is correct for the current use case. This finding is included for completeness as a defense-in-depth consideration.
- **Suggested fix**: No immediate fix needed. The current escaping is correct for POSIX shell. Document the assumption that the command runs in a POSIX-compatible shell.

---

## Concurrency Reviewer

### Finding: Daemon tick loop correctly handles new `exitedWithoutResult` state
- **Severity**: N/A (positive finding)
- **Persona**: Concurrency Reviewer
- **Confidence**: high
- **File**: `/Users/admin/Documents/AI/agent better work/apex-manager/src/daemon/daemon.ts:162-172`
- **Description**: The new `exitedWithoutResult` detection block (step 3b) follows the same pattern as the crash detection (step 3): check condition, notify, log, set `resultChecked = true` to prevent re-reporting. The `resultChecked` guard prevents duplicate notifications. The `lastHealth` update at line 193 now correctly includes `exitedWithoutResult`. No concurrency issues introduced.

### Finding: `discoverWorkers` initializes `exitedWithoutResult: false` correctly
- **Severity**: N/A (positive finding)
- **Persona**: Concurrency Reviewer
- **Confidence**: high
- **File**: `/Users/admin/Documents/AI/agent better work/apex-manager/src/daemon/daemon.ts:92`
- **Description**: New workers discovered by the daemon are initialized with `exitedWithoutResult: false` in their `lastHealth`. The tick loop will then compute the actual state from `checkWorkerHealth`. This is correct.

### Finding: No race in post-create send between meta write and terminal send
- **Severity**: P3
- **Persona**: Concurrency Reviewer
- **Confidence**: medium
- **File**: `/Users/admin/Documents/AI/agent better work/apex-manager/src/commands/worker.ts:214-223`
- **Description**: The post-create send happens at step 9 (lines 214-219), and the meta.json update with window_handle happens at step 10 (lines 222-223). If the process crashes between steps 9 and 10, meta.json will have `window_handle: null`, and the daemon will not be able to track this worker's terminal. This is a pre-existing concern (same ordering existed before), but the 3-second sleep increases the window of vulnerability.
- **Evidence**: The 3-second sleep between createWindow and meta update means there is a 3+ second window where meta.json has `window_handle: null` even though a window exists.
- **Suggested fix**: Move the meta.json write (step 10) to before the post-create send (step 9). The window handle is available immediately after `createWindow` returns, so writing meta first is safe and reduces the inconsistency window.

---

## Test Quality Reviewer

### Finding: No unit tests for `buildEnvPrefix`
- **Severity**: P2
- **Persona**: Test Quality Reviewer
- **Confidence**: high
- **File**: `/Users/admin/Documents/AI/agent better work/apex-manager/tests/worker/agent-adapter.test.ts`
- **Description**: `buildEnvPrefix` is a new exported function with shell escaping logic, but has no dedicated unit tests. The function handles single-quote escaping, empty values, skip lists, and the edge case of no matching env vars. All of these should be tested, especially the escaping logic which is security-relevant.
- **Evidence**: `buildEnvPrefix` does not appear in any test file.
- **Suggested fix**: Add tests for: (1) empty result when no env vars are set, (2) correct single-quote escaping for values containing single quotes, (3) skip parameter works, (4) multiple env vars produce space-separated output with trailing space, (5) env var names with special characters (defense test).

### Finding: No tests for `executionMode` or `needsPostCreateSend` adapter fields
- **Severity**: P2
- **Persona**: Test Quality Reviewer
- **Confidence**: high
- **File**: `/Users/admin/Documents/AI/agent better work/apex-manager/tests/worker/agent-adapter.test.ts`
- **Description**: The test file verifies adapter names, binaries, capabilities, interruptKeys, protocolInjection, and buildStartCommand. But the two new fields -- `executionMode` and `needsPostCreateSend` -- are not tested at all. These fields drive critical behavior: `executionMode` determines crash vs. expected-exit detection in the daemon, and `needsPostCreateSend` determines whether the protocol injection post-create path is taken.
- **Evidence**: Neither `executionMode` nor `needsPostCreateSend` appears in any test file.
- **Suggested fix**: Add a test block that verifies: (1) all builtin adapters have `executionMode === "persistent"`, (2) claude and ft-claude have `needsPostCreateSend === false`, (3) codex, gemini, opencode have `needsPostCreateSend === true`, (4) the "every adapter has all required fields" test already checks for these fields' existence but could be more explicit.

### Finding: No test for non-isolated protocol boundary section
- **Severity**: P3
- **Persona**: Test Quality Reviewer
- **Confidence**: high
- **File**: `/Users/admin/Documents/AI/agent better work/apex-manager/tests/worker/protocol-template.test.ts`
- **Description**: The `sectionBoundaries` function now has a branch for `isolated === false` that generates simpler "Work Boundaries" instead of "Git Boundaries". This new code path is not tested. The existing test `includes work boundaries section` checks for `worktree` in the output, which would fail for the non-isolated path (which says "Only modify files relevant to your task" instead).
- **Evidence**: No test calls `buildWorkerProtocol` with `isolated: false`.
- **Suggested fix**: Add tests for `buildWorkerProtocol(makeOpts({ isolated: false }))` that verify: (1) "Work Boundaries" or "工作边界" heading appears, (2) "Git Boundaries" heading does NOT appear, (3) no mention of worktree or branch restrictions.

### Finding: ft-claude adapter not tested in `buildStartCommand` or `protocolInjection` blocks
- **Severity**: P3
- **Persona**: Test Quality Reviewer
- **Confidence**: high
- **File**: `/Users/admin/Documents/AI/agent better work/apex-manager/tests/worker/agent-adapter.test.ts`
- **Description**: The `ft-claude` adapter was added to the registry and counted in the "has exactly 5 entries" test, but the `buildStartCommand` and `protocolInjection` describe blocks do not have specific tests for `ft-claude`. The "every adapter has all required fields" test covers structural completeness, but specific behavior (env prefix inclusion, --append-system-prompt-file flag) is not verified.
- **Evidence**: No test mentions `ft-claude` in `buildStartCommand` or `protocolInjection` describe blocks.
- **Suggested fix**: Add: (1) a `buildStartCommand` test verifying ft-claude includes env prefix and `--append-system-prompt-file`, (2) a `protocolInjection` test verifying ft-claude uses `system-prompt-file`.

---

## Summary of Findings

| # | Severity | Persona | Finding | Status |
|---|----------|---------|---------|--------|
| 1 | P1 | Security | `buildEnvPrefix` key not validated against shell metacharacters | Open |
| 2 | P2 | Security | API keys visible in command strings / tmux scrollback | Open |
| 3 | P2 | Security | `terminal.send()` uses raw tmux send-keys for text | Open |
| 4 | P2 | Correctness | Fixed 3-second delay for post-create send is fragile | Open |
| 5 | P2 | Adversarial | Post-create send assumes agents accept typed input immediately | Open (same root cause as #4) |
| 6 | P2 | Adversarial | Non-git parallel workers share project root without isolation | Open |
| 7 | P2 | Test Quality | No unit tests for `buildEnvPrefix` | Open |
| 8 | P2 | Test Quality | No tests for `executionMode` / `needsPostCreateSend` fields | Open |
| 9 | P3 | Correctness | Stale worktrees not warned about in non-git mode | Open |
| 10 | P3 | Correctness | `execution_mode` backward compat is correct (positive) | N/A |
| 11 | P3 | Correctness | All builtin adapters are persistent -- one-shot path is forward-looking | N/A |
| 12 | P3 | Adversarial | cmux-to-tmux fallback has no user warning | Open |
| 13 | P3 | Adversarial | Shell escaping correct for POSIX but theoretical risk in other contexts | N/A |
| 14 | P3 | Concurrency | Meta.json write ordering could be improved | Open |
| 15 | P3 | Test Quality | No test for non-isolated protocol boundary section | Open |
| 16 | P3 | Test Quality | ft-claude not individually tested in buildStartCommand/protocolInjection | Open |

**Positive findings**: TypeScript compiles cleanly (`tsc --noEmit` passes). All 63 tests pass (30 agent-adapter + 33 protocol-template). Backward compatibility for `execution_mode` is correctly handled via optional typing. The daemon tick loop changes are structurally sound with proper `resultChecked` guards. The non-git detection using `git rev-parse --git-dir` is reliable. The `cmdKill` and `cmdMerge` handling for non-git workers is correct.

**Verdict**: All 6 diagnosed bugs are addressed. The implementation quality is solid. The P1 finding (key validation in `buildEnvPrefix`) is a defense-in-depth issue with low immediate risk. The P2 findings around test coverage and the hardcoded 3-second delay are the most actionable items for the next iteration.
