/**
 * Worker status monitoring — scan .apex-manager/workers/ and report health.
 */

import { spawnSync } from "child_process";
import { existsSync, readdirSync } from "fs";
import { join } from "path";
import { readJSON } from "../utils/json.js";
import { adapterForHandle } from "./terminal.js";
import type { WindowHandle } from "./terminal.js";

// ── Interfaces ─────────────────────────────────────────────────────

export interface WorkerStatus {
  task_id: string;
  stage: string;
  progress: string;
  last_activity: string;
  errors: string[];
}

export interface WorkerResult {
  task_id: string;
  verdict: "pass" | "fail" | "blocked";
  summary?: string;
  findings?: string[];
  completed_at?: string;
  branch?: string;
  commit?: string;
}

export interface WorkerMeta {
  task_id: string;
  pid?: number;
  window_handle: { id: string; name: string; adapter: string } | null;
  worktree_path: string;
  branch: string;
  started_at: string;
  agent: string;
  /** "persistent" agents stay alive; "one-shot" agents exit after execution. */
  execution_mode?: "persistent" | "one-shot";
}

export interface WorkerHealth {
  alive: boolean;
  starting: boolean;
  stale: boolean;
  completed: boolean;
  crashed: boolean;
  /** Terminal exited without writing result.json (one-shot agents or silent failures). */
  exitedWithoutResult: boolean;
  screenTail?: string;
}

export interface WorkerInfo {
  meta: WorkerMeta;
  status: WorkerStatus | null;
  result: WorkerResult | null;
}

// ── Constants ──────────────────────────────────────────────────────

const STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes
const STARTUP_GRACE_MS = 15_000;
const WORKERS_DIR = ".apex-manager/workers";

// ── Helpers ────────────────────────────────────────────────────────

function isPidAlive(pid: number): boolean {
  try {
    const r = spawnSync("kill", ["-0", String(pid)], { encoding: "utf-8", timeout: 5_000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

// ── listWorkers ────────────────────────────────────────────────────

export async function listWorkers(): Promise<WorkerInfo[]> {
  if (!existsSync(WORKERS_DIR)) return [];

  const entries = readdirSync(WORKERS_DIR, { withFileTypes: true });
  const workers: WorkerInfo[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const taskId = entry.name;
    const dir = join(WORKERS_DIR, taskId);
    const metaPath = join(dir, "meta.json");

    if (!existsSync(metaPath)) continue;

    const meta = await readJSON<WorkerMeta | null>(metaPath, null);
    if (!meta) continue;

    const status = await readJSON<WorkerStatus | null>(join(dir, "status.json"), null);
    const result = await readJSON<WorkerResult | null>(join(dir, "result.json"), null);
    workers.push({ meta, status, result });
  }

  return workers;
}

// ── checkWorkerHealth ──────────────────────────────────────────────

export async function checkWorkerHealth(taskId: string): Promise<WorkerHealth> {
  const dir = join(WORKERS_DIR, taskId);
  const metaPath = join(dir, "meta.json");

  if (!existsSync(metaPath)) {
    throw new Error(`Worker ${taskId} not found (missing ${metaPath})`);
  }

  const meta = await readJSON<WorkerMeta | null>(metaPath, null);
  if (!meta) {
    throw new Error(`Worker ${taskId}: meta.json exists but failed to parse`);
  }
  const status = await readJSON<WorkerStatus | null>(join(dir, "status.json"), null);
  const result = await readJSON<WorkerResult | null>(join(dir, "result.json"), null);

  const completed = result !== null;
  const startedAtMs = new Date(meta.started_at).getTime();
  const withinStartupGrace = Number.isFinite(startedAtMs) && (Date.now() - startedAtMs) < STARTUP_GRACE_MS;
  const starting = !completed && !status?.last_activity && withinStartupGrace;

  // Liveness: check terminal handle, then PID
  let terminalAlive = false;
  let pidAlive = false;
  let screenTail: string | undefined;

  if (meta.window_handle) {
    const adapter = adapterForHandle(meta.window_handle as WindowHandle);
    try {
      screenTail = await adapter.readScreen(meta.window_handle as WindowHandle, 5);
    } catch {
      // Best-effort only; keep going so a dead surface still reports crash state.
    }
    try {
      terminalAlive = await adapter.isAlive(meta.window_handle as WindowHandle);
    } catch {
      terminalAlive = false;
    }
  }

  if (meta.pid) {
    pidAlive = isPidAlive(meta.pid);
  }

  const alive = terminalAlive || pidAlive;

  // Stale: last_activity older than threshold
  let stale = false;
  if (status?.last_activity) {
    const age = Date.now() - new Date(status.last_activity).getTime();
    stale = age > STALE_THRESHOLD_MS;
  }

  // Crashed vs exited-without-result: both have no terminal and no result.
  // Distinguish by execution_mode: one-shot agents are expected to exit.
  const hadProcess = meta.pid !== undefined || meta.window_handle !== null;
  const processGone = hadProcess && !alive && !completed && !starting;
  const isOneShot = meta.execution_mode === "one-shot";
  const crashed = processGone && !isOneShot;
  const exitedWithoutResult = processGone && isOneShot;

  return { alive, starting, stale, completed, crashed, exitedWithoutResult, screenTail };
}

// ── getMonitorReport ───────────────────────────────────────────────

export async function getMonitorReport(): Promise<string> {
  const workers = await listWorkers();
  if (workers.length === 0) return "No workers registered.";

  const lines: string[] = [];

  for (const w of workers) {
    const health = await checkWorkerHealth(w.meta.task_id);
    let label: string;

    if (health.completed) {
      label = `completed (${w.result?.verdict ?? "unknown"})`;
    } else if (health.starting) {
      label = "STARTING";
    } else if (health.crashed) {
      label = "CRASHED";
    } else if (health.exitedWithoutResult) {
      label = "EXITED (no result)";
    } else if (health.stale) {
      label = "STALE";
    } else if (health.alive) {
      label = "running";
    } else {
      label = "unknown";
    }

    const stage = w.status?.stage ?? "-";
    const progress = w.status?.progress ?? "-";
    lines.push(`[${w.meta.task_id}] ${label}  stage: ${stage}  progress: ${progress}`);

    if (health.screenTail) {
      const tail = health.screenTail.split("\n").slice(-5).map((l) => `  | ${l}`).join("\n");
      lines.push(tail);
    }
  }

  return lines.join("\n");
}
