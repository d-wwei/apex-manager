import { spawnSync } from "child_process";
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync } from "fs";
import { join, resolve } from "path";
import { readJSON, writeJSON } from "../utils/json.js";
import { buildWorkerProtocol, agentStartCommand } from "../worker/protocol-builder.js";
import { detectAdapter } from "../worker/terminal.js";
import type { Task, TaskStore } from "../types/task.js";
import type { ProtocolBuildOptions } from "../worker/protocol-builder.js";
import type { WorkerMeta, WorkerResult } from "../worker/monitor.js";
import { spawnCrossModel, parseCrossModelArgs, synthesizeResults } from "../worker/cross-model.js";
import { listWorkers, checkWorkerHealth, getMonitorReport } from "../worker/monitor.js";
import { formatCostReport, formatRateLimitStatus } from "../worker/cost.js";
import { readCostSummary, readRateLimit } from "../worker/proxy.js";
import { loadConfig } from "../utils/config.js";
import { checkAgent, checkAllAgents } from "../worker/capability-check.js";
import { loadAgentsConfig, resolveAdapterWithConfig } from "../worker/agent-adapter.js";
import { interruptKeys } from "../worker/interrupt.js";

// ── Helpers ──────────────────────────────────────────────────────────

export function toSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 20)
    .replace(/-+$/, "");
}

export async function resolveAgent(args: string[], task: Task): Promise<string> {
  // Priority: CLI --agent > task.agent > task.adapter > worker_agent_rules[category] > worker_default_agent > "claude"
  const idx = args.indexOf("--agent");
  if (idx >= 0 && args[idx + 1]) return args[idx + 1];
  if (task.agent) return task.agent;
  if (task.adapter) return task.adapter;
  try {
    const config = await loadConfig();
    if (config.worker_agent_rules && task.category) {
      const rule = config.worker_agent_rules.find(r => r.category === task.category);
      if (rule) return rule.agent;
    }
    if (config.worker_default_agent) return config.worker_default_agent;
  } catch { /* config unavailable — fall through */ }
  return "claude";
}

export function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  const days = Math.floor(hrs / 24);
  return `${days} days ago`;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function findTask(tasks: Task[], taskId: string): Task | undefined {
  return tasks.find((t) => t.id === taskId);
}

// WorkerMeta imported from ../worker/monitor.js

// ── spawn ────────────────────────────────────────────────────────────

