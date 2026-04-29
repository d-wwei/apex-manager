<!-- Synced with README.md as of 2026-04-15 -->

[English](README.md) | [中文](README.zh.md)

# Apex Manager

**多个 AI 编程 Agent 并行开发同一个代码仓库 —— 每个 Agent 独占一个 git worktree，确定性 daemon 负责集成，你只管决策。**

## 为什么做这个？

你开着 Claude Code，手头有四件事：写功能、写测试、更新文档、做安全审查。四个 Agent 并行，20 分钟搞定，比一个 Agent 干 2 小时强。

于是你开了四个终端，建了四个分支，启动四个 Agent。20 分钟后回头一看：15 分钟花在了切终端、解冲突、重跑任务上。T2 在 T1 的分支还没准备好时就开始了，T3 跑的是过时代码，T4 不知道是完成了还是挂了。

Agent 不是问题，它们会写代码。问题是协调 —— 而且协调的成本比干活本身涨得还快。大多数多 Agent 方案让 Agent 共享一个工作区，这个模型就是错的。并行 Agent 需要隔离，就像工地上不同楼层的工人：各有各的工具、各有各的材料、各干各的区域，一个工头统筹。

Apex Manager 给每个 Agent 一个独立的 git worktree。一个确定性的 daemon 在后台监控进度、跑测试、合并干净的代码。你留在决策位上 —— 而不是协调位上。

## 这是什么

Apex Manager 是一个 CLI 工具，基于三层架构：

- **Plan Agent**（你，当前的 AI 会话）—— 设计任务、做决策、处理故障
- **Daemon**（后台 Node.js 进程）—— 监控 Worker、跑测试、合并通过的分支、启动下游任务
- **Worker**（独立终端）—— 每个 Agent 在自己的 git worktree 和终端窗口中执行任务

零运行时依赖。纯 TypeScript。开箱支持 Claude、ft-claude、Codex、Gemini、OpenCode —— 可扩展到任何命令行 Agent。Git 仓库自动使用 worktree 隔离；非 Git 项目也能用（Worker 共享项目根目录）。

## 核心特性

- **Git worktree 隔离。** 每个 Worker 拿到一份真正独立的代码副本。没有文件冲突，没有半提交状态。Worker 完成后，它的分支在临时 worktree 里跑完测试再合并 —— 干净利落。

- **确定性 daemon。** 自动化层没有任何 AI。10 秒一次的 tick 循环：检查 Worker 健康状态、跑集成测试、fast-forward 合并通过的分支、启动解除阻塞的任务。可预测、可审计、不会幻觉出一个 merge。

- **多 Agent 异构。** Claude 做架构、Codex 做实现、Gemini 做安全审查 —— 在同一个工作流里。Agent 适配器处理差异：二进制路径、中断键、协议注入方式、能力画像。

- **Skill/协议注入。** Worker 启动前，Apex Manager 从 Agent 的 skill 目录发现相关技能并注入为工作指令。Worker 拿到的不只是任务描述 —— 而是一套方法论。

- **跨模型共识。** `--cross-model` 让同一个任务跑多个 Agent，结果自动综合去重。安全审查、架构评审 —— 多一个视角的成本远低于漏掉一个 bug。

- **空闲感知消息投递。** Worker 忙时，普通消息先排队；紧急消息先中断，再安全注入。ACK 既可以通过 `--wait-ack` 同步观察，也可以由 daemon 在后台自动收敛。

- **事件驱动恢复。** Task / Artifact / Message / Worker 的生命周期都会写入 `events.jsonl`，并反推 `state.snapshot.json`，这样 daemon 重启后能恢复团队上下文。

- **任务粒度的成本追踪。** 按 Worker 统计 Token 用量，按模型计价（Opus、Sonnet、Haiku）。预算预警和硬上限。每条并行工作流花了多少钱，一清二楚。

## 对比

