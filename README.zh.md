[仓库首页](README.md) | [English CLI Docs](docs/reference/README.en.md)

# Apex Manager

`apex-manager` 是一个本地、终端优先的多 Agent 编排器。

它的目标不是替代 Claude/Codex/Gemini 这些 CLI，而是在同一个项目里，让一个 plan agent 会话稳定地带多个 worker 干活，提供：
- 任务创建和依赖管理
- 每个 worker 独立终端会话
- git 仓库下的 worktree 隔离
- manager 到 worker 的结构化消息
- daemon 监控与恢复状态
- artifact 记录和事件账本

这份 README 只描述当前代码里真实存在的能力，不引用 roadmap 未来态。

## 现在到底能做什么

当前版本已经有一套可用的本地控制面，核心都落在 `.apex-manager/` 下面。

现在可用的能力：
- `init` 初始化本地状态目录和默认存储
- `task` 管任务创建、依赖、claim、complete、block、update
- `worker spawn` 启动 worker 终端、写 per-worker 协议文件，并在返回成功前验证它真的开始干活
- `worker tell/ask/inject` 发送结构化 manager 消息
- `msg` 直接查看和操作底层消息存储
- `artifact` 记录任务输出
- `orch` 启动 daemon、看状态、看事件、重建 snapshot
- `--cross-model` 对同一任务拉多个 agent，再综合结果

当前内置的默认 agent 包括：
- `claude`
- `ft-claude`
- `codex`
- `gemini`
- `opencode`

如果你有自己的 CLI，也可以通过 `.apex-manager/agents.json` 扩展。

## 怎么理解它

可以把它看成三层：

1. Plan Agent
就是你当前这个 AI 会话。它负责决定有哪些任务、什么时候调整、什么时候介入。

2. Daemon
本地 Node.js 后台循环。它负责监控 worker、处理 pending 消息、记录事件、维护编排生命周期。

3. Workers
真正执行任务的独立 CLI 会话，通常一个任务一个 worker，跑在 `tmux` 或 `cmux` 里。

这是一个本地优先系统，没有中心服务器。

## 运行前提

- macOS 或 Linux
- Node.js 18+
- 至少一个终端复用器：
  - `tmux`
  - 或 `cmux`
- 如果你想要真正的隔离，项目本身最好是 git 仓库

注意：
- 如果当前目录不是 git 仓库，worker 会退化到 shared project-root 模式。能跑，但多个 worker 共享同一目录，没有文件系统隔离。
- 在 macOS 上，`tmux` 和 `cmux` 都能用；很多情况下，先把 `tmux` 路径跑稳是更简单的基线。

## 安装

如果你只是想在这个仓库里直接运行 CLI：

```bash
npm install
npx tsx src/cli.ts --help
```

如果你想得到全局命令：

```bash
npm install
npm link
apex-manager --help
```

如果你还想把本地 skill 入口也装进去：

```bash
./install.sh
```

安装脚本会把当前仓库做成软链接，放到：
- `~/.agents/skills/apex-manager`
- `~/.claude/skills/apex-manager`
- `~/.codex/skills/apex-manager`
- `~/.gemini/skills/apex-manager`

## 快速开始

先初始化本地状态：

```bash
apex-manager init
```

先看哪些 agent CLI 当前可用：

```bash
apex-manager worker check
```

创建几个任务：

```bash
apex-manager task create "Build API" "Implement the endpoint and tests"
apex-manager task create "Review API" "Review the implementation" --depends T1 --agent codex
apex-manager task list
```

启动一个 worker：

```bash
apex-manager worker spawn T1 --agent claude
```

`spawn` 现在会做这些事：
- 准备 worker 目录
- 如果当前项目是 git 仓库，就创建独立 worktree
- 写 `.apex-manager/workers/T1/worker-protocol.md`
- 打开 worker 终端
- 注入 kickoff 指令
- 在返回成功前验证真实动作，比如 `task claim`、`status.json`、`result.json`

启动 daemon：

```bash
apex-manager orch start
```

查看实时状态：