async function cmdSpawn(args: string[]): Promise<void> {
  // First positional arg (not a flag, not the value after --agent) is the task ID
  const agentIdx = args.indexOf("--agent");
  const agentValueIdx = agentIdx >= 0 ? agentIdx + 1 : -1;
  const taskId = args.find((a, i) => !a.startsWith("--") && i !== agentValueIdx);
  if (!taskId) {
    console.error("Usage: apex-manager worker spawn <task-id> [--agent claude|codex|gemini] [--cross-model] [--dry-run]");
    process.exit(1);
  }

  // Cross-model: delegate to separate module and return early
  if (hasFlag(args, "--cross-model")) {
    const { agents } = parseCrossModelArgs(args);
    await spawnCrossModel(taskId, agents, args);
    return;
  }

  // 1. Read tasks
  const store = await readJSON<TaskStore>(".apex-manager/tasks.json", { tasks: [], next_id: 1 });
  const task = findTask(store.tasks, taskId);
  if (!task) {
    console.error(`Task ${taskId} not found in .apex-manager/tasks.json`);
    process.exit(1);
  }

  // 2. Resolve agent + adapter
  const agent = await resolveAgent(args, task);
  const isDryRun = hasFlag(args, "--dry-run");
  const configAgents = loadAgentsConfig();
  const agentAdapter = resolveAdapterWithConfig(agent, configAgents);

  // 3. Verify agent CLI is available (skip for dry-run — no terminal will be created)
  if (!isDryRun) {
    const binary = agentAdapter.binary;
    const check = await checkAgent(binary);
    if (!check.available) {
      console.error(`Agent CLI '${binary}' not found. Install it or use --agent to specify a different agent.`);
      process.exit(1);
    }
    if (check.issues.length > 0) {
      console.warn(`Agent '${agent}' warnings: ${check.issues.join("; ")}`);
    }
    if (check.version) {
      console.log(`Agent: ${agent} (${check.version})`);
    }
  }

  // 4. Create git worktree (or use project root for non-git repos)
  const projectRoot = process.cwd();
  const isGitRepo = spawnSync("git", ["rev-parse", "--git-dir"], { cwd: projectRoot, encoding: "utf-8" }).status === 0;

  let worktreeRel: string;
  let worktreePath: string;
  let branch: string;
  let isolated: boolean;

  if (isGitRepo) {
    worktreeRel = `.apex-manager/worktrees/${taskId}`;
    worktreePath = resolve(projectRoot, worktreeRel);
    branch = `apex-mgr/${taskId}`;
    isolated = true;

    if (!existsSync(worktreePath)) {
      // Try with -b (new branch)
      let result = spawnSync("git", ["worktree", "add", worktreeRel, "-b", branch]);
      if (result.status !== 0) {
        // Branch may already exist -- try without -b
        result = spawnSync("git", ["worktree", "add", worktreeRel, branch]);
        if (result.status !== 0) {
          console.error(`Failed to create git worktree for ${taskId}. Check git status.`);
          process.exit(1);
        }
      }
    }
  } else {
    // Non-git repo: no worktree isolation, work directly in project root
    console.warn(`[warn] Not a git repository — worker will run in project root (no isolation)`);
    worktreeRel = ".";
    worktreePath = projectRoot;
    branch = "";
    isolated = false;
  }

  // 5. Initialize worktree
  const worktreeApex = join(worktreePath, ".apex-manager");
  mkdirSync(worktreeApex, { recursive: true });

  // Run apex-manager init in worktree (best-effort)
  spawnSync("apex-manager", ["init"], { cwd: worktreePath });

  // Gather completed deps
  const completedDeps = store.tasks
    .filter((t) => task.depends_on.includes(t.id) && t.status === "done")
    .map((t) => t.id);

  const crossModel = hasFlag(args, "--cross-model");
  const opts: ProtocolBuildOptions = {
    task,
    projectRoot,
    worktreePath,
    completedDeps,
    crossModel,
    agent,
    isolated,
  };

  const protocol = buildWorkerProtocol(opts);
  const protocolPath = join(worktreeApex, "worker-protocol.md");
  writeFileSync(protocolPath, protocol);

  // 6. Write worker registration
  const workersDir = join(projectRoot, ".apex-manager", "workers", taskId);
  mkdirSync(workersDir, { recursive: true });

  const meta: WorkerMeta = {
    task_id: taskId,
    window_handle: null,
    worktree_path: worktreeRel,
    branch,
    started_at: new Date().toISOString(),
    agent,
    execution_mode: agentAdapter.executionMode,
  };

  await writeJSON(join(workersDir, "meta.json"), meta);

  // 7. Dry-run: print protocol and exit
  if (isDryRun) {
    console.log(`[dry-run] Protocol generated at ${protocolPath}`);
    console.log(`[dry-run] Agent: ${agent}, Worktree: ${worktreeRel}`);
    console.log(protocol);
    return;
  }

  // 8. Create terminal window
  const slug = toSlug(task.title);
  const windowName = `${taskId}-${slug}`;
  const command = await agentStartCommand(agent, worktreePath);

  const terminal = detectAdapter();
  const handle = await terminal.createWindow(windowName, command);

  // 9. Post-create protocol injection for agents that need it
  if (agentAdapter.needsPostCreateSend) {
    // Wait for agent CLI to start, then send the protocol read instruction
    await new Promise((r) => setTimeout(r, 3000));
    const relProtocol = ".apex-manager/worker-protocol.md";
    await terminal.send(handle, `Read the file ${relProtocol} and execute all tasks described in it. This is your complete work instruction.`);
  }

  // 10. Update meta with window handle
  meta.window_handle = handle;
  await writeJSON(join(workersDir, "meta.json"), meta);

  // 11. Print confirmation
  console.log(`Worker ${taskId} spawned in window ${windowName} (agent: ${agent}, worktree: ${worktreeRel})`);
}

