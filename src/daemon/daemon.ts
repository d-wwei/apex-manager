/**
 * Orchestration Daemon — Main Process
 *
 * Runs a tick loop that monitors Workers, triggers auto-integrate/merge,
 * spawns unblocked tasks, and notifies the Plan Agent of events requiring judgment.
 *
 * Deterministic operations only — no AI judgment in this process.
 */

import { spawnSync } from "child_process";
import { existsSync, readFileSync, readdirSync, renameSync } from "fs";
import { join } from "path";
import { readJSON, writeJSON } from "../utils/json.js";
import { recordKernelEvent } from "../utils/events.js";
import { autoIntegrate, autoMerge } from "./integrate.js";
import { notifyPlanAgent } from "./notify.js";
import { detectAdapter } from "../worker/terminal.js";
import { checkWorkerHealth } from "../worker/monitor.js";
import { detectLaunchActionSignal } from "../worker/launch.js";
import type { WindowHandle, TerminalAdapter } from "../worker/terminal.js";
import type { WorkerMeta, WorkerResult } from "../worker/monitor.js";
import type { TaskStore } from "../types/task.js";
import { processMessageQueueOnce } from "../worker/messages.js";
import { redactSecrets } from "../utils/redact.js";

// ── Types ──────────────────────────────────────────────────────────────

export interface WorkerState {
  taskId: string;
  meta: WorkerMeta;
  lastHealth: { alive: boolean; completed: boolean; crashed: boolean; exitedWithoutResult: boolean; completedOrphaned: boolean };
  resultChecked: boolean;
}

export interface DaemonState {
  running: boolean;
  pollInterval: number;
  projectRoot: string;
  workers: Map<string, WorkerState>;
  adapter: TerminalAdapter | null;
  planAgentHandle: WindowHandle | null;
  lastThrottleNotified: boolean;
}

function gitStatusExcludingControlPlane(projectRoot: string): string {
  const status = spawnSync(
    "git",
    ["status", "--short", "--", ".", ":(exclude).apex-manager", ":(exclude).apex-manager/**"],
    { cwd: projectRoot, encoding: "utf-8" },
  );
  const diff = spawnSync(
    "git",
    ["diff", "--binary", "--", ".", ":(exclude).apex-manager", ":(exclude).apex-manager/**"],
    { cwd: projectRoot, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 },
  );
  return [
    status.status === 0 ? status.stdout.trim() : "",
    diff.status === 0 ? diff.stdout : "",
  ].join("\n---diff---\n");
}

function workerMetaPath(projectRoot: string, taskId: string): string {
  return join(projectRoot, ".apex-manager", "workers", taskId, "meta.json");
}

async function saveWorkerMeta(projectRoot: string, meta: WorkerMeta): Promise<void> {
  await writeJSON(workerMetaPath(projectRoot, meta.task_id), meta);
}

async function updateTaskAttempt(
  projectRoot: string,
  taskId: string,
  status: NonNullable<TaskStore["tasks"][number]["attempts"]>[number]["status"],
  note?: string,
): Promise<void> {
  const taskPath = join(projectRoot, ".apex-manager", "tasks.json");
  const store = await readJSON<TaskStore>(taskPath, { tasks: [], next_id: 1 });
  const task = store.tasks.find((entry) => entry.id === taskId);
  if (!task?.attempts || task.attempts.length === 0) return;
  const attempt = task.attempts[task.attempts.length - 1];
  attempt.status = status;
  attempt.note = note ?? attempt.note;
  if (status === "completed" || status === "failed" || status === "blocked" || status === "crashed") {
    attempt.completed_at = new Date().toISOString();
  }
  task.updated_at = new Date().toISOString();
  await writeJSON(taskPath, store);
}