| | 手动多 Agent | 用 Apex Manager |
|---|---|---|
| **工作区** | Agent 共享一个目录 —— 文件冲突 | 每个 Agent 独占一个 git worktree |
| **协调** | 你在终端和分支间来回切换 | Daemon 自动监控、自动测试、自动合并 |
| **集成** | 合并后祈祷测试还能过 | 先在临时 worktree 跑测试，*通过了*再合到 main |
| **故障** | 过一会儿才发现出了问题 | Daemon 抓取终端状态，立刻通知你 |
| **并行度** | 理论上并行 —— 协调开销吃掉收益 | 真正并行 —— Agent 之间完全独立 |
| **Agent 多样性** | 单一 Agent，或者手动切换 | Claude + Codex + Gemini 各干各的，同一个工作流 |

## 工作原理

### 架构

```
┌─────────────────────────────────────────────────┐
│               Plan Agent（你）                    │
│       任务设计 · 决策 · 故障处理                    │
└────────────────────┬────────────────────────────┘
                     │ apex-manager CLI
                     ▼
┌─────────────────────────────────────────────────┐
│              Daemon（后台进程）                     │
│  10s tick: 监控 → 测试 → 合并 → 启动 → 通知        │
└──┬──────────────┬──────────────┬────────────────┘
   │              │              │
   ▼              ▼              ▼
┌────────┐   ┌────────┐   ┌────────┐
│  T1    │   │  T2    │   │  T3    │
│ Claude │   │ Codex  │   │ Gemini │
│worktree│   │worktree│   │worktree│
└────────┘   └────────┘   └────────┘
```

**Plan Agent**（你的当前会话）负责判断：做什么、怎么应对故障、什么时候调整方向。**Daemon** 负责自动化：纯代码，没有 AI，确定性可审计。**Worker** 负责执行：各自在隔离的终端和 worktree 里干活。

三层各司其职。Worker 不能编排。Daemon 不做判断。你不手动合分支。

### 工作流

**阶段一 —— 启动 Worker 和 Daemon：**

```bash
apex-manager init
apex-manager worker spawn T1 --agent claude --protocol apex-forge
apex-manager worker spawn T2 --agent codex
apex-manager orch start
```

**阶段二 —— 监控、调整、必要时介入：**

```bash
apex-manager orch status
apex-manager worker tell T1 "合并前再检查一下 empty state。"
apex-manager worker inject T1 "停止当前方案，改用新的 API 结构。" --urgent
apex-manager msg list --to T1 --status pending
apex-manager orch events --tail 20
apex-manager worker status T1      # 读终端输出
apex-manager worker interrupt T1   # 中断 Agent
```

**阶段三 —— Daemon 自动合并通过的工作。收尾：**

```bash
apex-manager worker merge-all --strategy local
apex-manager orch stop
```

### 设计决策

| 选择 | 为什么 |
|------|--------|
| Git worktree 而非分支 | 真正的文件系统隔离 —— Agent 之间无法干扰对方未提交的修改 |
| 确定性 daemon（无 AI） | 合并决策应该来自测试结果，不是 LLM 的判断 |
| 文件 IPC 而非网络 | 可观测（读 JSON 就能调试）、容错、没有服务器会崩 |
| 终端复用器（tmux/cmux） | 直接读屏幕做诊断，sendKey 做中断 —— 真正的 Agent 控制 |
| 零运行时依赖 | 一条 `tsx` 命令就跑起来。不装东西，不坏东西 |

### 文件 IPC 协议

所有状态通过 `.apex-manager/` 流转：

```
.apex-manager/
├── config.yaml              # 配置
├── tasks.json               # 任务 DAG
├── events.jsonl             # 追加写入的团队事件账本
├── state.snapshot.json      # 从事件重建的 Team Kernel 快照
├── artifacts/
│   └── index.json           # 通用制品索引
├── messages/
│   └── index.json           # 结构化团队消息
├── workers/
│   └── T1/
│       ├── meta.json        # worktree 路径、分支、Agent 类型
│       ├── status.json      # Worker 的进度更新
│       ├── result.json      # 最终结论：pass / fail / blocked
│       ├── escalation.json  # Worker → Plan Agent 的提问
│       └── directive.json   # Plan Agent → Worker 的指令
├── notifications/           # Daemon → Plan Agent 通知队列
├── orch.lock                # 单 daemon 保证
└── event-log.jsonl          # 兼容保留的审计镜像
```

## 快速开始

**前置条件：** Node.js >= 18、git、tmux（Linux）或 cmux（macOS）

