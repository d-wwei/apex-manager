import { existsSync, mkdirSync, readFileSync, renameSync } from "fs";
import { join } from "path";
import { readJSON, writeJSON } from "../utils/json.js";
import type { Task, TaskStatus, TaskStore } from "../types/task.js";
import { ALLOWED_TRANSITIONS } from "../types/task.js";
import { recordKernelEvent } from "../utils/events.js";
import { ensureProjectLayout } from "../utils/project-state.js";
import { adapterForHandle } from "../worker/terminal.js";
import type { WorkerMeta } from "../worker/monitor.js";

// ── Helpers ──────────────────────────────────────────────────────────

function projectRoot(): string {
  return process.cwd();
}

function storePath(): string {
  return join(projectRoot(), ".apex-manager", "tasks.json");
}

async function loadStore(): Promise<TaskStore> {
  ensureProjectLayout();
  return readJSON<TaskStore>(storePath(), { tasks: [], next_id: 1 });
}

async function saveStore(store: TaskStore): Promise<void> {
  mkdirSync(join(projectRoot(), ".apex-manager"), { recursive: true });
  await writeJSON(storePath(), store);
}

function findTask(store: TaskStore, id: string): Task | undefined {
  return store.tasks.find((t) => t.id === id);
}

function flagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : undefined;
}

function flagValues(args: string[], flag: string): string[] {
  const values: string[] = [];
  let idx = args.indexOf(flag);
  while (idx >= 0) {
    if (args[idx + 1] && !args[idx + 1].startsWith("--")) {
      values.push(args[idx + 1]);
    }
    idx = args.indexOf(flag, idx + 1);
  }
  return values;
}

// ── create ───────────────────────────────────────────────────────────

async function cmdCreate(args: string[]): Promise<void> {
  // Positional args: <title> <description>
  // Flags: --depends T1 T2, --agent claude, --protocol apex-forge, --category backend
  const positional = args.filter((a, i) => {
    if (a.startsWith("--")) return false;
    // Skip values that follow flags
    const prev = args[i - 1];
    if (prev && prev.startsWith("--")) return false;
    return true;
  });

  const title = positional[0];
  const description = positional.slice(1).join(" ");

  if (!title) {
    console.error("Usage: apex-manager task create <title> <description> [--depends T1 --depends T2] [--agent claude] [--protocol apex-forge] [--category backend]");
    process.exit(1);
  }

  const store = await loadStore();

  const id = `T${store.next_id}`;
  const now = new Date().toISOString();
  const depends = flagValues(args, "--depends");
  const agent = flagValue(args, "--agent");
  const protocol = flagValue(args, "--protocol");
  const category = flagValue(args, "--category");

  // Validate dependencies exist
  for (const dep of depends) {
    if (!findTask(store, dep)) {
      console.error(`Dependency ${dep} not found in task store`);
      process.exit(1);
    }
  }

  const task: Task = {
    id,
    title,
    description: description || title,
    status: "open",
    depends_on: depends,
    blocked_by: [],
    evidence: [],
    artifacts: [],
    created_at: now,
    updated_at: now,
    ...(agent ? { agent } : {}),
    ...(protocol ? { protocol } : {}),
    ...(category ? { category } : {}),
  };

  store.tasks.push(task);
  store.next_id++;
  await saveStore(store);
  await recordKernelEvent({
    type: "task.created",
    timestamp: task.created_at,
    task: { ...task },
  });

  console.log(`${id}: ${title}`);
}

// ── list ─────────────────────────────────────────────────────────────

async function cmdList(): Promise<void> {
  const store = await loadStore();

  if (store.tasks.length === 0) {
    console.log("No tasks.");
    return;
  }

  console.log("  ID         Status        Agent       Title");
  for (const t of store.tasks) {
    const agent = t.agent ?? "-";
    console.log(
      `  ${t.id.padEnd(9)}${t.status.padEnd(14)}${agent.padEnd(12)}${t.title}`,
    );
    if (t.depends_on.length > 0) {
      console.log(`             deps: ${t.depends_on.join(", ")}`);
    }
  }
}

// ── status ───────────────────────────────────────────────────────────