async function reconcileLaunchVerification(state: DaemonState, worker: WorkerState): Promise<void> {
  const launchState = worker.meta.launch_verification?.state;
  if (!(launchState === "pending" || launchState === "unverified" || launchState === "failed")) {
    return;
  }

  const signal = await detectLaunchActionSignal(state.projectRoot, worker.taskId, worker.taskId);
  if (!signal) return;

  const checkedAt = new Date().toISOString();
  worker.meta.launch_verification = {
    ...worker.meta.launch_verification,
    state: "verified",
    checked_at: checkedAt,
    action_signal: signal,
    note: `late verification via ${signal}`,
  };
  await saveWorkerMeta(state.projectRoot, worker.meta);
  await updateTaskAttempt(state.projectRoot, worker.taskId, "verified", worker.meta.launch_verification.note);
  await recordKernelEvent({
    type: "worker.launch_reconciled",
    timestamp: checkedAt,
    worker_id: worker.taskId,
    verification: worker.meta.launch_verification,
  });
}

async function detectIsolationViolation(state: DaemonState, worker: WorkerState): Promise<boolean> {
  if (worker.meta.isolation_mode !== "git-worktree" || worker.meta.isolation_violation) {
    return false;
  }
  const baseline = worker.meta.main_repo_baseline_status ?? "";
  const current = gitStatusExcludingControlPlane(state.projectRoot);
  if (current === baseline) return false;

  worker.meta.isolation_violation = {
    detected_at: new Date().toISOString(),
    baseline_status: baseline,
    current_status: current,
  };
  await saveWorkerMeta(state.projectRoot, worker.meta);

  const taskPath = join(state.projectRoot, ".apex-manager", "tasks.json");
  const store = await readJSON<TaskStore>(taskPath, { tasks: [], next_id: 1 });
  const task = store.tasks.find((entry) => entry.id === worker.taskId);
  if (task && task.status !== "blocked") {
    task.previous_status = task.status;
    task.status = "blocked";
    task.block_reason = "worktree isolation violation: main repo changed while worker was active";
    task.blocked_by.push(worker.taskId);
    task.updated_at = worker.meta.isolation_violation.detected_at;
    await writeJSON(taskPath, store);
  }
  await updateTaskAttempt(state.projectRoot, worker.taskId, "blocked", "worktree isolation violation");
  await recordKernelEvent({
    type: "orchestration.event",
    action: "isolation_violation",
    task_id: worker.taskId,
    timestamp: worker.meta.isolation_violation.detected_at,
    baseline_status: baseline,
    current_status: current,
  });
  await notifyPlanAgent(state.adapter, state.planAgentHandle,
    `Worker ${worker.taskId} isolation violation: main repo changed while worker was active. Auto-merge disabled.`);
  return true;
}

async function reconcileTaskDoneWorker(state: DaemonState, worker: WorkerState): Promise<boolean> {
  const taskPath = join(state.projectRoot, ".apex-manager", "tasks.json");
  const store = await readJSON<TaskStore>(taskPath, { tasks: [], next_id: 1 });
  const task = store.tasks.find((entry) => entry.id === worker.taskId);
  if (task?.status !== "done" || worker.meta.orphaned_task_done) {
    return false;
  }

  worker.meta.orphaned_task_done = {
    detected_at: new Date().toISOString(),
    note: "task store is done, but worker did not write result.json",
  };
  await saveWorkerMeta(state.projectRoot, worker.meta);
  await updateTaskAttempt(state.projectRoot, worker.taskId, "completed", worker.meta.orphaned_task_done.note);
  await recordKernelEvent({
    type: "orchestration.event",
    action: "worker_completed_orphaned",
    task_id: worker.taskId,
    timestamp: worker.meta.orphaned_task_done.detected_at,
  });
  return true;
}