```bash
apex-manager worker list
apex-manager worker status T1
apex-manager orch status
apex-manager orch events --tail 20
```

给 worker 发 manager 消息：

```bash
apex-manager worker tell T1 "Please tighten the edge-case handling."
apex-manager worker ask T1 "Did you cover the empty input path?" --wait-ack
apex-manager worker inject T1 "Stop the current approach and switch to the new response shape." --urgent
```

记录产物：

```bash
apex-manager artifact submit T1 --by T1 --type report --path ./notes.md --summary "Implementation notes"
apex-manager artifact list T1
```

收尾：

```bash
apex-manager worker merge T1
apex-manager orch stop
```

## 命令面

顶层命令：

```bash
apex-manager init
apex-manager task ...
apex-manager worker ...
apex-manager artifact ...
apex-manager msg ...
apex-manager orch ...
```

常用 task 命令：

```bash
apex-manager task create <title> [description...] [--depends <task-id>] [--agent <agent>] [--protocol <skill>] [--category <cat>]
apex-manager task list
apex-manager task status <task-id>
apex-manager task claim <task-id> [--by <worker-id>]
apex-manager task complete <task-id> [--by <worker-id>] [--summary <summary>] [--evidence <artifact-id>]
apex-manager task block <task-id> --reason <reason> [--by <worker-id>]
apex-manager task update <task-id> [--status <status>] [--agent <agent>] [--protocol <skill>]
```

常用 worker 命令：

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

常用 daemon 命令：

```bash
apex-manager orch start [--force]
apex-manager orch stop
apex-manager orch status
apex-manager orch events [--tail <n>] [--type <event-type>]
apex-manager orch snapshot [--rebuild]
```

常用底层消息命令：

```bash
apex-manager msg send <to> <body> [--from <sender>] [--kind <directive|question|info>] [--priority <normal|urgent>] [--wait-ack]
apex-manager msg list [--to <task-id>] [--status <pending|delivered|acked|ack_timeout|failed>]
apex-manager msg show <message-id>
apex-manager msg ack <message-id> [--by <worker-id>]
```

## 本地状态目录

所有本地状态都在 `.apex-manager/`：

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

一个 worker 目录大概长这样：

```text
.apex-manager/workers/T1/
├── meta.json
├── worker-protocol.md
├── status.json
├── result.json
├── escalation.json
└── directive.json
```

## 现在这些行为很重要

下面这些不是文案细节，而是当前真实行为：

- 协议文件现在是 per-worker 的，不再共用一个 `worker-protocol.md`
- `spawn` 不会因为“屏幕上出现了 prompt”就算成功
- 普通消息在 worker 忙时可能保持 `pending`
- 紧急消息会先中断，再尝试注入
- 消息编号和消息存储写入已经做了并发保护
- 在普通终端里走 `tmux` 时，每个 worker 会拿独立 detached session，不再让多个 GUI terminal 共用同一个可见窗口
- `cross-model` 路径和普通 `spawn` 现在共用同一套 kickoff 和 launch verification 逻辑

## 已知边界

- idle 检测本质上还是启发式。如果上游 agent CLI 大改界面，ready/busy 规则可能需要再调。
- 非 git 项目没有真正的隔离。Apex Manager 会明确警告，但没法从文件系统层面阻止并发冲突。
- 宿主运行环境的 sandbox 仍然可能阻止 `tmux` socket 或终端控制。这类问题很多时候是环境限制，不一定是 Apex Manager 逻辑 bug。
- merge 自动化偏本地 CLI 工作流；如果你的流程是 GitHub PR 优先，请结合 `--strategy pr` 和你自己的环境一起验证。

## 开发

安装依赖：

```bash
npm install
```

直接从源码跑 CLI：

```bash
npx tsx src/cli.ts --help
```

验证仓库：

```bash
npm run typecheck
npm test
```

## 它不是什么

Apex Manager 不是：
- 托管式多 Agent 平台
- 通用 Web 控制台
- 某个 agent CLI 的替代品

它是一个围绕现有 agent CLI 的本地编排层。
