import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { DEFAULT_AGENTS } from "../worker/agent-adapter.js";
import type { ArtifactStore } from "../types/artifact.js";
import type { MessageStore } from "../types/message.js";
import type { ProjectSnapshot } from "../types/state.js";
import type { TaskStore } from "../types/task.js";

export const APEX_DIR = ".apex-manager";

export const DEFAULT_TASK_STORE: TaskStore = {
  tasks: [],
  next_id: 1,
};

export const DEFAULT_ARTIFACT_STORE: ArtifactStore = {
  artifacts: [],
  next_id: 1,
};

export const DEFAULT_MESSAGE_STORE: MessageStore = {
  messages: [],
  next_id: 1,
};

export const DEFAULT_PROJECT_SNAPSHOT: ProjectSnapshot = {
  generated_at: new Date(0).toISOString(),
  tasks: [],
  artifacts: [],
  messages: [],
  workers: [],
  counters: {
    next_task_id: 1,
    next_artifact_id: 1,
    next_message_id: 1,
  },
  stats: {
    open_tasks: 0,
    blocked_tasks: 0,
    pending_messages: 0,
    active_workers: 0,
    artifacts: 0,
  },
};

const DEFAULT_CONFIG_YAML = `# Apex Manager project config
max_concurrent_workers: 3
worker_default_agent: claude
rate_limit_enabled: false
rate_limit_threshold: 50
budget_usd: 0
budget_warn: 0
polling_interval_ms: 10000
`;

export function apexPath(...parts: string[]): string {
  return join(process.cwd(), APEX_DIR, ...parts);
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function writeFileIfMissing(path: string, content: string): void {
  if (!existsSync(path)) {
    writeFileSync(path, content);
  }
}

export function ensureProjectLayout(): void {
  ensureDir(apexPath());
  ensureDir(apexPath("workers"));
  ensureDir(apexPath("worktrees"));
  ensureDir(apexPath("notifications"));
  ensureDir(apexPath("artifacts"));
  ensureDir(apexPath("messages"));

  writeFileIfMissing(apexPath("config.yaml"), DEFAULT_CONFIG_YAML);
  writeFileIfMissing(apexPath("tasks.json"), JSON.stringify(DEFAULT_TASK_STORE, null, 2) + "\n");
  writeFileIfMissing(apexPath("agents.json"), JSON.stringify(DEFAULT_AGENTS, null, 2) + "\n");
  writeFileIfMissing(apexPath("artifacts", "index.json"), JSON.stringify(DEFAULT_ARTIFACT_STORE, null, 2) + "\n");
  writeFileIfMissing(apexPath("messages", "index.json"), JSON.stringify(DEFAULT_MESSAGE_STORE, null, 2) + "\n");
  writeFileIfMissing(apexPath("events.jsonl"), "");
  writeFileIfMissing(apexPath("event-log.jsonl"), "");
  writeFileIfMissing(apexPath("state.snapshot.json"), JSON.stringify(DEFAULT_PROJECT_SNAPSHOT, null, 2) + "\n");
}