// ── kill ─────────────────────────────────────────────────────────────

async function cmdKill(args: string[]): Promise<void> {
  const taskId = args[0];
  if (!taskId) {
    console.error("Usage: apex-manager worker kill <task-id>");
    process.exit(1);
  }

  const projectRoot = process.cwd();
  const metaPath = join(projectRoot, ".apex-manager", "workers", taskId, "meta.json");

  // 1. Read worker meta
  if (!existsSync(metaPath)) {
    console.error(`No worker found for ${taskId} (missing .apex-manager/workers/${taskId}/meta.json)`);
    process.exit(1);
  }

  let meta: WorkerMeta;
  try {
    meta = JSON.parse(readFileSync(metaPath, "utf-8"));
  } catch {
    console.error(`Failed to parse .apex-manager/workers/${taskId}/meta.json`);
    process.exit(1);
    return; // unreachable, satisfies TS
  }

  // 2. Close terminal window if handle exists
  if (meta.window_handle) {
    try {
      const adapter = detectAdapter();
      await adapter.close(meta.window_handle);
    } catch {
      // Window may already be closed -- proceed with cleanup
    }
  }

  // 3. Clean up worktree (skip for non-git workers)
  if (meta.branch) {
    const worktreeRel = meta.worktree_path || `.apex-manager/worktrees/${taskId}`;
    spawnSync("git", ["worktree", "remove", worktreeRel, "--force"]);
    spawnSync("git", ["branch", "-D", meta.branch]);
  }

  // 4. Remove worker directory
  const workersDir = join(projectRoot, ".apex-manager", "workers", taskId);
  rmSync(workersDir, { recursive: true, force: true });

  // 5. Print confirmation
  console.log(`Worker ${taskId} killed and cleaned up`);
}

// ── interrupt ───────────────────────────────────────────────────────

async function cmdInterrupt(args: string[]): Promise<void> {
  const taskId = args[0];
  if (!taskId) {
    console.error("Usage: apex-manager worker interrupt <task-id>");
    process.exit(1);
  }

  const projectRoot = process.cwd();
  const metaPath = join(projectRoot, ".apex-manager", "workers", taskId, "meta.json");

  if (!existsSync(metaPath)) {
    console.error(`Worker ${taskId} not found (missing meta.json)`);
    process.exit(1);
  }

  let meta: WorkerMeta;
  try {
    meta = JSON.parse(readFileSync(metaPath, "utf-8"));
  } catch {
    console.error(`Failed to parse .apex-manager/workers/${taskId}/meta.json`);
    process.exit(1);
    return;
  }

  if (!meta.window_handle) {
    console.error(`Worker ${taskId} has no terminal handle — cannot send interrupt`);
    process.exit(1);
  }

  const terminal = detectAdapter();
  const adapterName = terminal.name() as "cmux" | "tmux";
  // Read interrupt type from agent config; fall back to "esc" for unknown agents
  const agentsCfg = loadAgentsConfig();
  const interruptType = agentsCfg[meta.agent]?.interrupt ?? "esc";
  const keys = interruptKeys(interruptType, adapterName);

  for (const key of keys) {
    try {
      await terminal.sendKey(meta.window_handle, key);
    } catch (err) {
      console.error(`Failed to send key '${key}' to ${taskId}: ${err}`);
      process.exit(1);
    }
  }

  // Brief wait then check idle state
  await new Promise((r) => setTimeout(r, 2000));
  try {
    const screen = await terminal.readScreen(meta.window_handle, 5);
    if (isAgentIdle(screen, meta.agent)) {
      console.log(`Worker ${taskId} interrupted successfully`);
    } else {
      console.log(`Worker ${taskId}: interrupt sent. Check: apex-manager worker status ${taskId}`);
    }
  } catch {
    console.log(`Worker ${taskId}: interrupt keys sent`);
  }
}

