import { existsSync, readFileSync } from "fs";
import { appendJSONL } from "./logger.js";
import { readJSON, writeJSON } from "./json.js";
import { apexPath, DEFAULT_PROJECT_SNAPSHOT, ensureProjectLayout } from "./project-state.js";
import type { ProjectSnapshot, KernelEvent } from "../types/state.js";

function parseId(value: string | undefined, prefix: string): number {
  if (!value || !value.startsWith(prefix)) return 0;
  const parsed = Number(value.slice(prefix.length));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function eventsPath(): string {
  return apexPath("events.jsonl");
}

export function legacyEventLogPath(): string {
  return apexPath("event-log.jsonl");
}

export function snapshotPath(): string {
  return apexPath("state.snapshot.json");
}

export async function readKernelEvents(): Promise<KernelEvent[]> {
  ensureProjectLayout();
  if (!existsSync(eventsPath())) return [];

  const content = readFileSync(eventsPath(), "utf-8").trim();
  if (!content) return [];

  const events: KernelEvent[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as KernelEvent);
    } catch {
      // Ignore malformed lines so recovery remains best-effort.
    }
  }
  return events;
}

export async function rebuildProjectSnapshotFromEvents(): Promise<ProjectSnapshot> {
  const tasks = new Map<string, any>();
  const artifacts = new Map<string, any>();
  const messages = new Map<string, any>();
  const workers = new Map<string, any>();

  for (const event of await readKernelEvents()) {
    if (event.task?.id) {
      tasks.set(event.task.id, event.task);
    }
    if (event.artifact?.id) {
      artifacts.set(event.artifact.id, event.artifact);
    }
    if (event.message?.id) {
      messages.set(event.message.id, event.message);
    }
    if (event.type === "worker.removed" && typeof event.worker_id === "string") {
      workers.delete(event.worker_id);
    } else if (event.worker?.task_id) {
      workers.set(event.worker.task_id, event.worker);
    }
  }

  const taskList = [...tasks.values()].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  const artifactList = [...artifacts.values()].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  const messageList = [...messages.values()].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  const workerList = [...workers.values()].sort((a, b) => a.task_id.localeCompare(b.task_id, undefined, { numeric: true }));

  const snapshot: ProjectSnapshot = {
    generated_at: new Date().toISOString(),
    tasks: taskList,
    artifacts: artifactList,
    messages: messageList,
    workers: workerList,
    counters: {
      next_task_id: Math.max(0, ...taskList.map((task) => parseId(task.id, "T"))) + 1,
      next_artifact_id: Math.max(0, ...artifactList.map((artifact) => parseId(artifact.id, "ART-"))) + 1,
      next_message_id: Math.max(0, ...messageList.map((message) => parseId(message.id, "MSG-"))) + 1,
    },
    stats: {
      open_tasks: taskList.filter((task) => ["open", "assigned", "in_progress", "to_verify"].includes(task.status)).length,
      blocked_tasks: taskList.filter((task) => task.status === "blocked").length,
      pending_messages: messageList.filter((message) => message.delivery_status === "pending").length,
      active_workers: workerList.length,
      artifacts: artifactList.length,
    },
  };

  await writeJSON(snapshotPath(), snapshot);
  return snapshot;
}

export async function readProjectSnapshot(): Promise<ProjectSnapshot> {
  ensureProjectLayout();
  const snapshot = await readJSON<ProjectSnapshot | null>(snapshotPath(), null);
  if (snapshot) {
    return snapshot;
  }
  return rebuildProjectSnapshotFromEvents();
}

export async function recordKernelEvent(event: KernelEvent): Promise<void> {
  ensureProjectLayout();
  appendJSONL(eventsPath(), event);
  appendJSONL(legacyEventLogPath(), event as Record<string, unknown>);
  await rebuildProjectSnapshotFromEvents();
}

export function emptySnapshot(): ProjectSnapshot {
  return structuredClone(DEFAULT_PROJECT_SNAPSHOT);
}
