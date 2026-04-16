import { mkdirSync } from "fs";
import { join } from "path";
import { readJSON, writeJSON } from "../utils/json.js";
import type { Task, TaskStatus, TaskStore } from "../types/task.js";
import { ALLOWED_TRANSITIONS } from "../types/task.js";

// ── Helpers ──────────────────────────────────────────────────────────

function projectRoot(): string {
  return process.cwd();
}

function storePath(): string {
  return join(projectRoot(), ".apex-manager", "tasks.json");
}

async function loadStore(): Promise<TaskStore> {
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
    created_at: now,
    updated_at: now,
    ...(agent ? { agent } : {}),
    ...(protocol ? { protocol } : {}),
    ...(category ? { category } : {}),
  };

  store.tasks.push(task);
  store.next_id++;
  await saveStore(store);

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

  console.log(`${taskId} updated (status: ${task.status})`);
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
