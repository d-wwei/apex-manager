---
name: money-come-to-eli
description: Launch the hidden Apex Manager war-room easter egg in a separate terminal window without blocking the current agent session.
---

# money-come-to-eli

When this skill is explicitly invoked:

1. Launch the hidden Apex Manager war-room in a separate terminal window.
2. Do not keep the current Claude Code or Codex session blocked by the dashboard.
3. Use the repo-local launcher so the command works even if the user's PATH has not refreshed yet.

Invocation:

- Claude Code: `/money-come-to-eli`
- Codex: `$money-come-to-eli` or select it from `/skills`

## Command

Run:

```bash
bash scripts/launch.sh
```

## Response Style

- If launch succeeds, reply with one short sentence confirming the war-room opened in a separate terminal window.
- If launch fails, reply with the error and include the manual fallback:

```bash
apex-manager orch Money-Come-To-Eli --foreground
```