function isAgentIdle(screen: string, agent: string): boolean {
  switch (agent) {
    case "claude":
      return screen.includes("\u276f") && !screen.includes("esc to interrupt");
    case "codex":
    case "gemini":
    default:
      return screen.includes("$") || screen.includes("\u276f");
  }
}

// ── directive ──────────────────────────────────────────────────────

const VALID_DIRECTIVE_ACTIONS = ["amend", "pause", "abort", "info"] as const;

export async function cmdDirective(args: string[]): Promise<void> {
  const taskId = args[0];
  const action = args[1];
  const contentParts = args.slice(2).filter(a => !a.startsWith("--"));
  const content = contentParts.join(" ");

  if (!taskId || !action || !content) {
    console.error("Usage: apex-manager worker directive <task-id> <action> <content>");
    console.error("  action: amend | pause | abort | info");
    process.exit(1);
  }

  if (!VALID_DIRECTIVE_ACTIONS.includes(action as any)) {
    console.error(`Invalid action '${action}'. Must be one of: ${VALID_DIRECTIVE_ACTIONS.join(", ")}`);
    process.exit(1);
  }

  const projectRoot = process.cwd();
  const workerDir = join(projectRoot, ".apex-manager", "workers", taskId);

  if (!existsSync(workerDir)) {
    console.error(`Worker ${taskId} not found (missing .apex-manager/workers/${taskId}/)`);
    process.exit(1);
  }

  const urgent = hasFlag(args, "--urgent");

  const directive = {
    from: "plan-agent",
    created_at: new Date().toISOString(),
    action,
    content: {
      description: content,
      urgency: urgent ? "high" : "normal",
    },
  };

  writeFileSync(join(workerDir, "directive.json"), JSON.stringify(directive, null, 2));
  console.log(`Directive written: ${action} → Worker ${taskId}${urgent ? " (urgent)" : ""}`);
}

// ── merge ───────────────────────────────────────────────────────────

type MergeStrategy = "local" | "pr" | "squash";

// WorkerResult imported from ../worker/monitor.js

function parseStrategy(args: string[]): MergeStrategy {
  const idx = args.indexOf("--strategy");
  if (idx >= 0 && args[idx + 1]) {
    const val = args[idx + 1];
    if (val === "local" || val === "pr" || val === "squash") return val;
    console.error(`Invalid strategy '${val}'. Must be local|pr|squash`);
    process.exit(1);
  }
  return "local";
}

