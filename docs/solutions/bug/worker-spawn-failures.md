# Worker Spawn Failures — All 5 Agents

**Category**: bug
**Date**: 2026-04-16
**Commit**: 0cbea40, c8d485f

## Context

apex-manager v0.1.0 首次在非 git 仓库中通过 tmux 派发 5 种 Agent (claude, ft-claude, codex, gemini, opencode) 执行任务。全部 5 个 Worker 失败，0 成功。

## Problem (Root Cause)

agent-adapter 层对各 Agent CLI 的行为假设系统性地错误。不是单一 bug，而是 5 个独立假设同时失败：

1. **假设 auth 自动继承**：tmux new-window 的子进程不继承 Plan Agent shell 的 `export` 变量（API key 等）
2. **假设 stdin pipe 能驱动持久进程**：`cat protocol | codex exec --full-auto` 是 one-shot 模式，sandbox 还限制写入 workdir 范围
3. **假设 -p 是交互式**：gemini `-p` 是非交互模式，执行后进程退出
4. **假设 -p 是 prompt**：opencode `-p` 实际是 `--password`
5. **假设 git worktree 总可用**：非 git 仓库中 `git worktree add` 失败，fallback `mkdir` 创建空目录

叠加一个监控层 bug：daemon 把正常退出（one-shot 模式 exit 0）误判为 crash。

## What Was Tried

- 直接 pipe stdin 给 codex/gemini → 失败：pipe EOF 后进程退出
- 通过 CLI flag 注入 protocol → 失败：gemini `-p` 导致一次性执行，opencode `-p` 是密码参数
- git worktree fallback 到 mkdir → 失败：空目录里没有项目文件，sandbox 阻止访问外部

## Solution

1. **env 转发**：新增 `buildEnvPrefix()` 把 auth env vars 拼成 shell prefix，prepend 到 claude/ft-claude 的启动命令
2. **交互式模式**：codex/gemini/opencode 全部改为交互式启动（去掉 exec/`-p`/run），protocol 通过 `terminal.send()` 延迟注入
3. **executionMode**：在 AgentAdapter 接口上加 `executionMode: "persistent" | "one-shot"` 和 `needsPostCreateSend: boolean`
4. **daemon 分类**：monitor 区分 `crashed` 和 `exitedWithoutResult`，daemon 对两者发不同通知
5. **非 git 检测**：spawn 时先跑 `git rev-parse --git-dir`，非 git 仓库直接用项目根目录，跳过 worktree

## Why It Worked

每个 fix 都是把一个错误假设替换为运行时检测 + 适配。不是 workaround，而是让 adapter 层真正理解各 Agent CLI 的行为契约。

## Generalized Pattern

**编排层对被编排工具的 CLI 行为不能做隐式假设。** 每个假设（auth 继承、stdin 模式、flag 语义、环境要求）都需要：
- 显式建模为 adapter 属性
- 有 fallback 路径
- 有运行时检测机制

这个模式适用于任何编排多个异构 CLI 工具的系统。

## Prevention

- 新增 Agent adapter 时必须填写 `executionMode` 和 `needsPostCreateSend`
- 非 git 环境在 CI 中应有测试覆盖
- 每个 adapter 的 `buildStartCommand` 应有端到端测试（不只是 string 匹配）
