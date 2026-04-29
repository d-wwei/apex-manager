[English](README.md) | [中文](README.zh.md)

# Apex Manager

**Run multiple AI coding agents on the same codebase in parallel — each isolated in its own git worktree, integrated by a deterministic daemon, supervised by you.**

## Why This?

You're in a Claude Code session. You need a feature built, tests written, docs updated, and a security review done. Four tasks — should take 20 minutes with four agents instead of 2 hours with one.

So you open four terminals. Create four branches. Start four agents. Twenty minutes later, you've spent fifteen of those switching between terminals, resolving a merge conflict because T2 started before T1's branch was ready, re-running T3 because it worked against stale code, and wondering whether T4 finished or crashed.

The problem isn't the agents. They can code. The problem is coordination — and it scales worse than the work itself. Most multi-agent setups treat agents as collaborators sharing one workspace. Wrong model. Parallel agents need isolation, like workers on different floors of a construction site: own tools, own materials, own section, one foreman.

Apex Manager gives each agent an isolated git worktree. A deterministic daemon monitors progress, runs tests, merges clean work. You stay in the decision loop — not the coordination loop.

## What It Is

Apex Manager is a CLI tool built on a three-layer architecture:

- **Plan Agent** (you, in your current AI session) — designs tasks, makes decisions, handles failures
- **Daemon** (background Node.js process) — monitors workers, runs tests, merges passing branches, spawns dependent tasks
- **Workers** (isolated terminals) — each agent runs in its own git worktree with its own terminal window

Zero runtime dependencies. Pure TypeScript. Works with Claude, ft-claude, Codex, Gemini, and OpenCode out of the box — extensible to any CLI-based agent. Git repos get full worktree isolation; non-git projects work too (workers share the project root).

## Key Features

- **Git worktree isolation.** Each worker gets a real, independent copy of the codebase. No file conflicts, no half-committed states. When a worker finishes, its branch gets tested in a temp worktree and merged — cleanly.

- **Deterministic daemon.** The automation layer has zero AI. A 10-second tick loop checks worker health, runs integration tests, fast-forward merges passing branches, spawns unblocked tasks. Predictable. Auditable. Won't hallucinate a merge.

- **Multi-agent heterogeneity.** Assign Claude to architecture, Codex to implementation, Gemini to security review — in the same workflow. Agent-specific adapters handle the differences: binary paths, interrupt keys, protocol injection methods, capability profiles.

- **Skill/protocol injection.** Before a worker starts, Apex Manager discovers relevant skills from your agent's skill directory and injects them as work instructions. A worker doesn't just get a task — it gets a methodology.

- **Cross-model consensus.** Run the same task through multiple agents with `--cross-model`. Results are synthesized and deduplicated. For security audits, architecture reviews, or anything where a second opinion costs less than a missed bug.

- **Idle-aware team messaging.** Normal messages queue while a worker is busy. Urgent messages interrupt first, then inject safely. ACKs can be observed synchronously with `--wait-ack` or reconciled by the daemon in the background.

- **Event-sourced recovery.** Every task, artifact, message, and worker lifecycle update lands in `events.jsonl`, with `state.snapshot.json` rebuilt from that audit trail so the daemon can restart and recover context.

- **Cost tracking at task granularity.** Per-worker token accounting with model-specific pricing (Opus, Sonnet, Haiku). Budget warnings and hard limits. Know exactly what each parallel workstream costs.

## Before / After

| | Manual Multi-Agent | With Apex Manager |
|---|---|---|
| **Workspace** | Agents share one directory — file conflicts | Each agent gets an isolated git worktree |
| **Coordination** | You juggle terminals and branches | Daemon auto-monitors, auto-tests, auto-merges |
| **Integration** | Merge and pray tests pass | Tests run in temp worktree *before* merge to main |
| **Failure** | You notice something broke... eventually | Daemon captures terminal state, notifies you immediately |
| **Parallelism** | Theoretical — coordination overhead eats the gain | Real — agents are truly independent |
| **Agent diversity** | One agent type, or manual switching | Claude + Codex + Gemini on different tasks, same workflow |