export async function cmdMerge(args: string[]): Promise<void> {
  const stratIdx = args.indexOf("--strategy");
  const stratValueIdx = stratIdx >= 0 ? stratIdx + 1 : -1;
  const taskId = args.find((a, i) => !a.startsWith("--") && i !== stratValueIdx);
  if (!taskId) {
    console.error("Usage: apex-manager worker merge <task-id> [--strategy local|pr|squash]");
    process.exit(1);
  }

  const strategy = parseStrategy(args);
  const projectRoot = process.cwd();

  // 1. Read result.json — verify verdict
  const resultPath = join(projectRoot, ".apex-manager", "workers", taskId, "result.json");
  if (!existsSync(resultPath)) {
    console.error(`No result.json for ${taskId}. Worker must complete before merging.`);
    process.exit(1);
  }
  const result = await readJSON<WorkerResult | null>(resultPath, null);
  if (!result || result.verdict !== "pass") {
    console.error(`Cannot merge ${taskId}: verdict is '${result?.verdict ?? "missing"}', expected 'pass'`);
    process.exit(1);
  }

  // 2. Read meta.json — get branch and worktree
  const metaPath = join(projectRoot, ".apex-manager", "workers", taskId, "meta.json");
  if (!existsSync(metaPath)) {
    console.error(`No meta.json for ${taskId}`);
    process.exit(1);
  }
  const meta: WorkerMeta = JSON.parse(readFileSync(metaPath, "utf-8"));
  const branch = meta.branch;
  if (!branch) {
    console.error(`Cannot merge ${taskId}: worker was not isolated in a git worktree (non-git project).`);
    process.exit(1);
  }
  const worktreePath = resolve(projectRoot, meta.worktree_path);

  // 3. Read task title from tasks.json
  const store = await readJSON<TaskStore>(".apex-manager/tasks.json", { tasks: [], next_id: 1 });
  const task = findTask(store.tasks, taskId);
  const title = task?.title ?? taskId;

  // 4. Check for uncommitted changes
  if (existsSync(worktreePath)) {
    const status = spawnSync("git", ["-C", worktreePath, "status", "--porcelain"], { encoding: "utf-8" });
    if (status.stdout && status.stdout.trim().length > 0) {
      console.error(`Worktree for ${taskId} has uncommitted changes. Commit or stash first.`);
      process.exit(1);
    }
  }

  // 5. Execute merge strategy
  if (strategy === "local") {
    const merge = spawnSync("git", ["merge", branch, "--no-ff", "-m", `Merge ${taskId}: ${title}`]);
    if (merge.status !== 0) {
      console.error(`Merge conflict for ${taskId}. Resolve manually.`);
      process.exit(1);
    }
    spawnSync("git", ["worktree", "remove", meta.worktree_path, "--force"]);
    spawnSync("git", ["branch", "-d", branch]);
  } else if (strategy === "squash") {
    const merge = spawnSync("git", ["merge", "--squash", branch]);
    if (merge.status !== 0) {
      console.error(`Merge conflict for ${taskId}. Resolve manually.`);
      process.exit(1);
    }
    spawnSync("git", ["commit", "-m", `${taskId}: ${title}`]);
    spawnSync("git", ["worktree", "remove", meta.worktree_path, "--force"]);
    spawnSync("git", ["branch", "-d", branch]);
  } else {
    // strategy === "pr"
    spawnSync("git", ["push", "-u", "origin", branch], { cwd: worktreePath });
    const summary = result.summary ?? "";
    const pr = spawnSync("gh", ["pr", "create", "--title", `${taskId}: ${title}`, "--body", summary], {
      cwd: worktreePath,
      encoding: "utf-8",
    });
    if (pr.status !== 0) {
      console.error(`Failed to create PR for ${taskId}: ${pr.stderr}`);
      process.exit(1);
    }
    console.log(pr.stdout.trim());
  }

  console.log(`Merged ${taskId} via strategy '${strategy}'`);
}

// ── topological sort ────────────────────────────────────────────────

export function topoSort(taskIds: string[], tasks: Task[]): string[] {
  const taskMap = new Map(tasks.map((t) => [t.id, t]));
  const relevant = new Set(taskIds);
  const visited = new Set<string>();
  const sorted: string[] = [];

  function visit(id: string): void {
    if (visited.has(id) || !relevant.has(id)) return;
    visited.add(id);
    const t = taskMap.get(id);
    if (t) {
      for (const dep of t.depends_on) {
        visit(dep);
      }
    }
    sorted.push(id);
  }

  for (const id of taskIds) visit(id);
  return sorted;
}

// ── merge-all ───────────────────────────────────────────────────────

