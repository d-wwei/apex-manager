import { existsSync } from "fs";
import { join } from "path";
import { readJSON } from "../utils/json.js";
import type { TaskStore } from "../types/task.js";
import type { WorkerMeta } from "./monitor.js";
import type { AgentAdapter } from "./agent-adapter.js";
import type { TerminalAdapter, WindowHandle } from "./terminal.js";
import { inspectTmuxHandle } from "./terminal.js";
import { waitForWorkerIdle } from "./idle.js";

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

async function detectLaunchActionSignal(
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

  if (task.status === "in_progress" || task.status === "done" || task.status === "blocked" || task.claimed_by === actionTaskId) {
    return "task_claimed";
  }

  return null;
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

  while (Date.now() < deadline) {
    try {
      const screen = await terminal.readScreen(handle, 12);
      latestScreen = summarizeSmokeScreen(screen).slice(0, 140);
    } catch {
      latestScreen = "(screen unavailable)";
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

  return {
    state: "failed",
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
