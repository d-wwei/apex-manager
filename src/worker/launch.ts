import { existsSync } from "fs";
import { join } from "path";
import { readJSON } from "../utils/json.js";
import type { TaskStore } from "../types/task.js";
import type { WorkerMeta } from "./monitor.js";
import type { AgentAdapter } from "./agent-adapter.js";
import type { TerminalAdapter, WindowHandle } from "./terminal.js";
import { inspectTmuxHandle } from "./terminal.js";
import { isWorkerIdleScreen, waitForWorkerIdle } from "./idle.js";

export type LaunchActionSignal = "task_claimed" | "status_updated" | "result_written";
export type LaunchVerification = NonNullable<WorkerMeta["launch_verification"]>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findTask(store: TaskStore, taskId: string) {
  return store.tasks.find((task) => task.id === taskId);
}

export function buildWorkerKickoffMessage(agentAdapter: AgentAdapter, relProtocolPath: string): string | null {
  if (agentAdapter.needsPostCreateSend) {
    return `Read the file ${relProtocolPath} and execute all tasks described in it. This is your complete work instruction.`;
  }

  if (agentAdapter.protocolInjection.type === "system-prompt-file") {
    return `Start now. Your worker protocol from ${relProtocolPath} is already loaded in system context. Execute it immediately and continue autonomously until done or blocked.`;
  }

  return null;
}

function summarizeSmokeScreen(screen: string): string {
  const line = screen
    .split("\n")
    .map((entry) => entry.trim())
    .reverse()
    .find((entry) => entry.length > 0);
  return line ?? "(screen empty)";
}

export async function detectLaunchActionSignal(
  projectRoot: string,
  workerId: string,
  actionTaskId?: string | null,
): Promise<LaunchActionSignal | null> {
  if (existsSync(join(projectRoot, ".apex-manager", "workers", workerId, "result.json"))) {
    return "result_written";
  }

  if (existsSync(join(projectRoot, ".apex-manager", "workers", workerId, "status.json"))) {
    return "status_updated";
  }

  if (!actionTaskId) {
    return null;
  }

  const store = await readJSON<TaskStore>(join(projectRoot, ".apex-manager", "tasks.json"), { tasks: [], next_id: 1 });
  const task = findTask(store, actionTaskId);
  if (!task) {
    return null;
  }

  if (
    task.claimed_by === actionTaskId ||
    task.completed_by === actionTaskId ||
    (task.blocked_by ?? []).includes(actionTaskId)
  ) {
    return "task_claimed";
  }

  return null;
}

export async function assertLaunchSurfaceAlive(
  taskId: string,
  terminal: TerminalAdapter,
  handle: WindowHandle,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      await sleep(250);
    }
    try {
      const alive = await terminal.isAlive(handle);
      if (!alive) {
        throw new Error("terminal surface is no longer alive");
      }
      await terminal.readScreen(handle, 1);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`spawn_failed_terminal_surface_missing: ${taskId}: ${String(lastError)}`);
}

export async function verifyWorkerLaunch(
  projectRoot: string,
  workerId: string,
  actionTaskId: string | null,
  terminal: TerminalAdapter,
  handle: WindowHandle,
  timeoutMs = 10_000,
): Promise<LaunchVerification> {
  const deadline = Date.now() + timeoutMs;
  let latestScreen = "(screen unavailable)";
  let latestClientMapped: boolean | null = null;
  let latestClientNote = "";
  let terminalReadable = false;
  let terminalAlive = false;

  while (Date.now() < deadline) {
    try {
      const screen = await terminal.readScreen(handle, 12);
      latestScreen = summarizeSmokeScreen(screen).slice(0, 140);
      terminalReadable = true;
    } catch {
      latestScreen = "(screen unavailable)";
    }
    try {
      terminalAlive = await terminal.isAlive(handle);
    } catch {
      terminalAlive = false;
    }

    const tmuxInfo = inspectTmuxHandle(handle);
    if (tmuxInfo) {
      latestClientMapped = tmuxInfo.matchedClients.length > 0;
      latestClientNote = latestClientMapped
        ? `client mapped to ${tmuxInfo.session}/${tmuxInfo.windowName}`
        : `no visible client currently attached to ${tmuxInfo.session}/${tmuxInfo.windowName}`;
    }

    const signal = await detectLaunchActionSignal(projectRoot, workerId, actionTaskId);
    if (signal) {
      return {
        state: "verified",
        checked_at: new Date().toISOString(),
        action_signal: signal,
        screen_summary: latestScreen,
        client_mapped: latestClientMapped,
        note: latestClientNote || `verified via ${signal}`,
      };
    }

    await sleep(1_000);
  }

  const hasTerminalActivity = terminalReadable || terminalAlive || latestClientMapped === true;
  return {
    state: hasTerminalActivity ? "unverified" : "failed",
    checked_at: new Date().toISOString(),
    screen_summary: latestScreen,
    client_mapped: latestClientMapped,
    note: latestClientNote
      ? `No task claim, status.json, or result.json activity within ${Math.round(timeoutMs / 1000)}s; ${latestClientNote}`
      : `No task claim, status.json, or result.json activity within ${Math.round(timeoutMs / 1000)}s`,
  };
}

export async function waitForKickoffReady(
  taskId: string,
  agent: string,
  terminal: TerminalAdapter,
  handle: WindowHandle,
  timeoutMs = 10_000,
): Promise<void> {
  try {
    const ready = await waitForWorkerIdle(terminal, handle, agent, timeoutMs, 500);
    if (!ready) {
      console.warn(`[warn] ${taskId}: worker did not show an idle prompt within ${Math.round(timeoutMs / 1000)}s; sending kickoff anyway`);
    }
  } catch (error) {
    console.warn(`[warn] ${taskId}: unable to confirm worker readiness (${String(error)}); sending kickoff anyway`);
  }
}

export async function ensureKickoffSubmitted(
  taskId: string,
  agent: string,
  terminal: TerminalAdapter,
  handle: WindowHandle,
  kickoffMessage: string,
): Promise<void> {
  const submitKey = terminal.name() === "cmux" ? "enter" : "Enter";
  const probeNeedles = [
    "worker-protocol.md",
    kickoffMessage.slice(0, 48),
  ].filter((needle) => needle.length > 0);

  try {
    await sleep(300);
    const screen = await terminal.readScreen(handle, 20);
    const kickoffStillVisible = probeNeedles.some((needle) => screen.includes(needle));
    if (kickoffStillVisible && isWorkerIdleScreen(screen, agent)) {
      console.warn(`[warn] ${taskId}: kickoff text still appears idle in the terminal; sending an extra submit key`);
      await terminal.sendKey(handle, submitKey);
    }
  } catch {
    // Best-effort safeguard only.
  }
}
