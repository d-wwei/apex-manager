---
name: Money-Come-To-Eli
description: Launch the hidden Apex Manager war-room easter egg in a separate terminal window without blocking the current agent session.
---

# Money-Come-To-Eli

When `/Money-Come-To-Eli` is invoked:

1. Launch the hidden Apex Manager war-room in a separate terminal window.
2. Do not keep the current Claude Code or Codex session blocked by the dashboard.
3. Use the repo-local launcher so the command works even if the user's PATH has not refreshed yet.

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