## How It Works

### Architecture

```
┌─────────────────────────────────────────────────┐
│               Plan Agent (you)                   │
│     Task design · Decisions · Failure triage     │
└────────────────────┬────────────────────────────┘
                     │ apex-manager CLI
                     ▼
┌─────────────────────────────────────────────────┐
│              Daemon (background)                  │
│  10s tick: monitor → test → merge → spawn → notify│
└──┬──────────────┬──────────────┬────────────────┘
   │              │              │
   ▼              ▼              ▼
┌────────┐   ┌────────┐   ┌────────┐
│  T1    │   │  T2    │   │  T3    │
│ Claude │   │ Codex  │   │ Gemini │
│worktree│   │worktree│   │worktree│
└────────┘   └────────┘   └────────┘
```

**The Plan Agent** (your current AI session) handles judgment: what to build, how to respond to failures, when to change course. **The Daemon** handles automation: pure code, no AI, deterministic and auditable. **Workers** handle execution: each in an isolated terminal with its own git worktree.

No layer does another layer's job. Workers can't orchestrate. The daemon can't make judgment calls. You don't manually merge branches.

### Workflow

**Phase 1 — Kick off workers and daemon:**

```bash
apex-manager init
apex-manager worker spawn T1 --agent claude --protocol apex-forge
apex-manager worker spawn T2 --agent codex
apex-manager orch start
```

**Phase 2 — Monitor, adjust, intervene when needed:**

```bash
apex-manager orch status
apex-manager worker tell T1 "Please re-check the empty state before merging."
apex-manager worker inject T1 "Stop the current approach and use the new API shape." --urgent
apex-manager msg list --to T1 --status pending
apex-manager orch events --tail 20
apex-manager worker status T1      # read terminal output
apex-manager worker interrupt T1   # stop the agent
```

**Phase 3 — Daemon auto-merges passing work. Wrap up:**

```bash
apex-manager worker merge-all --strategy local
apex-manager orch stop
```

### Design Decisions

| Choice | Why |
|--------|-----|
| Git worktrees over branches | Real filesystem isolation — agents can't interfere with each other's uncommitted work |
| Deterministic daemon (no AI) | Merge decisions should come from test results, not LLM judgment |
| File-based IPC over network | Observable (read JSON to debug), fault-tolerant, no server to crash |
| Terminal multiplexer (tmux/cmux) | Direct screen reading for diagnostics, sendKey for interrupts — real control |
| Zero runtime dependencies | One `tsx` call and it runs. Nothing to install, nothing to break |

### File-Based IPC

All state flows through `.apex-manager/`:

```
.apex-manager/
├── config.yaml              # Settings
├── tasks.json               # Task DAG
├── events.jsonl             # Append-only team event journal
├── state.snapshot.json      # Rebuilt team kernel snapshot
├── artifacts/
│   └── index.json           # Generic artifact index
├── messages/
│   └── index.json           # Structured team messages
├── workers/
│   └── T1/
│       ├── meta.json        # Worktree path, branch, agent type
│       ├── status.json      # Worker's progress updates
│       ├── result.json      # Final verdict: pass / fail / blocked
│       ├── escalation.json  # Worker → Plan Agent questions
│       └── directive.json   # Plan Agent → Worker instructions
├── notifications/           # Daemon → Plan Agent queue
├── orch.lock                # Single-daemon guarantee
└── event-log.jsonl          # Legacy audit log mirror
```

## Quick Start

**Prerequisites:** Node.js >= 18, git, tmux (Linux) or cmux (macOS)

```bash
# 1. Clone
git clone <repo-url>
cd apex-manager && npm install

# 2. Initialize local state
npx tsx src/cli.ts init

# 3. Spawn a worker
npx tsx src/cli.ts worker spawn T1 --agent claude

# 4. Start the daemon
npx tsx src/cli.ts orch start

# 5. Check status
npx tsx src/cli.ts orch status
```

### CLI Reference