async function cmdMergeAll(args: string[]): Promise<void> {
  const strategy = parseStrategy(args);
  const projectRoot = process.cwd();

  // 1. Scan all workers with passing results
  const workersDir = join(projectRoot, ".apex-manager", "workers");
  if (!existsSync(workersDir)) {
    console.error("No workers directory found.");
    process.exit(1);
  }

  const entries = readdirSync(workersDir, { withFileTypes: true });
  const passing: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const rPath = join(workersDir, entry.name, "result.json");
    if (!existsSync(rPath)) continue;
    try {
      const r = JSON.parse(readFileSync(rPath, "utf-8"));
      if (r.verdict === "pass") passing.push(entry.name);
    } catch {
      // skip malformed
    }
  }

  if (passing.length === 0) {
    console.log("No workers with passing results to merge.");
    return;
  }

  // 2. Topological sort by dependency order
  const store = await readJSON<TaskStore>(".apex-manager/tasks.json", { tasks: [], next_id: 1 });
  const ordered = topoSort(passing, store.tasks);

  // 3. Merge each in order
  console.log(`Merging ${ordered.length} tasks in dependency order: ${ordered.join(", ")}`);
  for (const taskId of ordered) {
    try {
      await cmdMerge([taskId, "--strategy", strategy]);
    } catch (err) {
      console.error(`Stopped at ${taskId}: merge failed.`);
      process.exit(1);
    }
  }
}

// ── check ───────────────────────────────────────────────────────────

async function cmdCheck(): Promise<void> {
  const results = await checkAllAgents();
  const agents = loadAgentsConfig();
  console.log("Agent Status:");
  for (const [name, result] of Object.entries(results)) {
    const adapter = resolveAdapterWithConfig(name, agents);
    const status = result.available ? "\u2713 available" : "\u2717 not found";
    const version = result.version ?? "-";
    const protocol = adapter.protocolInjection.type === "none" && adapter.needsPostCreateSend
      ? "post-create-send" : adapter.protocolInjection.type;
    const interrupt = adapter.interruptKeys.join(", ");
    console.log(`  ${name.padEnd(10)} ${status.padEnd(15)} ${version.padEnd(20)} (protocol: ${protocol}, interrupt: ${interrupt})`);
    for (const issue of result.issues) {
      console.log(`             \u26a0 ${issue}`);
    }
  }
}

// ── Help ─────────────────────────────────────────────────────────────

function printHelp(): void {
  console.log(`
apex-manager worker — manage parallel worker agents

Usage:
  apex-manager worker spawn <task-id> [--agent claude|codex|gemini] [--cross-model] [--dry-run]
                                Spawn a worker agent for a task
  apex-manager worker kill <task-id>    Kill worker and clean up worktree
  apex-manager worker interrupt <task-id> Send interrupt signal to worker
  apex-manager worker directive <task-id> <action> <content> [--urgent]
                                Write directive.json (action: amend|pause|abort|info)
  apex-manager worker merge <task-id> [--strategy local|pr|squash]
                                Merge completed worker branch (default: local)
  apex-manager worker merge-all [--strategy local|pr|squash]
                                Merge all passing workers in dependency order
  apex-manager worker list              List all workers with status
  apex-manager worker status <task-id>  Show detailed worker status
  apex-manager worker report            Full report: workers + cost + rate limits
  apex-manager worker check              Check availability of all known agents
  apex-manager worker cost [task-id]    Show token/cost usage
  apex-manager worker synthesize <task-id>
                                Synthesize cross-model review results
`);
}

// ── Main dispatch ────────────────────────────────────────────────────

