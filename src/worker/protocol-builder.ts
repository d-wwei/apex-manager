/**
 * Worker protocol builder.
 *
 * Assembles .worker-protocol.md from three layers:
 *   1. Task information (title, description, acceptance criteria, dependencies)
 *   2. Work protocol (optional — injected from a skill's SKILL.md)
 *   3. Communication rules (status/result/directive/escalation JSON + [PLAN-AGENT] prefix)
 *
 * When no --protocol skill is specified, the Worker runs "bare" — only task info
 * and communication rules, no work protocol.
 */

import { existsSync, readFileSync } from "fs";
import { basename, join } from "path";
import type { Task } from "../types/task.js";
import { resolveAdapterWithConfig, loadAgentsConfig } from "./agent-adapter.js";
import type { AgentCapabilities } from "./agent-adapter.js";

// ── Public types ──────────────────────────────────────────────────────

export interface ProtocolBuildOptions {
  task: Task;
  projectRoot: string;
  worktreePath: string;
  completedDeps: string[];
  agent?: string;
  protocol?: string;       // skill name (e.g. "apex-forge", "great-writer")
  crossModel?: boolean;
  /** false when running in a non-git repo without worktree isolation */
  isolated?: boolean;
}

export function workerProtocolRelativePath(taskId: string): string {
  return `.apex-manager/workers/${taskId}/worker-protocol.md`;
}

// ── Skill lookup ─────────────────────────────────────────────────────

const SKILL_SEARCH_PATHS = [
  join(process.env.HOME || "~", ".claude", "skills"),
  join(process.env.HOME || "~", ".codex", "skills"),
  join(process.env.HOME || "~", ".gemini", "skills"),
];

/**
 * Find a skill's SKILL.md across platform skill directories.
 * Returns the content string, or null if not found.
 */
export function findSkillContent(skillName: string): string | null {
  for (const base of SKILL_SEARCH_PATHS) {
    // Check <base>/<skill>/SKILL.md
    const skillMd = join(base, skillName, "SKILL.md");
    if (existsSync(skillMd)) {
      return readFileSync(skillMd, "utf-8");
    }
    // Check <base>/<skill>/skill/SKILL.md (nested layout like apex-forge)
    const nestedSkillMd = join(base, skillName, "skill", "SKILL.md");
    if (existsSync(nestedSkillMd)) {
      return readFileSync(nestedSkillMd, "utf-8");
    }
  }
  return null;
}

// ── Helpers ───────────────────────────────────────────────────────────

function extractCriteria(description: string): string {
  const marker = "Acceptance Criteria:";
  const idx = description.indexOf(marker);
  if (idx === -1) return description;
  return description.slice(idx + marker.length).trim();
}