```bash
# Init
apex-manager init

# Task commands
apex-manager task create <title> [description...] [--depends <task-id>] [--agent <agent>] [--protocol <skill>] [--category <cat>]
apex-manager task list
apex-manager task status <task-id>
apex-manager task claim <task-id> [--by <worker-id>]
apex-manager task complete <task-id> [--by <worker-id>] [--summary <summary>] [--evidence <artifact-id>]
apex-manager task block <task-id> --reason <reason> [--by <worker-id>]

# Artifact commands
apex-manager artifact submit <task-id> --by <worker-id> --type <type> --path <path> --summary <summary>
apex-manager artifact list [task-id]
apex-manager artifact show <artifact-id>

# Messaging commands
apex-manager msg send <to> <body> [--from <sender>] [--kind <directive|question|info>] [--task <task-id>] [--priority <normal|urgent>] [--action <amend|pause|abort|info>] [--no-ack] [--wait-ack]
apex-manager msg send --from <sender> --to <target> --kind <kind> --body <text>
apex-manager msg list [--to <task-id>] [--status <pending|delivered|acked|ack_timeout|failed>]
apex-manager msg show <message-id>
apex-manager msg ack <message-id> [--by <worker-id>]

# Worker commands
apex-manager worker spawn <id> [--agent claude|codex|gemini|opencode] [--protocol <skill>] [--cross-model]
apex-manager worker kill <id>
apex-manager worker list
apex-manager worker status <id>
apex-manager worker interrupt <id>
apex-manager worker tell <id> <message> [--wait-ack]
apex-manager worker ask <id> <question> [--wait-ack]
apex-manager worker inject <id> <message> [--urgent]
apex-manager worker directive <id> <amend|pause|abort|info> <content> [--urgent]
apex-manager worker merge <id> [--strategy local|pr|squash]
apex-manager worker merge-all
apex-manager worker check           # available agents
apex-manager worker report          # cost report

# Daemon commands
apex-manager orch start [--force]
apex-manager orch stop
apex-manager orch status
apex-manager orch events [--tail <n>] [--type <event-type>]
apex-manager orch snapshot [--rebuild]
```

## Project Structure

```
apex-manager/
├── src/
│   ├── cli.ts                    # Entry point — command router
│   ├── commands/
│   │   ├── init.ts               # Project state initialization
│   │   ├── task.ts               # Task lifecycle commands
│   │   ├── artifact.ts           # Generic artifact commands
│   │   ├── msg.ts                # Structured team messaging
│   │   ├── worker.ts             # Worker lifecycle + messaging + merge
│   │   └── orch.ts               # Daemon lifecycle + lock management
│   ├── daemon/
│   │   ├── daemon.ts             # Tick loop: monitor → test → merge → spawn
│   │   ├── integrate.ts          # Test-in-worktree + fast-forward merge
│   │   └── notify.ts             # Plan Agent notification delivery
│   ├── worker/
│   │   ├── protocol-builder.ts   # Assembles work instructions per worker
│   │   ├── agent-adapter.ts      # Agent-specific CLI knowledge
│   │   ├── messages.ts           # Structured terminal message delivery
│   │   ├── idle.ts               # Idle / busy detection heuristics
│   │   ├── terminal.ts           # tmux / cmux abstraction
│   │   ├── monitor.ts            # Health checks + status reading
│   │   ├── cross-model.ts        # Multi-agent result synthesis
│   │   ├── cost.ts               # Budget tracking + alerts
│   │   └── proxy.ts              # Rate limit extraction
│   ├── types/
│   │   ├── config.ts             # Configuration schema + defaults
│   │   ├── task.ts               # Task model + status FSM
│   │   ├── artifact.ts           # Artifact metadata model
│   │   ├── message.ts            # Message metadata model
│   │   └── state.ts              # Event journal + snapshot model
│   └── utils/
│       ├── config.ts             # YAML config loader
│       ├── json.ts               # Atomic JSON read/write
│       ├── logger.ts             # Event logging
│       ├── events.ts             # Event journal + snapshot rebuild
│       └── project-state.ts      # Local state layout + defaults
├── roles/
│   └── manager.md                # Plan Agent role definition
├── SKILL.md                      # Skill activation guide
├── package.json
└── tsconfig.json
```

## License

MIT
