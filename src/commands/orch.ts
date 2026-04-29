/**
 * Apex Manager — Orchestration Daemon CLI
 *
 * `apex-manager orch start` — Start the orchestration daemon (tick loop for Worker monitoring)
 * `apex-manager orch stop`  — Stop the daemon
 * `apex-manager orch status` — Show daemon status
 *
 * Not to be confused with `apex-manager daemon` which manages Dashboard launchd processes.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { createDaemonState, runDaemon } from "../daemon/daemon.js";
import { readPendingNotifications } from "../daemon/notify.js";
import { readKernelEvents, readProjectSnapshot, rebuildProjectSnapshotFromEvents } from "../utils/events.js";
import type { WindowHandle } from "../worker/terminal.js";

const LOCK_PATH = ".apex-manager/orch.lock";
const PID_PATH = ".apex-manager/orch.pid";

// ── Lock management ────────────────────────────────────────────────────

interface LockInfo {
  pid: number;
  session_id: string;
  plan_agent_handle: WindowHandle | null;
  started_at: string;
}

/**
 * Acquire the orchestration lock atomically.
 * Returns true if acquired, false if another daemon is running.
 */
export function acquireLock(sessionId: string, planAgentHandle: WindowHandle | null): boolean {
  const lockData = JSON.stringify({
    pid: process.pid,
    session_id: sessionId,
    plan_agent_handle: planAgentHandle,
    started_at: new Date().toISOString(),
  } satisfies LockInfo, null, 2);

  // 1. Try atomic creation (O_CREAT | O_EXCL)
  try {
    writeFileSync(LOCK_PATH, lockData, { flag: "wx" });
    return true;
  } catch (e: any) {
    if (e.code !== "EEXIST") throw e;
  }

  // 2. Lock exists — check if stale (PID dead)
  let lock: LockInfo;
  try {
    lock = JSON.parse(readFileSync(LOCK_PATH, "utf-8"));
  } catch {
    // Corrupt lock file — remove and retry
    try { unlinkSync(LOCK_PATH); } catch {}
    return acquireLock(sessionId, planAgentHandle);
  }

  try {
    process.kill(lock.pid, 0); // signal 0 = alive check
    // PID alive → lock is valid
    return false;
  } catch {
    // PID dead → stale lock, remove and retry
    try { unlinkSync(LOCK_PATH); } catch {}
    return acquireLock(sessionId, planAgentHandle);
  }
}

export function releaseLock(): void {
  try { unlinkSync(LOCK_PATH); } catch {}
}

function readLock(): LockInfo | null {
  if (!existsSync(LOCK_PATH)) return null;
  try {
    return JSON.parse(readFileSync(LOCK_PATH, "utf-8"));
  } catch {
    return null;
  }
}

