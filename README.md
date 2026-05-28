[中文详细文档](README.zh.md) | [English CLI Docs](docs/reference/README.en.md)

# 4 层分工，手搓 Agent 蜂群，真正开启团队作战

别再让 AI 扮演 PM、架构师、程序员、测试，排着队做办公室过家家了。真正能打的 Agent 团队，不是“角色越多越专业”，而是一个 Plan Agent 抓全局，一群全链路 Worker 并行推进，再用独立评审工作模式和状态层把质量与秩序兜住。

## 多 Agent 最大的坑，不是模型不够强，而是分工分错了

很多人第一次做多 Agent，直觉都一样：

- 一个 Agent 写需求
- 一个 Agent 出设计
- 一个 Agent 写代码
- 一个 Agent 做测试

画成架构图，特别像一家小公司。问题也恰好出在这里。

人类团队需要岗位分工，是因为每个人的注意力、技能、时间都有限。LLM 不是。你让同一个模型上一秒写方案，下一秒补测试，第三秒做 code review，它并不会因为“跨岗”而元气大伤。真正让它变笨的，反而是一次次交接。

需求 Agent 交一份摘要给设计 Agent，设计 Agent 再交一份文档给开发 Agent。每一次传递，看起来都很正式，实际上都在压缩上下文。为什么这个方案成立，为什么那个方案被排除，哪里最脆弱，哪里只是临时妥协，最关键的判断往往都不会完整写进交接文档里。

结果就是：每个 Agent 看起来都在认真工作，整条流水线却越来越偏。

多 Agent 真正该解决的问题，从来不是“怎么把 AI 伪装成公司组织架构”，而是两件事：

1. 怎么让全局意图不丢。
2. 怎么让多个 Agent 在不互相踩踏的前提下并行推进。

这就是“手搓 Agent 蜂群”和“角色扮演流水线”的本质区别。

## Apex Manager 到底怎么拆团队

`apex-manager` 不是另一个“替代 Claude/Codex/Gemini 的超级 AI”。它是一个本地、终端优先的多 Agent 编排层，帮你把现有 CLI 真正组织成团队。

### 第一层：Plan Agent，负责全局，不负责代做

Plan Agent 持有完整意图，负责：

- 任务拆分
- 依赖排序
- 资源分配
- 过程纠偏
- 结果综合

它是队长，不是全队唯一写代码的人。

### 第二层：Worker，必须是完整工程师，不是角色碎片

真正出去干活的 Worker，应该能自己走完完整闭环：

- 理解任务
- 阅读上下文
- 制定方案
- 改代码或写文档
- 跑验证
- 自查风险
- 产出结果

只有这样，推理链才不会断。它知道自己为什么做出每一个取舍，也能在出问题时顺着自己的链路回溯。

### 第三层：验证层，职责是否定，不是接棒

这里我故意不用“Verification Agent 已经是内建一等角色”这种说法。更准确地说，验证应该是一种**独立评审工作模式**：你可以派一个或多个 Worker 去做专门的 review / audit / adversarial check，但它不是今天这版系统里被硬编码成官方角色名的东西。

这个模式最有价值的姿势只有一个：站在对抗面。

- 查漏边界条件
- 检查测试是否只覆盖 happy path
- 盯住安全、竞态、回归风险
- 对结果做交叉验证，而不是接棒继续生产

### 第四层：Daemon / State，负责把状态留在系统里

再强的 Agent 团队，只要状态全靠聊天窗口记忆，迟早失忆。

所以 `apex-manager` 把状态外化到 `.apex-manager/`，由 daemon 和事件账本维护秩序：

- 谁在运行，谁卡住了
- 哪条消息发出去了，谁确认了
- 哪个任务 claim 了，哪个完成了
- 哪些 artifact 已提交，哪些还待复核

## 我们和市面上多 Agent 工具，到底有什么不一样

### 1. 模型厂原生 team 功能，通常只能在自己的生态里玩