async function validateWorkerResultOwnership(
  state: DaemonState,
  taskId: string,
  worker: WorkerState,
  result: WorkerResult | null,
): Promise<string | null> {
  if (!result?.task_id) {
    return "result is missing task_id";
  }
  if (result.task_id !== taskId) {
    return `result task_id '${result.task_id}' does not match worker '${taskId}'`;
  }
  const store = await readJSON<TaskStore>(join(state.projectRoot, ".apex-manager", "tasks.json"), { tasks: [], next_id: 1 });
  const task = store.tasks.find((entry) => entry.id === taskId);
  if (!task) {
    return `task ${taskId} missing from task store`;
  }
  if (task.claimed_by !== taskId) {
    return `task claimed_by '${task.claimed_by ?? "-"}' does not match worker '${taskId}'`;
  }
  if (task.completed_by && task.completed_by !== taskId) {
    return `task completed_by '${task.completed_by}' does not match worker '${taskId}'`;
  }
  if (worker.meta.launch_verification?.state !== "verified") {
    return `worker launch is ${worker.meta.launch_verification?.state ?? "unknown"}, expected verified`;
  }
  if (worker.meta.isolation_violation) {
    return "worker has an isolation violation";
  }
  return null;
}

// ── State factory ──────────────────────────────────────────────────────

export function createDaemonState(projectRoot: string, planAgentHandle: WindowHandle | null): DaemonState {
  let adapter: TerminalAdapter | null = null;
  try {
    adapter = detectAdapter();
  } catch {
    // No terminal multiplexer available — daemon still works, just can't send terminal messages
  }

  return {
    running: true,
    pollInterval: 10_000,
    projectRoot,
    workers: new Map(),
    adapter,
    planAgentHandle,
    lastThrottleNotified: false,
  };
}

// ── Worker discovery ───────────────────────────────────────────────────

/**
 * Scan .apex-manager/workers/ to discover and restore Worker state.
 * Called at daemon startup and periodically to pick up new workers.
 */
export async function discoverWorkers(state: DaemonState): Promise<void> {
  const workersDir = join(state.projectRoot, ".apex-manager", "workers");
  if (!existsSync(workersDir)) return;

  const entries = readdirSync(workersDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const taskId = entry.name;
    if (state.workers.has(taskId)) continue; // Already tracked

    const metaPath = join(workersDir, taskId, "meta.json");
    if (!existsSync(metaPath)) continue;

    const meta = await readJSON<WorkerMeta | null>(metaPath, null);
    if (!meta) continue;

    // Check if result.json already exists (worker completed while daemon was down)
    const resultPath = join(workersDir, taskId, "result.json");
    const hasResult = existsSync(resultPath);

    state.workers.set(taskId, {
      taskId,
      meta,
      lastHealth: { alive: !hasResult, completed: hasResult, crashed: false, exitedWithoutResult: false, completedOrphaned: false },
      resultChecked: false, // tick will process on next cycle
    });

    console.log(`[daemon] Recovered worker ${taskId} (agent: ${meta.agent}${hasResult ? ", has result" : ""})`);
  }
}

export async function processMessageQueue(state: DaemonState): Promise<void> {
  await processMessageQueueOnce();
}

// ── Tick ────────────────────────────────────────────────────────────────

/**
 * Single tick of the daemon loop.
 * Checks all Workers, handles completions/crashes/escalations, spawns ready tasks.
 */