async function cmdStatus(args: string[]): Promise<void> {
  const taskId = args[0];
  if (!taskId) {
    console.error("Usage: apex-manager task status <task-id>");
    process.exit(1);
  }

  const store = await loadStore();
  const task = findTask(store, taskId);
  if (!task) {
    console.error(`Task ${taskId} not found`);
    process.exit(1);
  }

  const lines: string[] = [
    `Task ${task!.id}: ${task!.title}`,
    `  Status: ${task.status}`,
    `  Description: ${task.description}`,
  ];

  if (task.depends_on.length > 0) {
    lines.push(`  Depends on: ${task.depends_on.join(", ")}`);
  }
  if (task.agent) lines.push(`  Agent: ${task.agent}`);
  if (task.protocol) lines.push(`  Protocol: ${task.protocol}`);
  if (task.category) lines.push(`  Category: ${task.category}`);
  if (task.branch) lines.push(`  Branch: ${task.branch}`);
  if (task.block_reason) lines.push(`  Block reason: ${task.block_reason}`);
  if (task.evidence.length > 0) {
    lines.push(`  Evidence: ${task.evidence.join(", ")}`);
  }
  if (task.artifacts && task.artifacts.length > 0) {
    lines.push(`  Artifacts: ${task.artifacts.join(", ")}`);
  }
  if (task.claimed_by) lines.push(`  Claimed by: ${task.claimed_by}`);
  if (task.completed_by) lines.push(`  Completed by: ${task.completed_by}`);
  if (task.completion_summary) lines.push(`  Completion summary: ${task.completion_summary}`);
  lines.push(`  Created: ${task.created_at}`);
  lines.push(`  Updated: ${task.updated_at}`);
  if (task.completed_at) lines.push(`  Completed: ${task.completed_at}`);

  console.log(lines.join("\n"));
}

// ── update ───────────────────────────────────────────────────────────

async function cmdUpdate(args: string[]): Promise<void> {
  const taskId = args[0];
  if (!taskId) {
    console.error("Usage: apex-manager task update <task-id> [--status <status>] [--agent <agent>] [--protocol <protocol>] [--block-reason <reason>]");
    process.exit(1);
  }

  const store = await loadStore();
  const task = findTask(store, taskId);
  if (!task) {
    console.error(`Task ${taskId} not found`);
    process.exit(1);
  }

  const newStatus = flagValue(args, "--status") as TaskStatus | undefined;
  const agent = flagValue(args, "--agent");
  const protocol = flagValue(args, "--protocol");
  const blockReason = flagValue(args, "--block-reason");
  const addEvidence = flagValues(args, "--evidence");

  // Validate status transition
  if (newStatus) {
    const allowed = ALLOWED_TRANSITIONS[task.status];
    if (!allowed.includes(newStatus)) {
      console.error(`Cannot transition ${taskId} from '${task.status}' to '${newStatus}'. Allowed: ${allowed.join(", ") || "none"}`);
      process.exit(1);
    }
    task.previous_status = task.status;
    task.status = newStatus;
    if (newStatus === "done") {
      task.completed_at = new Date().toISOString();
    }
    if (newStatus === "blocked" && blockReason) {
      task.block_reason = blockReason;
    }
  }

  if (agent) task.agent = agent;
  if (protocol) task.protocol = protocol;
  if (addEvidence.length > 0) {
    task.evidence.push(...addEvidence);
  }

  task.updated_at = new Date().toISOString();
  await saveStore(store);
  await recordKernelEvent({
    type: "task.updated",
    timestamp: task.updated_at,
    reason: "update",
    task: { ...task },
  });

  console.log(`${taskId} updated (status: ${task.status})`);
}

async function cmdClaim(args: string[]): Promise<void> {
  const taskId = args[0];
  const by = flagValue(args, "--by");

  if (!taskId) {
    console.error("Usage: apex-manager task claim <task-id> [--by <worker-id>]");
    process.exit(1);
  }

  const store = await loadStore();
  const task = findTask(store, taskId);
  if (!task) {
    console.error(`Task ${taskId} not found`);
    process.exit(1);
  }

  if (!(task.status === "open" || task.status === "assigned")) {
    console.error(`Cannot claim ${taskId} from status '${task.status}'`);
    process.exit(1);
  }

  task.previous_status = task.status;
  task.status = "in_progress";
  task.claimed_by = by ?? task.claimed_by;
  task.claimed_at = new Date().toISOString();
  task.updated_at = task.claimed_at;
  await saveStore(store);
  await recordKernelEvent({
    type: "task.updated",
    timestamp: task.updated_at,
    reason: "claim",
    task: { ...task },
  });

  console.log(`${taskId} claimed`);
}

