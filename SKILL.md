# Apex Manager

Multi-agent orchestrator. Manages parallel Worker agents across tmux/cmux sessions.

Use when: orchestrating multiple AI agents working on different tasks in parallel.

## Activation

When `/apex-manager` is invoked, the current session becomes the **Plan Agent**.

## Quick Start

1. Discuss requirements with user
2. Split into tasks with dependency DAG
3. For each task, choose agent (claude/codex/gemini) + protocol (optional skill)
4. Kick off workers via `apex-manager worker spawn`
5. Start daemon: `apex-manager orch start`
6. Monitor progress, handle escalations, merge results

## Commands

| Command | Purpose |
|---------|---------|
| `apex-manager worker spawn <id> [--agent X] [--protocol Y]` | Start a worker |
| `apex-manager worker kill <id>` | Stop a worker |
| `apex-manager worker list` | List active workers |
| `apex-manager worker status <id>` | Check worker status |
| `apex-manager worker merge <id>` | Merge worker's branch |
| `apex-manager worker check` | Check available agents |
| `apex-manager orch start` | Start daemon |
| `apex-manager orch stop` | Stop daemon |
| `apex-manager orch status` | Daemon status |

## Role Definition

See `roles/manager.md` for the full Plan Agent protocol.

## Data Directory

All state in `.apex-manager/` — independent from `.apex/`.