export async function tick(state: DaemonState): Promise<void> {
  // Discover any new workers (e.g., spawned by Plan Agent since last tick)
  await discoverWorkers(state);
  await processMessageQueue(state);

  // 1. Check each Worker
  for (const [taskId, worker] of state.workers) {
    if (!existsSync(workerMetaPath(state.projectRoot, taskId))) {
      state.workers.delete(taskId);
      continue;
    }
    await reconcileLaunchVerification(state, worker);
    const health = await checkWorkerHealth(taskId);

    if (!health.completed && await reconcileTaskDoneWorker(state, worker)) {
      worker.resultChecked = true;
      worker.lastHealth = { alive: health.alive, completed: false, crashed: false, exitedWithoutResult: false, completedOrphaned: true };
      continue;
    }

    if (!worker.resultChecked && await detectIsolationViolation(state, worker)) {
      worker.resultChecked = true;
      worker.lastHealth = { alive: health.alive, completed: false, crashed: false, exitedWithoutResult: false, completedOrphaned: false };
      continue;
    }

    // 2. Detect completion
    if (health.completed && !worker.resultChecked) {
      worker.resultChecked = true;
      const resultPath = join(state.projectRoot, ".apex-manager", "workers", taskId, "result.json");
      const result = await readJSON<WorkerResult | null>(resultPath, null);

      if (result?.verdict === "pass") {
        const ownershipFailure = await validateWorkerResultOwnership(state, taskId, worker, result);
        if (ownershipFailure) {
          await notifyPlanAgent(state.adapter, state.planAgentHandle,
            `Worker ${taskId} pass result rejected: ${ownershipFailure}`);
          await recordKernelEvent({
            type: "orchestration.event",
            action: "worker_result_rejected",
            task_id: taskId,
            reason: ownershipFailure,
            timestamp: new Date().toISOString(),
          });
          continue;
        }
        // Auto: integrate → merge → spawn downstream
        const intResult = await autoIntegrate(taskId);
        if (intResult.ok) {
          const merged = await autoMerge(taskId);
          if (merged) {
            await notifyPlanAgent(state.adapter, state.planAgentHandle,
              `Worker ${taskId} completed (pass) → integrated → merged`);
            await spawnUnblockedTasks(state);
          } else {
            // Race: main moved, re-notify for manual handling
            await notifyPlanAgent(state.adapter, state.planAgentHandle,
              `Worker ${taskId} merge race — needs re-integration`);
          }
        } else {
          await notifyPlanAgent(state.adapter, state.planAgentHandle,
            `Worker ${taskId} integration failed: ${intResult.reason} — ${redactSecrets(intResult.output ?? "").slice(0, 200)}`);
        }
      } else {
        // Report: verdict != pass, Plan Agent must diagnose
        await notifyPlanAgent(state.adapter, state.planAgentHandle,
          `Worker ${taskId} completed with verdict=${result?.verdict ?? "unknown"}`);
        await recordKernelEvent({
          type: "orchestration.event",
          action: "worker_failed",
          task_id: taskId,
          verdict: result?.verdict,
          timestamp: new Date().toISOString(),
        });
      }
    }

    // 3. Detect crash
    if (health.crashed && !worker.resultChecked) {
      await notifyPlanAgent(state.adapter, state.planAgentHandle,
        `Worker ${taskId} crashed. Screen tail:\n${redactSecrets(health.screenTail ?? "(unavailable)").slice(-500)}`);
      await recordKernelEvent({
        type: "orchestration.event",
        action: "worker_crashed",
        task_id: taskId,
        timestamp: new Date().toISOString(),
      });
      worker.resultChecked = true; // Don't re-report
    }

    // 3b. Detect one-shot agent exit without result (not a crash)
    if (health.exitedWithoutResult && !worker.resultChecked) {
      await notifyPlanAgent(state.adapter, state.planAgentHandle,
        `Worker ${taskId} (one-shot) exited without writing result.json. Agent may have failed silently or lacked permissions.`);
      await recordKernelEvent({
        type: "orchestration.event",
        action: "worker_exited_no_result",
        task_id: taskId,
        timestamp: new Date().toISOString(),
      });
      worker.resultChecked = true;
    }

    // 4. Detect escalation
    const escPath = join(state.projectRoot, ".apex-manager", "workers", taskId, "escalation.json");
    if (existsSync(escPath)) {
      try {
        const esc = JSON.parse(readFileSync(escPath, "utf-8"));
        await notifyPlanAgent(state.adapter, state.planAgentHandle,
          `Worker ${taskId} escalation (${esc.type}): ${esc.summary}`);
        await recordKernelEvent({
          type: "orchestration.event",
          action: "escalation_received",
          task_id: taskId,
          escType: esc.type,
          timestamp: new Date().toISOString(),
        });
        // Mark as processed
        renameSync(escPath, escPath.replace(".json", `.${Date.now()}.processed.json`));
      } catch {
        // Malformed or already processed
      }
    }

    worker.lastHealth = { alive: health.alive, completed: health.completed, crashed: health.crashed, exitedWithoutResult: health.exitedWithoutResult, completedOrphaned: health.completedOrphaned };
  }

  // 5. Spawn unblocked tasks
  await spawnUnblockedTasks(state);

  // 6. Check M&C exit condition: all tasks done, no active workers
  await checkClosureCondition(state);
}