async function cmdComplete(args: string[]): Promise<void> {
  const taskId = args[0];
  const by = flagValue(args, "--by");
  const summary = flagValue(args, "--summary");
  const evidence = flagValues(args, "--evidence");

  if (!taskId) {
    console.error("Usage: apex-manager task complete <task-id> [--by <worker-id>] [--summary <summary>] [--evidence <artifact-id>]");
    process.exit(1);
  }

  const store = await loadStore();
  const task = findTask(store, taskId);
  if (!task) {
    console.error(`Task ${taskId} not found`);
    process.exit(1);
  }

  if (!(task.status === "in_progress" || task.status === "to_verify")) {
    console.error(`Cannot complete ${taskId} from status '${task.status}'`);
    process.exit(1);
  }
  if (task.claimed_by && by !== task.claimed_by) {
    console.error(`Cannot complete ${taskId}: --by must match claimed worker '${task.claimed_by}'`);
    process.exit(1);
  }

  task.previous_status = task.status;
  task.status = "done";
  task.completed_at = new Date().toISOString();
  task.updated_at = task.completed_at;
  task.completed_by = by ?? task.completed_by;
  task.completion_summary = summary ?? task.completion_summary;
  if (evidence.length > 0) {
    task.evidence.push(...evidence);
  }
  await saveStore(store);
  await recordKernelEvent({
    type: "task.updated",
    timestamp: task.updated_at,
    reason: "complete",
    task: { ...task },
  });

  console.log(`${taskId} completed`);
}

async function cmdBlock(args: string[]): Promise<void> {
  const taskId = args[0];
  const by = flagValue(args, "--by");
  const reason = flagValue(args, "--reason");

  if (!taskId || !reason) {
    console.error("Usage: apex-manager task block <task-id> --reason <reason> [--by <worker-id>]");
    process.exit(1);
  }

  const store = await loadStore();
  const task = findTask(store, taskId);
  if (!task) {
    console.error(`Task ${taskId} not found`);
    process.exit(1);
  }

  if (task.status === "done") {
    console.error(`Cannot block completed task ${taskId}`);
    process.exit(1);
  }

  task.previous_status = task.status;
  task.status = "blocked";
  task.block_reason = reason;
  if (by) {
    task.blocked_by.push(by);
  }
  task.updated_at = new Date().toISOString();
  await saveStore(store);
  await recordKernelEvent({
    type: "task.updated",
    timestamp: task.updated_at,
    reason: "block",
    task: { ...task },
  });

  console.log(`${taskId} blocked`);
}

