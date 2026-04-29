[English](README.md) | [中文](README.zh.md)

# Apex Manager

`apex-manager` is a local, terminal-first multi-agent orchestrator.

It helps one "plan agent" session coordinate multiple worker agent CLIs on the same project, with:
- task creation and dependency tracking
- per-worker terminal sessions
- git worktree isolation when the project is a git repo
- structured manager-to-worker messaging
- daemon-based monitoring and recovery state
- artifact capture and event journaling

This README is intentionally grounded in the current codebase and CLI, not the roadmap.

## What It Does Today

Apex Manager currently provides a working local control plane around `.apex-manager/`.

Core capabilities:
- `init` creates the local state directory and default stores.
- `task` manages task creation, dependencies, claiming, completion, blocking, and updates.
- `worker spawn` creates a worker terminal, writes a per-worker protocol file, and verifies real launch activity before reporting success.
- `worker tell/ask/inject` sends structured messages with pending/delivered/acked tracking.
- `msg` exposes the underlying message store directly.
- `artifact` stores generic task outputs with metadata.
- `orch` runs the background daemon, shows status, prints recent events, and rebuilds snapshots.
- `--cross-model` can spawn the same task across multiple agents and later synthesize results.

Built-in agent defaults currently include:
- `claude`
- `ft-claude`
- `codex`
- `gemini`
- `opencode`

Custom agents can be added through `.apex-manager/agents.json`.

## Mental Model

There are three layers:

1. The plan agent
This is your current AI session. It decides what tasks exist and when to intervene.

2. The daemon
This is a local Node.js background loop. It monitors worker state, processes pending messages, records events, and manages orchestration lifecycle.

3. The workers
These are separate CLI agent sessions running in `tmux` or `cmux`, usually one per task.

The system is local-first. There is no central server.

## Requirements

- macOS or Linux
- Node.js 18+
- one terminal multiplexer available:
  - `tmux`, or
  - `cmux`
- git if you want true worktree isolation

Notes:
- If the current directory is not a git repo, workers fall back to shared project-root mode. That works, but there is no filesystem isolation between workers.
- On macOS, Apex Manager can operate through either `tmux` or `cmux`. In many real setups, `tmux` is the simpler baseline.

## Install

If you just want to run the CLI in this repo:

```bash
npm install
npx tsx src/cli.ts --help
```

If you want the shell command:

```bash
npm install
npm link
apex-manager --help
```

If you also want the local skill entry installed into agent runtimes:

```bash
./install.sh
```

That installer symlinks this repo into:
- `~/.agents/skills/apex-manager`
- `~/.claude/skills/apex-manager`
- `~/.codex/skills/apex-manager`
- `~/.gemini/skills/apex-manager`

## Quick Start

Initialize local state:

```bash
apex-manager init
```

Check which agent CLIs are available:

```bash
apex-manager worker check
```

Create a few tasks:

```bash
apex-manager task create "Build API" "Implement the endpoint and tests"
apex-manager task create "Review API" "Review the implementation" --depends T1 --agent codex
apex-manager task list
```

Spawn a worker:

```bash
apex-manager worker spawn T1 --agent claude
```

What happens on spawn:
- Apex Manager prepares the worker directory.
- If the repo is git-based, it creates a dedicated worktree.
- It writes `.apex-manager/workers/T1/worker-protocol.md`.
- It opens a worker terminal session.
- It injects the kickoff instruction.
- It verifies real activity such as `task claim`, `status.json`, or `result.json` before considering the launch successful.

Start the daemon:

```bash
apex-manager orch start
```

Check live state:

```bash
apex-manager worker list
apex-manager worker status T1
apex-manager orch status
apex-manager orch events --tail 20
```

Send manager messages:

```bash
apex-manager worker tell T1 "Please tighten the edge-case handling."
apex-manager worker ask T1 "Did you cover the empty input path?" --wait-ack
apex-manager worker inject T1 "Stop the current approach and switch to the new response shape." --urgent
```

Capture output:

```bash
apex-manager artifact submit T1 --by T1 --type report --path ./notes.md --summary "Implementation notes"
apex-manager artifact list T1
```

Wrap up:

```bash
apex-manager worker merge T1
apex-manager orch stop
```

## Command Surface

Top-level commands:

```bash
apex-manager init
apex-manager task ...
apex-manager worker ...
apex-manager artifact ...
apex-manager msg ...
apex-manager orch ...
```

Useful task commands:

```bash
apex-manager task create <title> [description...] [--depends <task-id>] [--agent <agent>] [--protocol <skill>] [--category <cat>]
apex-manager task list
apex-manager task status <task-id>
apex-manager task claim <task-id> [--by <worker-id>]
apex-manager task complete <task-id> [--by <worker-id>] [--summary <summary>] [--evidence <artifact-id>]
apex-manager task block <task-id> --reason <reason> [--by <worker-id>]
apex-manager task update <task-id> [--status <status>] [--agent <agent>] [--protocol <skill>]
```

Useful worker commands:

```bash
apex-manager worker spawn <task-id> [--agent <agent>] [--protocol <skill>] [--cross-model] [--dry-run]
apex-manager worker list
apex-manager worker status <task-id>
apex-manager worker interrupt <task-id>
apex-manager worker tell <task-id> <message> [--wait-ack]
apex-manager worker ask <task-id> <question> [--wait-ack]
apex-manager worker inject <task-id> <message> [--urgent]
apex-manager worker merge <task-id> [--strategy local|pr|squash]
apex-manager worker merge-all [--strategy local|pr|squash]
apex-manager worker report
apex-manager worker synthesize <task-id>
```

Useful daemon commands:

```bash
apex-manager orch start [--force]
apex-manager orch stop
apex-manager orch status
apex-manager orch events [--tail <n>] [--type <event-type>]
apex-manager orch snapshot [--rebuild]
```

Useful low-level message commands:

```bash
apex-manager msg send <to> <body> [--from <sender>] [--kind <directive|question|info>] [--priority <normal|urgent>] [--wait-ack]
apex-manager msg list [--to <task-id>] [--status <pending|delivered|acked|ack_timeout|failed>]
apex-manager msg show <message-id>
apex-manager msg ack <message-id> [--by <worker-id>]
```

## State Layout

All local state lives under `.apex-manager/`:

```text
.apex-manager/
├── config.yaml
├── agents.json
├── tasks.json
├── events.jsonl
├── event-log.jsonl
├── state.snapshot.json
├── orch.lock
├── orch.pid
├── workers/
├── worktrees/
├── artifacts/
│   └── index.json
├── messages/
│   └── index.json
└── notifications/
```

Important worker files:

```text
.apex-manager/workers/T1/
├── meta.json
├── worker-protocol.md
├── status.json
├── result.json
├── escalation.json
└── directive.json
```

## Current Behavior That Matters

These details are important in real use:

- Protocol files are per worker, not shared.
- Worker launch is not treated as successful just because a prompt is visible.
- Normal messages can remain `pending` while a worker is busy.
- Urgent messages can interrupt first and then inject.
- Message IDs and message-store writes are protected against concurrent write races.
- `tmux` workers outside an existing tmux session are opened in dedicated detached sessions so multiple GUI terminals do not all mirror the same shared window.
- `cross-model` spawn uses the same kickoff and launch-verification path as normal spawn.

## Known Limitations

- Idle detection is heuristic. If upstream agent CLIs change their UI significantly, the ready/busy checks may need to be updated.
- Non-git projects do not get safe isolation. Apex Manager will warn, but it cannot prevent parallel file conflicts in shared project-root mode.
- Sandbox restrictions from the host runtime can still block access to `tmux` sockets or terminal control. That is an environment constraint, not always an Apex Manager bug.
- Merge automation is local-CLI oriented. If your preferred workflow is GitHub PR-first, use `--strategy pr` where supported and verify the surrounding environment.

## Development

Install dependencies:

```bash
npm install
```

Run the CLI directly from source:

```bash
npx tsx src/cli.ts --help
```

Verify the repo:

```bash
npm run typecheck
npm test
```

## Scope

Apex Manager is not trying to be:
- a hosted multi-agent platform
- a generic browser UI
- a replacement for your agent CLI

It is a local orchestration layer around existing agent CLIs.