// ── Spawn unblocked tasks ──────────────────────────────────────────────

async function spawnUnblockedTasks(state: DaemonState): Promise<void> {
  const store = await readJSON<TaskStore>(join(state.projectRoot, ".apex-manager", "tasks.json"), { tasks: [], next_id: 1 });

  for (const task of store.tasks) {
    if (task.status !== "open") continue;
    const existingWorker = state.workers.get(task.id);
    if (existingWorker) {
      if (existingWorker.resultChecked || !existsSync(workerMetaPath(state.projectRoot, task.id))) {
        state.workers.delete(task.id);
      } else {
        continue;
      }
    }

    // Check dependencies all done
    const depsAllDone = (task.depends_on ?? []).every(
      depId => store.tasks.find(t => t.id === depId)?.status === "done"
    );
    if (!depsAllDone) continue;

    // Check concurrency limit
    const activeCount = [...state.workers.values()].filter(w => !w.resultChecked).length;
    const maxWorkers = 3; // TODO: read from config when parser supports it
    if (activeCount >= maxWorkers) break;

    // Spawn via CLI
    const result = spawnSync("apex-manager", ["worker", "spawn", task.id], {
      encoding: "utf-8",
      cwd: state.projectRoot,
    });

    if (result.status === 0) {
      const metaPath = join(state.projectRoot, ".apex-manager", "workers", task.id, "meta.json");
      const meta = await readJSON<WorkerMeta | null>(metaPath, null);
      if (meta) {
        state.workers.set(task.id, {
          taskId: task.id,
          meta,
          lastHealth: { alive: true, completed: false, crashed: false, exitedWithoutResult: false, completedOrphaned: false },
          resultChecked: false,
        });
      }
      await recordKernelEvent({
        type: "orchestration.event",
        action: "worker_spawned",
        task_id: task.id,
        agent: meta?.agent,
        timestamp: new Date().toISOString(),
      });
    } else {
      await notifyPlanAgent(state.adapter, state.planAgentHandle,
        `Failed to spawn Worker ${task.id}: ${result.stderr?.slice(0, 200)}`);
    }
  }
}

// ── Closure check ──────────────────────────────────────────────────────

async function checkClosureCondition(state: DaemonState): Promise<void> {
  const store = await readJSON<TaskStore>(join(state.projectRoot, ".apex-manager", "tasks.json"), { tasks: [], next_id: 1 });

  const allDone = store.tasks.length > 0 && store.tasks.every(t => t.status === "done");
  const noActiveWorkers = [...state.workers.values()].every(w => w.resultChecked);
  const noPending = !store.tasks.some(t => t.status === "open" || t.status === "assigned");

  if (allDone && noActiveWorkers && noPending) {
    await notifyPlanAgent(state.adapter, state.planAgentHandle,
      "所有任务已完成，无活跃 Worker。建议进入 Closure 阶段。");
  }
}

// ── Main loop ──────────────────────────────────────────────────────────

/**
 * Start the daemon tick loop. Runs until state.running is set to false.
 */
export async function runDaemon(state: DaemonState): Promise<void> {
  while (state.running) {
    try {
      await tick(state);
    } catch (err) {
      // Log but don't crash — daemon must be resilient
      console.error(`[daemon] tick error: ${err}`);
    }
    await new Promise(resolve => setTimeout(resolve, state.pollInterval));
  }
}