async function archiveWorkerForRetry(taskId: string, attempt: number): Promise<string | null> {
  const workerDir = join(projectRoot(), ".apex-manager", "workers", taskId);
  if (!existsSync(workerDir)) return null;

  const metaPath = join(workerDir, "meta.json");
  if (existsSync(metaPath)) {
    try {
      const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as WorkerMeta;
      if (meta.window_handle) {
        try {
          await adapterForHandle(meta.window_handle).close(meta.window_handle);
        } catch {
          // Terminal may already be gone; archival still makes retry schedulable.
        }
      }
    } catch {
      // Preserve the worker dir even if meta is malformed.
    }
  }

  const archiveRoot = join(projectRoot(), ".apex-manager", "workers-archive");
  mkdirSync(archiveRoot, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const archivePath = join(archiveRoot, `${taskId}-attempt-${attempt}-${stamp}`);
  renameSync(workerDir, archivePath);
  return archivePath;
}

async function cmdRetry(args: string[]): Promise<void> {
  const taskId = args[0];
  if (!taskId) {
    console.error("Usage: apex-manager task retry <task-id> [--agent <agent>] [--protocol <protocol>] [--reason <reason>]");
    process.exit(1);
  }

  const store = await loadStore();
  const task = findTask(store, taskId);
  if (!task) {
    console.error(`Task ${taskId} not found`);
    process.exit(1);
  }
  if (task.status === "done") {
    console.error(`Cannot retry completed task ${taskId}`);
    process.exit(1);
  }

  const now = new Date().toISOString();
  const agent = flagValue(args, "--agent");
  const protocol = flagValue(args, "--protocol");
  const reason = flagValue(args, "--reason");
  task.attempts = task.attempts ?? [];
  if (task.attempts.length === 0 && task.status !== "open") {
    task.attempts.push({
      attempt: task.attempt ?? 1,
      agent: task.actual_agent ?? task.agent ?? "unknown",
      worker_id: task.claimed_by ?? task.id,
      status: task.status === "blocked" ? "blocked" : "failed",
      started_at: task.claimed_at ?? task.updated_at,
      completed_at: now,
      note: reason ?? "retry requested",
    });
  }

  const previousAttemptNumber = task.attempt ?? task.attempts.length;
  const currentAttempt = task.attempts?.[task.attempts.length - 1];
  if (currentAttempt && !currentAttempt.completed_at) {
    currentAttempt.status = task.status === "blocked" ? "blocked" : "failed";
    currentAttempt.completed_at = now;
    currentAttempt.note = reason ?? currentAttempt.note ?? "retry requested";
  }

  task.previous_status = task.status;
  task.status = "open";
  task.attempt = previousAttemptNumber + 1;
  if (agent) task.agent = agent;
  if (protocol) task.protocol = protocol;
  task.actual_agent = undefined;
  task.claimed_by = undefined;
  task.claimed_at = undefined;
  task.completed_by = undefined;
  task.completed_at = undefined;
  task.completion_summary = undefined;
  task.block_reason = undefined;
  task.updated_at = now;

  await saveStore(store);
  const archived = await archiveWorkerForRetry(taskId, previousAttemptNumber);
  await recordKernelEvent({
    type: "task.updated",
    timestamp: task.updated_at,
    reason: "retry",
    task: { ...task },
    ...(archived ? { archived_worker_path: archived } : {}),
  });

  console.log(`${taskId} retry scheduled (attempt ${task.attempt})${archived ? `; archived previous worker at ${archived}` : ""}`);
}

// ── Help ─────────────────────────────────────────────────────────────

function printHelp(): void {
  console.log(`
apex-manager task — task management

Usage:
  apex-manager task create <title> [description...] [options]
    Create a new task. Returns the task ID.
    Options:
      --depends <task-id>    Add dependency (repeatable)
      --agent <agent>        Assign agent (claude, codex, gemini)
      --protocol <skill>     Assign work protocol skill
      --category <cat>       Set task category

  apex-manager task list
    List all tasks with status.

  apex-manager task status <task-id>
    Show detailed task info.

  apex-manager task claim <task-id> [--by <worker-id>]
    Mark a task as claimed/in progress.

  apex-manager task complete <task-id> [--by <worker-id>] [--summary <summary>] [--evidence <artifact>]
    Mark a task completed with optional evidence.

  apex-manager task block <task-id> --reason <reason> [--by <worker-id>]
    Mark a task blocked with a reason.

  apex-manager task retry <task-id> [--agent <agent>] [--protocol <protocol>] [--reason <reason>]
    Re-open a non-completed task for another attempt under the same task ID.

  apex-manager task update <task-id> [options]
    Update task fields.
    Options:
      --status <status>      Transition status (open|assigned|in_progress|to_verify|done|blocked)
      --agent <agent>        Set/change agent
      --protocol <skill>     Set/change protocol
      --evidence <artifact>  Add evidence (repeatable)
      --block-reason <reason> Set block reason (with --status blocked)
`);
}

// ── Main dispatch ────────────────────────────────────────────────────

export async function cmdTask(args: string[]): Promise<void> {
  const verb = args[0];

  switch (verb) {
    case "create":
      await cmdCreate(args.slice(1));
      break;
    case "list":
      await cmdList();
      break;
    case "status":
      await cmdStatus(args.slice(1));
      break;
    case "claim":
      await cmdClaim(args.slice(1));
      break;
    case "complete":
      await cmdComplete(args.slice(1));
      break;
    case "block":
      await cmdBlock(args.slice(1));
      break;
    case "retry":
      await cmdRetry(args.slice(1));
      break;
    case "update":
      await cmdUpdate(args.slice(1));
      break;
    case "--help":
    case "help":
      printHelp();
      break;
    default:
      if (!verb) {
        printHelp();
      } else {
        console.error(`Unknown task subcommand: ${verb}`);
        printHelp();
        process.exit(1);
      }
      break;
  }
}