export async function cmdWorker(args: string[]): Promise<void> {
  const verb = args[0];

  switch (verb) {
    case "spawn":
      await cmdSpawn(args.slice(1));
      break;
    case "kill":
      await cmdKill(args.slice(1));
      break;
    case "interrupt":
      await cmdInterrupt(args.slice(1));
      break;
    case "directive":
      await cmdDirective(args.slice(1));
      break;
    case "merge":
      await cmdMerge(args.slice(1));
      break;
    case "merge-all":
      await cmdMergeAll(args.slice(1));
      break;
    case "check":
      await cmdCheck();
      break;
    case "list": {
      const workers = await listWorkers();
      if (workers.length === 0) {
        console.log("No workers registered.");
        break;
      }
      console.log("  ID         Agent      Stage        Status       Started");
      for (const w of workers) {
        const health = await checkWorkerHealth(w.meta.task_id);
        let status: string;
        if (health.completed) status = "completed";
        else if (health.crashed) status = "CRASHED";
        else if (health.exitedWithoutResult) status = "EXITED (no result)";
        else if (health.stale) status = "STALE";
        else if (health.alive) status = "running";
        else status = "unknown";
        const stage = w.status?.stage ?? "\u2014";
        const started = timeAgo(w.meta.started_at);
        console.log(
          `  ${w.meta.task_id.padEnd(9)}${w.meta.agent.padEnd(11)}${stage.padEnd(13)}${status.padEnd(13)}${started}`,
        );
      }
      break;
    }
    case "status": {
      const statusTaskId = args[1];
      if (!statusTaskId) {
        console.error("Usage: apex-manager worker status <task-id>");
        process.exit(1);
      }
      let health;
      try {
        health = await checkWorkerHealth(statusTaskId);
      } catch {
        console.error(`Worker ${statusTaskId} not found.`);
        process.exit(1);
        return;
      }
      const workers = await listWorkers();
      const info = workers.find((w) => w.meta.task_id === statusTaskId);
      if (!info) {
        console.error(`Worker ${statusTaskId} not found.`);
        process.exit(1);
        return;
      }
      let statusLabel: string;
      if (health.completed) statusLabel = "completed";
      else if (health.crashed) statusLabel = "CRASHED";
      else if (health.exitedWithoutResult) statusLabel = "EXITED (no result)";
      else if (health.stale) statusLabel = "STALE";
      else if (health.alive) statusLabel = "running";
      else statusLabel = "unknown";
      const lines: string[] = [
        `Worker ${statusTaskId} (${info.meta.agent})`,
        `  Stage: ${info.status?.stage ?? "\u2014"}`,
        `  Progress: ${info.status?.progress ?? "\u2014"}`,
        `  Health: ${statusLabel}`,
        `  Started: ${timeAgo(info.meta.started_at)}`,
      ];
      if (info.status?.last_activity) {
        lines.push(`  Last activity: ${timeAgo(info.status.last_activity)}`);
      }
      if (health.completed && info.result) {
        lines.push(`  Verdict: ${info.result.verdict}`);
        lines.push(`  Summary: ${info.result.summary}`);
      }
      if (health.screenTail) {
        lines.push("  Terminal tail:");
        for (const l of health.screenTail.split("\n").slice(-5)) {
          lines.push(`    > ${l}`);
        }
      }
      console.log(lines.join("\n"));
      break;
    }
    case "report": {
      const monitorReport = await getMonitorReport();
      console.log("=== Worker Report ===");
      console.log(monitorReport);
      console.log("\n=== Cost Summary ===");
      const costSummary = await readCostSummary();
      console.log(formatCostReport(costSummary));
      console.log("\n=== Rate Limit ===");
      const rateLimit = await readRateLimit();
      console.log(formatRateLimitStatus(rateLimit));
      break;
    }
    case "synthesize": {
      const synthTaskId = args[1];
      if (!synthTaskId) {
        console.error("Usage: apex-manager worker synthesize <task-id>");
        process.exit(1);
      }
      await synthesizeResults(synthTaskId);
      break;
    }
    case "cost": {
      const costTaskId = args[1];
      const summary = await readCostSummary();
      if (costTaskId && summary.by_task[costTaskId]) {
        const t = summary.by_task[costTaskId];
        console.log(`${costTaskId}: $${t.total_cost_usd.toFixed(4)}  (input: ${t.total_input_tokens}, output: ${t.total_output_tokens}, ${t.request_count} calls)`);
      } else {
        console.log(formatCostReport(summary));
      }
      break;
    }
    case "help":
    default:
      printHelp();
      break;
  }
}