function depsDisplay(deps: string[], lang: "zh" | "en"): string {
  if (deps.length > 0) return deps.join(", ");
  return lang === "en" ? "none" : "none (无)";
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function getLang(agent?: string): "zh" | "en" {
  if (agent) {
    const agents = loadAgentsConfig();
    const adapter = resolveAdapterWithConfig(agent, agents);
    return adapter.capabilities.preferredLanguage;
  }
  return "zh";
}

// ── Sections ──────────────────────────────────────────────────────────

function sectionTask(opts: ProtocolBuildOptions, lang: "zh" | "en"): string {
  const { task, completedDeps } = opts;
  const criteria = extractCriteria(task.description);

  if (lang === "en") {
    return `\
## Your Task

**Title**: ${task.title}

**Description**:
${task.description}

**Acceptance Criteria**:
${criteria}

**Dependencies completed**: ${depsDisplay(completedDeps, lang)}`;
  }

  return `\
## 你的任务

**Title**: ${task.title}

**Description**:
${task.description}

**Acceptance Criteria**:
${criteria}

**Dependencies completed**: ${depsDisplay(completedDeps, lang)}`;
}

function sectionWorkProtocol(skillContent: string, lang: "zh" | "en"): string {
  const header = lang === "en" ? "## Work Protocol" : "## 工作协议";
  return `${header}

The following protocol governs how you execute this task:

${skillContent}`;
}

function sectionAntiRecursion(lang: "zh" | "en"): string {
  if (lang === "en") {
    return `\
## Worker Boundaries

You are a **Worker Agent**. You execute the task assigned to you.
You do **NOT** spawn sub-Workers. You do **NOT** orchestrate other agents.
If the task exceeds your ability, write a \`blocked\` status explaining why,
and return control to the Plan Agent for re-splitting.`;
  }

  return `\
## Worker 边界

你是一个 **Worker Agent**。你执行分配给你的任务。
你**不会**派生子 Worker。你**不会**编排其他 Agent。
如果任务超出你的能力范围，写 \`blocked\` 状态说明原因，
交回给 Plan Agent 重新拆分。`;
}

// ── Communication tiers (unchanged from protocol-template) ──────────

function fullBashCommunication(
  task: Task, workersDir: string, projectRoot: string, lang: "zh" | "en",
): string {
  const projectRootSh = shellQuote(projectRoot);
  const statusPathSh = shellQuote(`${workersDir}/status.json`);
  const resultPathSh = shellQuote(`${workersDir}/result.json`);
  const claimBlock = `\
\`\`\`bash
cd ${projectRootSh} && apex-manager task claim ${task.id} --by ${task.id}
\`\`\``;
  const statusBlock = `\
\`\`\`bash
cat > ${statusPathSh} << 'APEX_EOF'
{
  "task_id": "${task.id}",
  "stage": "<current_stage>",
  "progress": "<description>",
  "last_activity": "<ISO timestamp>",
  "errors": []
}
APEX_EOF
\`\`\``;

  const resultBlock = `\
\`\`\`bash
cat > ${resultPathSh} << 'APEX_EOF'
{
  "task_id": "${task.id}",
  "verdict": "pass",
  "summary": "<what you accomplished>",
  "findings": [],
  "completed_at": "<ISO timestamp>",
  "branch": "apex-mgr/${task.id}",
  "commit": "<commit hash>"
}
APEX_EOF

cd ${projectRootSh} && apex-manager task complete ${task.id} --by ${task.id} --summary "<what you accomplished>"

# Optional: when you produced a reusable file artifact
cd ${projectRootSh} && apex-manager artifact submit ${task.id} --by ${task.id} --type report --path "<path-to-file>" --summary "<artifact summary>"
\`\`\``;

  const blockBlock = `\
\`\`\`bash
cd ${projectRootSh} && apex-manager task block ${task.id} --by ${task.id} --reason "<reason>"
\`\`\``;

  const header = lang === "en" ? "## Communication Protocol" : "## 通信协议";
  const intro = lang === "en"
    ? "You work in an isolated worktree. Report status to the main project:"
    : "你在独立的 worktree 中工作。需要向主项目报告状态:";
  const startH = lang === "en" ? "### At Start" : "### 开始时";
  const progressH = lang === "en" ? "### Progress Update (after each sub-task)" : "### 进度更新 (每完成一个子任务)";
  const completeH = lang === "en" ? "### On Completion" : "### 完成时";
  const blockedH = lang === "en" ? "### When Blocked" : "### 遇到阻塞时";

  return `${header}\n\n${intro}\n\n${startH}\n\n${claimBlock}\n\n${progressH}\n\n${statusBlock}\n\n${completeH}\n\n${resultBlock}\n\n${blockedH}\n\n${blockBlock}`;
}

function fileWriteCommunication(
  task: Task, workersDir: string, projectRoot: string, lang: "zh" | "en",
): string {
  const projectRootSh = shellQuote(projectRoot);
  const statusJson = `{
  "task_id": "${task.id}",
  "stage": "<current_stage>",
  "progress": "<description>",
  "last_activity": "<ISO timestamp>",
  "errors": []
}`;
  const resultJson = `{
  "task_id": "${task.id}",
  "verdict": "pass",
  "summary": "<what you accomplished>",
  "findings": [],
  "completed_at": "<ISO timestamp>",
  "branch": "apex-mgr/${task.id}",
  "commit": "<commit hash>"
}`;

  if (lang === "en") {
    return `\
## Communication Protocol

You work in an isolated worktree. Report status to the main project:

### At Start

Run:

- \`cd ${projectRootSh} && apex-manager task claim ${task.id} --by ${task.id}\`

### Progress Update (after each sub-task)

Write the following JSON to \`${workersDir}/status.json\`:

\`\`\`json
${statusJson}
\`\`\`

### On Completion

Write the following JSON to \`${workersDir}/result.json\`:

\`\`\`json
${resultJson}
\`\`\`

Then run:

- \`cd ${projectRootSh} && apex-manager task complete ${task.id} --by ${task.id} --summary "<what you accomplished>"\`

If you produced a reusable file, also run:

- \`cd ${projectRootSh} && apex-manager artifact submit ${task.id} --by ${task.id} --type report --path "<path-to-file>" --summary "<artifact summary>"\`

### When Blocked

Run: \`cd ${projectRootSh} && apex-manager task block ${task.id} --by ${task.id} --reason "<reason>"\``;
  }

  return `\
## 通信协议

你在独立的 worktree 中工作。需要向主项目报告状态:

### 开始时

运行:

- \`cd ${projectRootSh} && apex-manager task claim ${task.id} --by ${task.id}\`

### 进度更新 (每完成一个子任务)

将以下 JSON 写入 \`${workersDir}/status.json\`:

\`\`\`json
${statusJson}
\`\`\`

### 完成时

将以下 JSON 写入 \`${workersDir}/result.json\`:

\`\`\`json
${resultJson}
\`\`\`

然后运行:

- \`cd ${projectRootSh} && apex-manager task complete ${task.id} --by ${task.id} --summary "<what you accomplished>"\`

如果你产出了可复用文件，再额外运行:

- \`cd ${projectRootSh} && apex-manager artifact submit ${task.id} --by ${task.id} --type report --path "<path-to-file>" --summary "<artifact summary>"\`

### 遇到阻塞时

运行: \`cd ${projectRootSh} && apex-manager task block ${task.id} --by ${task.id} --reason "<reason>"\``;
}

function minimalCommunication(
  task: Task, workersDir: string, lang: "zh" | "en",
): string {
  const statusJson = `{
  "task_id": "${task.id}",
  "stage": "<current_stage>",
  "progress": "<description>",
  "last_activity": "<ISO timestamp>",
  "errors": []
}`;
  const resultJson = `{
  "task_id": "${task.id}",
  "verdict": "pass",
  "summary": "<what you accomplished>",
  "findings": [],
  "completed_at": "<ISO timestamp>",
  "branch": "apex-mgr/${task.id}",
  "commit": "<commit hash>"
}`;

  if (lang === "en") {
    return `\
## Communication Protocol

You work in an isolated worktree. Report status to the main project:

### Progress Update (after each sub-task)

Create file \`${workersDir}/status.json\` with content:

\`\`\`json
${statusJson}
\`\`\`

### On Completion

Create file \`${workersDir}/result.json\` with content:

\`\`\`json
${resultJson}
\`\`\`

### When Blocked

Create file \`${workersDir}/blocked.json\` with content:

\`\`\`json
{
  "task_id": "${task.id}",
  "reason": "<reason>"
}
\`\`\``;
  }

  return `\
## 通信协议

你在独立的 worktree 中工作。需要向主项目报告状态:

### 进度更新 (每完成一个子任务)

创建文件 \`${workersDir}/status.json\`，内容:

\`\`\`json
${statusJson}
\`\`\`

### 完成时

创建文件 \`${workersDir}/result.json\`，内容:

\`\`\`json
${resultJson}
\`\`\`

### 遇到阻塞时

创建文件 \`${workersDir}/blocked.json\`，内容:

\`\`\`json
{
  "task_id": "${task.id}",
  "reason": "<reason>"
}
\`\`\``;
}

export function sectionCommunicationForCapabilities(
  opts: { task: Task; projectRoot: string },
  lang: "zh" | "en",
  caps: AgentCapabilities,
): string {
  const { task, projectRoot } = opts;
  const workersDir = `${projectRoot}/.apex-manager/workers/${task.id}`;

  if (caps.canExecuteBash && caps.canRunApexCLI) {
    return fullBashCommunication(task, workersDir, projectRoot, lang);
  } else if (caps.canWriteFiles) {
    return fileWriteCommunication(task, workersDir, projectRoot, lang);
  } else {
    return minimalCommunication(task, workersDir, lang);
  }
}

function sectionCommunication(opts: ProtocolBuildOptions, lang: "zh" | "en"): string {
  const agents = loadAgentsConfig();
  const agentName = opts.agent ?? "claude";
  const adapter = resolveAdapterWithConfig(agentName, agents);
  return sectionCommunicationForCapabilities(
    { task: opts.task, projectRoot: opts.projectRoot },
    lang,
    adapter.capabilities,
  );
}

function sectionDirectiveCheck(opts: ProtocolBuildOptions, lang: "zh" | "en"): string {
  const { task, projectRoot } = opts;
  const workersDir = `${projectRoot}/.apex-manager/workers/${task.id}`;
  const agents = loadAgentsConfig();
  const agentName = opts.agent ?? "claude";
  const resolvedAdapter = resolveAdapterWithConfig(agentName, agents);
  const useBash = resolvedAdapter.capabilities.canExecuteBash;

  const escalationJson = `{ "task_id": "${task.id}", "type": "human_intervention", "stage": "<current_stage>", "summary": "${lang === "en" ? "Human user directly operated the terminal" : "人类用户直接操作了终端"}", "created_at": "<ISO timestamp>" }`;

  let escalationBlock: string;
  let directiveCheckBlock: string;
  let consumeBlock: string;

  if (useBash) {
    const escalationPathSh = shellQuote(`${workersDir}/escalation.json`);
    const directivePathSh = shellQuote(`${workersDir}/directive.json`);
    const consumedPathSh = `${shellQuote(`${workersDir}/directive`)}.$(date +%s).consumed.json`;
    escalationBlock = `\`\`\`bash\ncat > ${escalationPathSh} << 'APEX_EOF'\n${escalationJson}\nAPEX_EOF\n\`\`\``;
    directiveCheckBlock = `\`\`\`bash\ntest -f ${directivePathSh} && cat ${directivePathSh}\n\`\`\``;
    consumeBlock = `\`mv ${directivePathSh} ${consumedPathSh}\``;
  } else {
    escalationBlock = lang === "en"
      ? `Write the following JSON to \`${workersDir}/escalation.json\`:\n\n\`\`\`json\n${escalationJson}\n\`\`\``
      : `将以下 JSON 写入 \`${workersDir}/escalation.json\`:\n\n\`\`\`json\n${escalationJson}\n\`\`\``;
    directiveCheckBlock = lang === "en"
      ? `Check if \`${workersDir}/directive.json\` exists. If it does, read it.`
      : `检查 \`${workersDir}/directive.json\` 是否存在。如果存在，读取其内容。`;
    consumeBlock = lang === "en"
      ? `Rename \`${workersDir}/directive.json\` to \`${workersDir}/directive.consumed.json\``
      : `将 \`${workersDir}/directive.json\` 重命名为 \`${workersDir}/directive.consumed.json\``;
  }

  if (lang === "en") {
    return `\
## Plan Agent Communication Protocol

### Terminal Message Handling

When you receive a message starting with [PLAN-AGENT], it is a directive from the Plan Agent:
- \`[PLAN-AGENT]\` → Regular directive, read directive.json then continue
- \`[PLAN-AGENT:INTERRUPT]\` → Urgent directive, read directive.json immediately
- \`[PLAN-AGENT:RESUME]\` → Pause lifted, resume previous work

When you receive a message without the [PLAN-AGENT] prefix, it is a human user directly operating your terminal.
Respond to the user normally, but at the next stage boundary write an escalation:

${escalationBlock}

### Stage Boundary Check

After completing a stage of work, before starting the next:
Check whether directive.json exists:

${directiveCheckBlock}

If it exists:
- action: "amend" → Read the amendments, adjust subsequent work
- action: "pause" → Pause, wait for [PLAN-AGENT:RESUME]
- action: "abort" → Write result.json (verdict: "aborted"), exit
- action: "info" → Read supplementary information, continue work

After reading, rename: ${consumeBlock}`;
  }

  return `\
## Plan Agent 通信协议

### 终端消息处理

收到以 [PLAN-AGENT] 开头的消息时，这是来自 Plan Agent 的指令:
- \`[PLAN-AGENT]\` → 常规指令，读取 directive.json 后继续
- \`[PLAN-AGENT:INTERRUPT]\` → 紧急指令，立即读取 directive.json
- \`[PLAN-AGENT:RESUME]\` → 暂停已解除，继续之前的工作

收到不带 [PLAN-AGENT] 前缀的消息时，这是人类用户直接操作你的终端。
正常响应用户，但在下一个阶段边界写入 escalation:

${escalationBlock}

### 阶段边界检查

完成一个工作阶段后、开始下一个之前:
检查 directive.json 是否存在:

${directiveCheckBlock}

如果存在:
- action: "amend" → 读取修改内容，调整后续工作
- action: "pause" → 暂停，等待 [PLAN-AGENT:RESUME]
- action: "abort" → 写 result.json (verdict: "aborted")，退出
- action: "info" → 读取补充信息，继续工作

读取后重命名: ${consumeBlock}`;
}

function sectionBoundaries(opts: ProtocolBuildOptions, lang: "zh" | "en"): string {
  const { task } = opts;
  const isolated = opts.isolated !== false; // default true for backward compat

  if (!isolated) {
    // Non-git repo: no worktree isolation, simpler boundaries
    if (lang === "en") {
      return `\
## Work Boundaries

- Only modify files relevant to your task
- **Do NOT** modify other Workers' files or state
- **Do NOT** modify .apex-manager/ control files except status/result/escalation`;
    }
    return `\
## 工作边界

- 只修改与你的任务相关的文件
- **不要**修改其他 Worker 的文件或状态
- **不要**修改 .apex-manager/ 控制文件（status/result/escalation 除外）`;
  }

  if (lang === "en") {
    return `\
## Git Boundaries

- Only modify files within the worktree
- **Do NOT** modify files in the main project
- **Do NOT** modify other Workers' worktrees
- Git operations are limited to current branch (apex-mgr/${task.id})
- Commit to current branch, do not push to main/master`;
  }

  return `\
## Git 边界

- 只修改 worktree 内的文件
- **不要**修改主项目的代码文件
- **不要**修改其他 Worker 的 worktree
- Git 操作限于当前分支 (apex-mgr/${task.id})
- 提交代码到当前分支，不要 push 到 main/master`;
}

function sectionCrossModel(lang: "zh" | "en"): string {
  if (lang === "en") {
    return `\
## Cross-Model Independent Review

This is a cross-model independent review task. Multiple Agents with different models are reviewing the same code in parallel.

**Key Rules**:
- Produce your findings and conclusions independently, do not reference other Agents' results
- Report all issues you find honestly, even if you think they might be false positives
- Your result.json will be synthesized with other models' results for the final verdict
- Focus on: logic errors, security vulnerabilities, edge cases, race conditions`;
  }

  return `\
## 跨模型独立评审

这是一个跨模型独立评审任务。多个不同模型的 Agent 正在并行评审同一代码。

**关键规则**:
- 独立产出你的发现和结论，不要参考其他 Agent 的结果
- 如实报告你发现的所有问题，即使你认为它们可能是误报
- 你的 result.json 将与其他模型的结果合成最终裁决
- 重点关注: 逻辑错误、安全漏洞、边界条件、竞态条件`;
}

// ── Main builder ─────────────────────────────────────────────────────

const SAFE_TASK_ID = /^T\d+$/;

export function buildWorkerProtocol(opts: ProtocolBuildOptions): string {
  if (!SAFE_TASK_ID.test(opts.task.id)) {
    throw new Error(`Invalid task ID: ${opts.task.id}. Must match T{N} pattern.`);
  }
  const lang = getLang(opts.agent);

  const sections: string[] = [
    `# Apex-Manager Worker Agent — Task ${opts.task.id}`,
    sectionTask(opts, lang),
  ];

  // Inject skill protocol if specified
  if (opts.protocol) {
    const content = findSkillContent(opts.protocol);
    if (content) {
      sections.push(sectionWorkProtocol(content, lang));
    } else {
      const warning = lang === "en"
        ? `> **Warning**: Protocol skill "${opts.protocol}" not found. Running bare.`
        : `> **Warning**: 协议 skill "${opts.protocol}" 未找到。裸跑模式。`;
      sections.push(warning);
    }
  }

  // Always inject: anti-recursion, communication, directive check, boundaries
  sections.push(sectionAntiRecursion(lang));
  sections.push(sectionCommunication(opts, lang));
  sections.push(sectionDirectiveCheck(opts, lang));
  sections.push(sectionBoundaries(opts, lang));

  if (opts.crossModel) {
    sections.push(sectionCrossModel(lang));
  }

  return sections.join("\n\n") + "\n";
}

// ── Backward compat — generateWorkerProtocol alias ──────────────────

/** @deprecated Use buildWorkerProtocol instead */
export function generateWorkerProtocol(opts: ProtocolBuildOptions): string {
  return buildWorkerProtocol(opts);
}

// ── Agent start command ──────────────────────────────────────────────

export async function agentStartCommand(
  agent: string,
  worktreePath: string,
  protocolPath = workerProtocolRelativePath(basename(worktreePath)),
): Promise<string> {
  const agents = loadAgentsConfig();
  const adapter = resolveAdapterWithConfig(agent, agents);
  return adapter.buildStartCommand({
    worktreePath,
    protocolPath,
  });
}