```bash
# 1. 克隆
git clone <repo-url>
cd apex-manager && npm install

# 2. 初始化本地状态
npx tsx src/cli.ts init

# 3. 启动一个 Worker
npx tsx src/cli.ts worker spawn T1 --agent claude

# 4. 启动 Daemon
npx tsx src/cli.ts orch start

# 5. 查看状态
npx tsx src/cli.ts orch status
```

### CLI 速查

```bash
# 初始化
apex-manager init

# Task 命令
apex-manager task create <title> [description...] [--depends <task-id>] [--agent <agent>] [--protocol <skill>] [--category <cat>]
apex-manager task list
apex-manager task status <task-id>
apex-manager task claim <task-id> [--by <worker-id>]
apex-manager task complete <task-id> [--by <worker-id>] [--summary <summary>] [--evidence <artifact-id>]
apex-manager task block <task-id> --reason <reason> [--by <worker-id>]

# Artifact 命令
apex-manager artifact submit <task-id> --by <worker-id> --type <type> --path <path> --summary <summary>
apex-manager artifact list [task-id]
apex-manager artifact show <artifact-id>

# 消息命令
apex-manager msg send <to> <body> [--from <sender>] [--kind <directive|question|info>] [--task <task-id>] [--priority <normal|urgent>] [--action <amend|pause|abort|info>] [--no-ack] [--wait-ack]
apex-manager msg send --from <sender> --to <target> --kind <kind> --body <text>
apex-manager msg list [--to <task-id>] [--status <pending|delivered|acked|ack_timeout|failed>]
apex-manager msg show <message-id>
apex-manager msg ack <message-id> [--by <worker-id>]

# Worker 命令
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
apex-manager worker check           # 检查可用 Agent
apex-manager worker report          # 成本报告

# Daemon 命令
apex-manager orch start [--force]
apex-manager orch stop
apex-manager orch status
apex-manager orch events [--tail <n>] [--type <event-type>]
apex-manager orch snapshot [--rebuild]
```

## 项目结构

```
apex-manager/
├── src/
│   ├── cli.ts                    # 入口 —— 命令路由
│   ├── commands/
│   │   ├── init.ts               # 项目状态初始化
│   │   ├── task.ts               # Task 生命周期命令
│   │   ├── artifact.ts           # 通用制品命令
│   │   ├── msg.ts                # 结构化团队消息
│   │   ├── worker.ts             # Worker 生命周期 + 消息 + 合并
│   │   └── orch.ts               # Daemon 生命周期 + 锁管理
│   ├── daemon/
│   │   ├── daemon.ts             # Tick 循环：监控 → 测试 → 合并 → 启动
│   │   ├── integrate.ts          # worktree 内测试 + fast-forward 合并
│   │   └── notify.ts             # Plan Agent 通知投递
│   ├── worker/
│   │   ├── protocol-builder.ts   # 为每个 Worker 组装工作指令
│   │   ├── agent-adapter.ts      # Agent 特定的 CLI 知识
│   │   ├── messages.ts           # 结构化终端消息投递
│   │   ├── idle.ts               # 空闲 / 忙碌检测启发式
│   │   ├── terminal.ts           # tmux / cmux 抽象层
│   │   ├── monitor.ts            # 健康检查 + 状态读取
│   │   ├── cross-model.ts        # 多 Agent 结果综合
│   │   ├── cost.ts               # 预算追踪 + 告警
│   │   └── proxy.ts              # 速率限制提取
│   ├── types/
│   │   ├── config.ts             # 配置 schema + 默认值
│   │   ├── task.ts               # 任务模型 + 状态机
│   │   ├── artifact.ts           # 制品元数据模型
│   │   ├── message.ts            # 消息元数据模型
│   │   └── state.ts              # 事件账本 + 快照模型
│   └── utils/
│       ├── config.ts             # YAML 配置加载
│       ├── json.ts               # 原子 JSON 读写
│       ├── logger.ts             # 事件日志
│       ├── events.ts             # 事件账本 + 快照重建
│       └── project-state.ts      # 本地状态布局 + 默认值
├── roles/
│   └── manager.md                # Plan Agent 角色定义
├── SKILL.md                      # Skill 激活指南
├── package.json
└── tsconfig.json
```

## License

MIT
