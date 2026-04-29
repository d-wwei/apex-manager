---
name: apex-manager
description: Multi-agent orchestrator. Use when the current session should act as the Plan Agent for parallel worker agents across tmux/cmux sessions, with task splitting, worker spawning, daemon supervision, and merge orchestration.
argument-hint: "worker spawn <task-id> | orch start | task create <title> <description>"
---

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
5. Within 5-10 seconds, verify at least one worker surface or `apex-manager worker status <id>` so a fake launch is caught immediately
6. Start daemon: `apex-manager orch start`
7. Monitor progress, handle escalations, merge results

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

## Operating Rules

- Explicit user cleanup or operational instructions must be acted on; do not end with a no-op response.
- If you use a shell fallback inside a worker terminal, label the outcome clearly as shell fallback instead of attributing it to the target agent.
- Treat spawn success as provisional until you have a smoke-check result from the worker terminal or status command.

## Data Directory

All state in `.apex-manager/` — independent from `.apex/`.