function isLockAlive(lock: LockInfo): boolean {
  try {
    process.kill(lock.pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ── Lock update (for recovery / force-takeover) ───────────────────────

/**
 * Update fields in an existing lock file without re-acquiring.
 * Used by Plan Agent recovery to register a new terminal handle.
 */
export function updateLock(fields: Partial<LockInfo>): void {
  if (!existsSync(LOCK_PATH)) return;
  try {
    const lock: LockInfo = JSON.parse(readFileSync(LOCK_PATH, "utf-8"));
    const updated = { ...lock, ...fields };
    writeFileSync(LOCK_PATH, JSON.stringify(updated, null, 2));
  } catch {
    // Corrupt or race — ignore silently
  }
}

/**
 * Parse --handle flag from args. Returns WindowHandle or null.
 */
export function parseHandleFlag(args: string[]): WindowHandle | null {
  const idx = args.indexOf("--handle");
  if (idx < 0 || !args[idx + 1]) return null;
  try {
    return JSON.parse(args[idx + 1]) as WindowHandle;
  } catch {
    return null;
  }
}

// ── Commands ───────────────────────────────────────────────────────────

async function cmdStart(args: string[]): Promise<void> {
  const sessionId = process.env.APEX_SESSION_ID ?? `orch-${Date.now()}`;
  const force = args.includes("--force");

  if (force) {
    const lock = readLock();
    if (lock) {
      try { process.kill(lock.pid, "SIGTERM"); } catch {}
      releaseLock();
      console.log(`Terminated previous daemon (PID ${lock.pid})`);
    }
  }

  const planAgentHandle = parseHandleFlag(args);

  if (!acquireLock(sessionId, planAgentHandle)) {
    const lock = readLock();
    console.error("Error: 已有活跃的编排会话");
    if (lock) {
      console.error(`  Session: ${lock.session_id}`);
      console.error(`  Started: ${lock.started_at}`);
      console.error(`  PID: ${lock.pid}`);
    }
    console.error("\n选项:");
    console.error("  apex-manager orch start --force    接管旧 session");
    process.exit(1);
  }

  // Write PID for external monitoring
  writeFileSync(PID_PATH, String(process.pid));

  console.log(`Orchestration daemon started (PID ${process.pid})`);

  const state = createDaemonState(process.cwd(), planAgentHandle);

  // Graceful shutdown (guarded against double-call from signal + post-loop)
  let shutdownCalled = false;
  const shutdown = () => {
    if (shutdownCalled) return;
    shutdownCalled = true;
    console.log("\nOrchestration daemon stopping...");
    state.running = false;
    releaseLock();
    try { unlinkSync(PID_PATH); } catch {}
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  await runDaemon(state);

  shutdown(); // Safe: no-op if signal handler already ran
  console.log("Orchestration daemon stopped.");
}

async function cmdStop(): Promise<void> {
  const lock = readLock();
  if (!lock) {
    console.log("No orchestration daemon running.");
    return;
  }

  if (!isLockAlive(lock)) {
    console.log("Daemon PID is dead. Cleaning up stale lock.");
    releaseLock();
    try { unlinkSync(PID_PATH); } catch {}
    return;
  }

  try {
    process.kill(lock.pid, "SIGTERM");
    console.log(`Sent SIGTERM to daemon (PID ${lock.pid})`);
  } catch {
    console.error(`Failed to signal daemon PID ${lock.pid}`);
  }
}

async function cmdStatus(): Promise<void> {
  const lock = readLock();
  if (!lock) {
    console.log("No orchestration daemon registered.");
    return;
  }

  const alive = isLockAlive(lock);
  console.log(`Orchestration Daemon:`);
  console.log(`  Status:  ${alive ? "RUNNING" : "DEAD (stale lock)"}`);
  console.log(`  PID:     ${lock.pid}`);
  console.log(`  Session: ${lock.session_id}`);
  console.log(`  Started: ${lock.started_at}`);

  // Show pending notifications
  const pending = readPendingNotifications();
  if (pending.length > 0) {
    console.log(`\n  Pending notifications: ${pending.length}`);
    for (const n of pending.slice(0, 5)) {
      console.log(`    - ${n.message.slice(0, 80)}`);
    }
  }
}

function flagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : undefined;
}

async function cmdEvents(args: string[]): Promise<void> {
  const tail = Number(flagValue(args, "--tail") ?? "20");
  const typeFilter = flagValue(args, "--type");
  const events = await readKernelEvents();
  const filtered = typeFilter
    ? events.filter((event) => event.type === typeFilter)
    : events;

  const slice = filtered.slice(Math.max(0, filtered.length - tail));
  if (slice.length === 0) {
    console.log("No events.");
    return;
  }

  for (const event of slice) {
    console.log(`${event.timestamp}  ${event.type}`);
  }
}

async function cmdSnapshot(args: string[]): Promise<void> {
  const snapshot = args.includes("--rebuild")
    ? await rebuildProjectSnapshotFromEvents()
    : await readProjectSnapshot();

  console.log(`Snapshot generated_at=${snapshot.generated_at}`);
  console.log(`  tasks=${snapshot.tasks.length} artifacts=${snapshot.artifacts.length} messages=${snapshot.messages.length} workers=${snapshot.workers.length}`);
  console.log(`  open_tasks=${snapshot.stats.open_tasks} blocked_tasks=${snapshot.stats.blocked_tasks} pending_messages=${snapshot.stats.pending_messages}`);
}

// ── Main dispatch ──────────────────────────────────────────────────────

export async function cmdOrch(args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);

  switch (sub) {
    case "start":
      await cmdStart(rest);
      break;
    case "stop":
      await cmdStop();
      break;
    case "status":
      await cmdStatus();
      break;
    case "events":
      await cmdEvents(rest);
      break;
    case "snapshot":
      await cmdSnapshot(rest);
      break;
    default:
      console.log("Usage: apex-manager orch <start|stop|status|events|snapshot> [--force]");
  }
}