模型厂自己做出来的 team / subagent 体验通常很顺，但默认都是围绕自家 runtime、自家 CLI、自家会话模型来设计的。

如果你的真实工作流是：

- 这个任务让 Claude 跑
- 那个任务让 Codex 跑
- 另一个任务想接 Gemini 或自定义 CLI
- 还想用统一的任务、消息、artifact、状态账本把它们拉到一起

你需要的就不是某一家产品内部的 team 能力，而是一层**跨 CLI、跨模型、跨协议的外层编排层**。

`apex-manager` 从一开始就不是要做某个模型厂 team 功能的复刻版，而是做一个更外层的 Team Kernel：让 Claude、Codex、Gemini、OpenCode 这些异构 agent CLI，能在同一个项目里被统一调度。

### 2. 像 Paperclip 这类工具，产品重心更偏重控制面；我们更偏终端原生、本地优先

很多编排工具会把重点放在 dashboard、审批流、组织视图、活动流、多用户控制台这些能力上。

`apex-manager` 走的是另一条路：

- **纯终端、本地优先**
- **先把当前仓库里的协作跑通**
- **先把 worker worktree、消息、状态、daemon 收紧**
- **先让你今天就能在自己的 CLI 环境里多 agent 开工**

我们默认你本来就活在终端里，本来就在用 Claude/Codex/Gemini CLI，所以我们做的是它们上面那层最薄、最贴近工程现场的协作层。

### 3. 我们不是把终端做成终点，而是把它当成第一层 transport

`apex-manager` 现在是 terminal-first，但不是“只会终端”。

这条路线的重点是：

- 先把 Team Kernel 的语义做稳
- 让 task、message、artifact、event 这些核心对象先独立出来
- 今天先用本地终端把团队协作跑对
- 后面再往 MCP、A2A、ACP 这类互通层扩展

也就是说，今天它是：

- 本地
- 终端原生
- 跨 CLI
- 多 Worker 协作

以后它还可以在不推翻内核的前提下，继续往跨机器、跨进程、标准协议互通演进。

## 一个最小可跑的团队作战

```bash
apex-manager init
apex-manager task create "Build API" "Implement the endpoint and focused tests"
apex-manager task create "Audit API" "Adversarial review for edge cases" --depends T1 --agent codex
apex-manager worker spawn T1 --agent claude
apex-manager orch start
```

这背后真正发生的事是：

- Plan Agent 定义任务和依赖
- Worker T1 在自己的上下文里完成实现闭环
- daemon 在 T1 完成后再启动依赖它的 T2，避免手动绕过 DAG
- Worker T2 不接棒写功能，只作为独立评审任务包去挑问题
- daemon 持续记录状态、消息和事件，避免团队失联

如果项目是 git 仓库，每个 Worker 还能拿到独立 worktree。这样并行不是“大家一起改同一份目录赌运气”，而是有文件系统级隔离的。

如果 Plan Agent 自身运行在 tmux 里，worker 会复用当前窗口：Plan Agent 保持左侧主 pane，worker 在右侧上下平分排列。若从普通终端启动，会复用一个项目级 `apex-workers-*` tmux session，而不是每个 worker 弹一个新窗口。

默认不会给 worker CLI 自动加 `--full-auto`、`--yolo` 或 `--dangerously-skip-permissions`。确实需要完全自动批准时，显式设置 `APEX_MANAGER_ALLOW_AUTO_APPROVAL=1`。

## 快速开始

```bash
npm install
npm link
apex-manager init
apex-manager worker check
```

如果你想把仓库直接装成本地 skill：

```bash
./install.sh
```

## 详细文档

- 中文 CLI 说明见 [README.zh.md](README.zh.md)
- 英文 CLI 说明见 [docs/reference/README.en.md](docs/reference/README.en.md)
- 本文长文原稿见 [docs/posts/agent-swarm-team-battle.md](docs/posts/agent-swarm-team-battle.md)
