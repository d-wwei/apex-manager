import { spawnSync } from "child_process";
import { existsSync, readFileSync, readdirSync, watch, type FSWatcher } from "fs";
import { basename, dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { readJSON } from "../utils/json.js";
import { readKernelEvents } from "../utils/events.js";
import { detectAdapter } from "../worker/terminal.js";
import { checkWorkerHealth, listWorkers, type WorkerHealth, type WorkerInfo } from "../worker/monitor.js";
import type { TaskStore, TaskStatus } from "../types/task.js";
import type { ArtifactStore } from "../types/artifact.js";
import type { MessageStore } from "../types/message.js";

const ORCH_LOCK_PATH = ".apex-manager/orch.lock";
const NOTIFICATIONS_DIR = ".apex-manager/notifications";
const DEFAULT_REFRESH_MS = 2_000;
const DEFAULT_WORKER_LIMIT = 6;
const DEFAULT_EVENT_LIMIT = 8;
const DEFAULT_NOTIFICATION_LIMIT = 3;
const WATCH_DEBOUNCE_MS = 180;

export const MONEY_COME_TO_ELI_EN = [
  "\ud83d\udcb8 Money has accepted the assignment: come to Eli.",
  "",
  "Fortune Buff +1 activated.",
  "May your code compile, your PR pass, your charts go green, and your luck compound daily.",
].join("\n");

export const MONEY_COME_TO_ELI_ZH = [
  "\ud83c\udf89 \u9690\u85cf\u5f69\u86cb\u5df2\u89e6\u53d1\uff1aEli \u8d22\u8fd0 +1",
  "\u4eca\u65e5\u597d\u8fd0 Buff \u5df2\u751f\u6548\uff0c\u613f\u4f60\u7684\u4efb\u52a1\u4e00\u8def\u7eff\u706f\uff0cPR \u4e00\u6b21\u901a\u8fc7\uff0c\u6536\u76ca\u66f2\u7ebf\u7a33\u6b65\u5411\u4e0a\u3002",
].join("\n");

interface DaemonStatus {
  running: boolean;
  pid?: number;
  sessionId?: string;
  startedAt?: string;
}

interface WorkerView {
  taskId: string;
  title: string;
  agent: string;
  label: string;
  detail: string;
}

interface EventView {
  timestamp: string;
  type: string;
}

interface NotificationView {
  createdAt: string;
  message: string;
}

interface WarRoomWatchLayout {
  baseTargets: string[];
  workerTargets: string[];
}

export interface WarRoomData {
  projectName: string;
  projectRoot: string;
  generatedAt: string;
  readiness: "GREEN" | "YELLOW" | "RED";
  isolation: string;
  terminalAdapter: string;
  daemon: DaemonStatus;
  taskCounts: Record<TaskStatus, number> & { total: number };
  workerCounts: {
    total: number;
    alive: number;
    starting: number;
    completed: number;
    crashed: number;
    exitedWithoutResult: number;
    stale: number;
  };
  pendingMessages: number;
  unreadNotifications: number;
  artifactCount: number;
  workerViews: WorkerView[];
  moreWorkers: number;
  events: EventView[];
  moreEvents: number;
  notifications: NotificationView[];
  moreNotifications: number;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function escapeForAppleScript(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveRepoLocalLauncher(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (true) {
    const launcher = join(dir, "bin", "apex-manager.sh");
    if (existsSync(launcher)) {
      return launcher;
    }

    const parent = dirname(dir);
    if (parent === dir) {
      return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "apex-manager.sh");
    }
    dir = parent;
  }
}

function fitLine(line: string, width: number): string {
  if (width <= 0) return "";
  if (line.length <= width) return line;
  if (width <= 1) return line.slice(0, width);
  return `${line.slice(0, Math.max(0, width - 1))}\u2026`;
}

function rule(width: number, char = "\u2500"): string {
  return char.repeat(Math.max(10, width));
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toISOString().replace("T", " ").replace(".000Z", "Z");
}

function timeAgo(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.max(0, Math.floor(diffMs / 60_000));
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;
  const diffDay = Math.floor(diffHour / 24);
  return `${diffDay}d ago`;
}

function taskStatusCounts(tasks: TaskStore["tasks"]): WarRoomData["taskCounts"] {
  return {
    total: tasks.length,
    open: tasks.filter((task) => task.status === "open").length,
    assigned: tasks.filter((task) => task.status === "assigned").length,
    in_progress: tasks.filter((task) => task.status === "in_progress").length,
    to_verify: tasks.filter((task) => task.status === "to_verify").length,
    blocked: tasks.filter((task) => task.status === "blocked").length,
    done: tasks.filter((task) => task.status === "done").length,
  };
}

function classifyWorkerLabel(info: WorkerInfo, health: WorkerHealth): { label: string; detail: string } {
  if (health.completed) {
    const verdict = info.result?.verdict ?? "unknown";
    return { label: `COMPLETED/${verdict.toUpperCase()}`, detail: info.result?.summary ?? "result.json captured" };
  }
  if (health.starting) {
    return { label: "STARTING", detail: "kickoff sequence in progress" };
  }
  if (health.crashed) {
    return { label: "CRASHED", detail: "terminal exited before result.json" };
  }
  if (health.exitedWithoutResult) {
    return { label: "EXITED", detail: "one-shot agent exited without result.json" };
  }
  if (health.stale) {
    return { label: "STALE", detail: info.status?.progress ?? "no recent activity" };
  }
  if (health.alive) {
    return {
      label: "RUNNING",
      detail: [info.status?.stage, info.status?.progress].filter(Boolean).join(" / ") || "active",
    };
  }
  return { label: "UNKNOWN", detail: "worker registered but health is unclear" };
}

function inspectDaemonStatus(): DaemonStatus {
  if (!existsSync(ORCH_LOCK_PATH)) {
    return { running: false };
  }

  try {
    const raw = JSON.parse(readFileSync(ORCH_LOCK_PATH, "utf-8")) as {
      pid?: number;
      session_id?: string;
      started_at?: string;
    };

    const pid = raw.pid;
    let alive = false;
    if (typeof pid === "number") {
      try {
        process.kill(pid, 0);
        alive = true;
      } catch {
        alive = false;
      }
    }

    return {
      running: alive,
      pid,
      sessionId: raw.session_id,
      startedAt: raw.started_at,
    };
  } catch {
    return { running: false };
  }
}

function detectTerminalAdapterName(): string {
  try {
    return detectAdapter().name();
  } catch {
    return "none";
  }
}

function detectIsolation(workerViews: WorkerInfo[]): string {
  const gitCount = workerViews.filter((worker) => worker.meta.isolation_mode === "git-worktree").length;
  const rootCount = workerViews.filter((worker) => worker.meta.isolation_mode === "project-root").length;

  if (gitCount > 0 && rootCount === 0) {
    return "git-worktree";
  }
  if (gitCount > 0 && rootCount > 0) {
    return `mixed (${gitCount} worktree / ${rootCount} shared-root)`;
  }
  if (rootCount > 0) {
    return "shared project-root";
  }

  const gitRepo = spawnSync("git", ["rev-parse", "--git-dir"], { encoding: "utf-8", timeout: 5_000 });
  return gitRepo.status === 0 ? "git repo ready" : "shared project-root";
}

function readUnreadNotifications(limit: number): { total: number; items: NotificationView[] } {
  if (!existsSync(NOTIFICATIONS_DIR)) {
    return { total: 0, items: [] };
  }

  const files = readdirSync(NOTIFICATIONS_DIR)
    .filter((file) => file.endsWith(".json") && !file.includes(".processed."))
    .sort();

  const items: NotificationView[] = [];
  for (const file of files.slice(0, limit)) {
    try {
      const data = JSON.parse(readFileSync(join(NOTIFICATIONS_DIR, file), "utf-8")) as { created_at?: string; message?: string };
      items.push({
        createdAt: data.created_at ?? file,
        message: data.message ?? "(empty notification)",
      });
    } catch {
      items.push({
        createdAt: file,
        message: "(malformed notification)",
      });
    }
  }

  return { total: files.length, items };
}

function computeReadiness(
  daemon: DaemonStatus,
  workerCounts: WarRoomData["workerCounts"],
  taskCounts: WarRoomData["taskCounts"],
): WarRoomData["readiness"] {
  if (workerCounts.crashed > 0 || workerCounts.exitedWithoutResult > 0) {
    return "RED";
  }
  if (!daemon.running || taskCounts.blocked > 0 || workerCounts.stale > 0) {
    return "YELLOW";
  }
  return "GREEN";
}

export function formatMoneyComeToEliBanner(): string {
  return `${MONEY_COME_TO_ELI_EN}\n\n${MONEY_COME_TO_ELI_ZH}`;
}

export function describeWarRoomWatchLayout(projectRoot: string): WarRoomWatchLayout {
  const apexRoot = join(projectRoot, ".apex-manager");
  const workersRoot = join(apexRoot, "workers");

  const baseTargets = [
    join(apexRoot, "tasks.json"),
    join(apexRoot, "events.jsonl"),
    join(apexRoot, "artifacts", "index.json"),
    join(apexRoot, "messages", "index.json"),
    join(apexRoot, "notifications"),
    workersRoot,
  ].filter((target, index, all) => all.indexOf(target) === index);

  const workerTargets = existsSync(workersRoot)
    ? readdirSync(workersRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(workersRoot, entry.name))
    : [];

  return { baseTargets, workerTargets };
}

function createWarRoomWatchers(projectRoot: string, onChange: () => void): () => void {
  const watchers = new Map<string, FSWatcher>();
  let closed = false;
  let recursiveWorkersWatch = false;

  const closeWatcher = (target: string): void => {
    const watcher = watchers.get(target);
    if (!watcher) return;
    try {
      watcher.close();
    } catch {}
    watchers.delete(target);
  };

  const watchTarget = (target: string, options?: { recursive?: boolean }): boolean => {
    if (closed || watchers.has(target) || !existsSync(target)) {
      return watchers.has(target);
    }

    try {
      const watcher = watch(target, options ?? {}, () => {
        onChange();
        if (target.endsWith("/workers") || target.endsWith("\\workers")) {
          syncWorkerWatches();
        }
      });
      watcher.on("error", () => {
        if (!closed) {
          onChange();
        }
      });
      watchers.set(target, watcher);
      return true;
    } catch {
      return false;
    }
  };

  const syncWorkerWatches = (): void => {
    if (closed || recursiveWorkersWatch) return;
    const layout = describeWarRoomWatchLayout(projectRoot);
    const desired = new Set(layout.workerTargets);

    for (const target of watchers.keys()) {
      if (target.includes(`${join(".apex-manager", "workers")}${process.platform === "win32" ? "\\" : "/"}`) && !desired.has(target)) {
        closeWatcher(target);
      }
    }

    for (const target of desired) {
      watchTarget(target);
    }
  };

  const layout = describeWarRoomWatchLayout(projectRoot);
  for (const target of layout.baseTargets) {
    const isWorkersRoot = target === join(projectRoot, ".apex-manager", "workers");
    if (isWorkersRoot) {
      recursiveWorkersWatch = watchTarget(target, { recursive: true });
      if (!recursiveWorkersWatch) {
        watchTarget(target);
      }
      continue;
    }

    watchTarget(target);
  }

  syncWorkerWatches();

  return () => {
    closed = true;
    for (const target of [...watchers.keys()]) {
      closeWatcher(target);
    }
  };
}

export function moneyComeToEliForegroundCommand(projectRoot: string): string {
  const launcher = resolveRepoLocalLauncher();
  return `cd ${shellQuote(projectRoot)} && ${shellQuote(launcher)} orch Money-Come-To-Eli --foreground`;
}

export function launchMoneyComeToEliViewer(projectRoot: string): {
  ok: boolean;
  mode: string;
  command: string;
  reason?: string;
} {
  const command = moneyComeToEliForegroundCommand(projectRoot);

  if (process.platform === "darwin") {
    const term = process.env.TERM_PROGRAM ?? "";
    const appleScript = term === "iTerm.app"
      ? `tell application "iTerm2"
  create window with default profile command "${escapeForAppleScript(command)}"
end tell`
      : `tell application "Terminal" to do script "${escapeForAppleScript(command)}"`;
    const result = spawnSync("osascript", ["-e", appleScript], { encoding: "utf-8", timeout: 10_000 });
    return {
      ok: result.status === 0,
      mode: term === "iTerm.app" ? "iterm2-window" : "terminal-window",
      command,
      reason: result.status === 0 ? undefined : ((result.stderr ?? result.stdout ?? "").trim() || "osascript failed"),
    };
  }

  if (process.platform === "linux") {
    const candidates: Array<{ bin: string; args: string[]; mode: string }> = [
      { bin: "x-terminal-emulator", args: ["-e", "sh", "-lc", command], mode: "x-terminal-emulator" },
      { bin: "gnome-terminal", args: ["--", "bash", "-lc", command], mode: "gnome-terminal" },
      { bin: "xterm", args: ["-e", "sh", "-lc", command], mode: "xterm" },
    ];

    if (process.env.WSL_DISTRO_NAME) {
      candidates.unshift({ bin: "wt.exe", args: ["new-tab", "wsl", "--", "sh", "-lc", command], mode: "windows-terminal" });
    }

    for (const candidate of candidates) {
      const result = spawnSync(candidate.bin, candidate.args, { encoding: "utf-8", timeout: 10_000 });
      if (result.status === 0) {
        return { ok: true, mode: candidate.mode, command };
      }
    }

    return { ok: false, mode: "linux-terminal", command, reason: "no supported terminal launcher succeeded" };
  }

  return { ok: false, mode: process.platform, command, reason: "unsupported platform for detached viewer launch" };
}

export async function collectWarRoomData(): Promise<WarRoomData> {
  const projectRoot = process.cwd();
  const tasksStore = await readJSON<TaskStore>(".apex-manager/tasks.json", { tasks: [], next_id: 1 });
  const artifactStore = await readJSON<ArtifactStore>(".apex-manager/artifacts/index.json", { artifacts: [], next_id: 1 });
  const messageStore = await readJSON<MessageStore>(".apex-manager/messages/index.json", { messages: [], next_id: 1 });
  const workers = await listWorkers();
  const events = await readKernelEvents();
  const daemon = inspectDaemonStatus();
  const terminalAdapter = detectTerminalAdapterName();
  const taskCounts = taskStatusCounts(tasksStore.tasks);

  const taskTitles = new Map(tasksStore.tasks.map((task) => [task.id, task.title]));

  const workerViewsUnbounded: WorkerView[] = [];
  let alive = 0;
  let starting = 0;
  let completed = 0;
  let crashed = 0;
  let exitedWithoutResult = 0;
  let stale = 0;

  for (const worker of workers) {
    let health: WorkerHealth;
    let classified: { label: string; detail: string };
    try {
      health = await checkWorkerHealth(worker.meta.task_id);
      classified = classifyWorkerLabel(worker, health);
    } catch (error) {
      health = {
        alive: false,
        starting: false,
        stale: false,
        completed: false,
        crashed: false,
        exitedWithoutResult: false,
      };
      classified = {
        label: "UNKNOWN",
        detail: `health unavailable: ${errorMessage(error)}`,
      };
    }

    if (health.alive) alive += 1;
    if (health.starting) starting += 1;
    if (health.completed) completed += 1;
    if (health.crashed) crashed += 1;
    if (health.exitedWithoutResult) exitedWithoutResult += 1;
    if (health.stale) stale += 1;

    workerViewsUnbounded.push({
      taskId: worker.meta.task_id,
      title: taskTitles.get(worker.meta.task_id) ?? "(untitled task)",
      agent: worker.meta.agent,
      label: classified.label,
      detail: classified.detail,
    });
  }

  const notifications = readUnreadNotifications(DEFAULT_NOTIFICATION_LIMIT);
  const eventViews = events
    .slice(Math.max(0, events.length - DEFAULT_EVENT_LIMIT))
    .map((event) => ({
      timestamp: event.timestamp,
      type: event.type,
    }));

  const workerViews = workerViewsUnbounded.slice(0, DEFAULT_WORKER_LIMIT);
  const workerCounts = {
    total: workers.length,
    alive,
    starting,
    completed,
    crashed,
    exitedWithoutResult,
    stale,
  };

  return {
    projectName: basename(projectRoot),
    projectRoot,
    generatedAt: new Date().toISOString(),
    readiness: computeReadiness(daemon, workerCounts, taskCounts),
    isolation: detectIsolation(workers),
    terminalAdapter,
    daemon,
    taskCounts,
    workerCounts,
    pendingMessages: messageStore.messages.filter((message) => message.delivery_status === "pending").length,
    unreadNotifications: notifications.total,
    artifactCount: artifactStore.artifacts.length,
    workerViews,
    moreWorkers: Math.max(0, workerViewsUnbounded.length - workerViews.length),
    events: eventViews,
    moreEvents: Math.max(0, events.length - eventViews.length),
    notifications: notifications.items,
    moreNotifications: Math.max(0, notifications.total - notifications.items.length),
  };
}

export function renderWarRoom(data: WarRoomData, viewport?: { width?: number }): string {
  const width = Math.max(60, viewport?.width ?? 100);
  const lines: string[] = [];
  const push = (line = "") => lines.push(fitLine(line, width));

  push(rule(width, "="));
  push(`MONEY-COME-TO-ELI // WAR ROOM    Fortune Buff +1 active    ${formatTimestamp(data.generatedAt)}`);
  push(`Project: ${data.projectName}    Readiness: ${data.readiness}    Exit: q / Ctrl-C    Refresh: auto`);
  push(rule(width));
  push(`Environment  daemon=${data.daemon.running ? "RUNNING" : "STOPPED"}  terminal=${data.terminalAdapter}  isolation=${data.isolation}`);
  push(`Project Root  ${data.projectRoot}`);
  if (data.daemon.pid || data.daemon.sessionId) {
    push(`Daemon Info   pid=${data.daemon.pid ?? "-"}  session=${data.daemon.sessionId ?? "-"}  since=${data.daemon.startedAt ? timeAgo(data.daemon.startedAt) : "-"}`);
  }
  push("");
  push(`Mission State`);
  push(`  Tasks     total=${data.taskCounts.total}  open=${data.taskCounts.open}  assigned=${data.taskCounts.assigned}  in_progress=${data.taskCounts.in_progress}  to_verify=${data.taskCounts.to_verify}  blocked=${data.taskCounts.blocked}  done=${data.taskCounts.done}`);
  push(`  Workers   total=${data.workerCounts.total}  alive=${data.workerCounts.alive}  starting=${data.workerCounts.starting}  completed=${data.workerCounts.completed}  stale=${data.workerCounts.stale}  crashed=${data.workerCounts.crashed}  exited=${data.workerCounts.exitedWithoutResult}`);
  push(`  Signals   pending_messages=${data.pendingMessages}  unread_notifications=${data.unreadNotifications}  artifacts=${data.artifactCount}`);
  push("");
  push("Active Units");
  if (data.workerViews.length === 0) {
    push("  (no workers registered)");
  } else {
    for (const worker of data.workerViews) {
      push(`  ${worker.taskId.padEnd(10)} ${worker.agent.padEnd(8)} ${worker.label.padEnd(16)} ${worker.title}`);
      push(`    ${worker.detail}`);
    }
    if (data.moreWorkers > 0) {
      push(`  ... +${data.moreWorkers} more workers`);
    }
  }
  push("");
  push("Recent Events");
  if (data.events.length === 0) {
    push("  (no events yet)");
  } else {
    for (const event of data.events) {
      push(`  ${timeAgo(event.timestamp).padEnd(10)} ${event.type}`);
    }
    if (data.moreEvents > 0) {
      push(`  ... +${data.moreEvents} older events`);
    }
  }
  push("");
  push("Unread Notifications");
  if (data.notifications.length === 0) {
    push("  (none)");
  } else {
    for (const notification of data.notifications) {
      push(`  ${timeAgo(notification.createdAt).padEnd(10)} ${notification.message}`);
    }
    if (data.moreNotifications > 0) {
      push(`  ... +${data.moreNotifications} more notifications`);
    }
  }
  push("");
  push("Tip: this dashboard is a foreground terminal process in the current shell, not a detached web server.");

  return lines.join("\n");
}

function renderWarRoomError(error: unknown, viewport?: { width?: number }): string {
  const width = Math.max(60, viewport?.width ?? 100);
  const lines = [
    rule(width, "="),
    `MONEY-COME-TO-ELI // WAR ROOM    Refresh temporarily failed    ${formatTimestamp(new Date().toISOString())}`,
    rule(width),
    `Error: ${errorMessage(error)}`,
    "",
    "The dashboard is still running. Waiting for the next file event or polling refresh.",
    "Exit: q / Ctrl-C    Manual refresh: r",
  ];
  return lines.map((line) => fitLine(line, width)).join("\n");
}

export async function runMoneyComeToEli(args: string[]): Promise<void> {
  const once = args.includes("--once");
  const foreground = args.includes("--foreground");
  const refreshArg = args.indexOf("--refresh");
  const refreshMs = refreshArg >= 0 && args[refreshArg + 1]
    ? Math.max(500, Number(args[refreshArg + 1]) || DEFAULT_REFRESH_MS)
    : DEFAULT_REFRESH_MS;

  if (!once && !foreground) {
    console.log(formatMoneyComeToEliBanner());
    const launched = launchMoneyComeToEliViewer(process.cwd());
    if (launched.ok) {
      console.log("");
      console.log(`Money-Come-To-Eli war-room launched in a separate ${launched.mode}.`);
      console.log("Your current terminal stays free.");
      return;
    }

    console.error("");
    console.error(`Money-Come-To-Eli could not open a separate terminal window automatically: ${launched.reason ?? "unknown error"}`);
    console.error(`Manual fallback: ${launched.command}`);
    process.exitCode = 1;
    return;
  }

  console.log(formatMoneyComeToEliBanner());

  if (once || !process.stdout.isTTY || !process.stdin.isTTY) {
    const data = await collectWarRoomData();
    process.stdout.write(`\n${renderWarRoom(data, { width: process.stdout.columns })}\n`);
    return;
  }

  await delay(900);

  const stdout = process.stdout;
  const stdin = process.stdin;
  let closed = false;
  let rendering = false;
  let rerenderRequested = false;
  let interval: NodeJS.Timeout | null = null;
  let debounceTimer: NodeJS.Timeout | null = null;
  const stopWatching = createWarRoomWatchers(process.cwd(), () => {
    if (closed) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void renderFrame();
    }, WATCH_DEBOUNCE_MS);
  });

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    if (interval) clearInterval(interval);
    if (debounceTimer) clearTimeout(debounceTimer);
    stopWatching();
    stdout.write("\u001b[?25h");
    stdout.write("\u001b[?1049l");
    if (stdin.isTTY && typeof stdin.setRawMode === "function") {
      stdin.setRawMode(false);
    }
    stdin.pause();
    stdin.removeListener("data", onData);
    process.removeListener("SIGWINCH", onResize);
  };

  const renderFrame = async (): Promise<void> => {
    if (closed) return;
    if (rendering) {
      rerenderRequested = true;
      return;
    }

    rendering = true;
    try {
      const data = await collectWarRoomData();
      const screen = renderWarRoom(data, { width: stdout.columns });
      stdout.write("\u001b[H\u001b[2J");
      stdout.write(`${screen}\n`);
    } catch (error) {
      const screen = renderWarRoomError(error, { width: stdout.columns });
      stdout.write("\u001b[H\u001b[2J");
      stdout.write(`${screen}\n`);
    } finally {
      rendering = false;
      if (rerenderRequested && !closed) {
        rerenderRequested = false;
        await renderFrame();
      }
    }
  };

  const onResize = (): void => {
    void renderFrame();
  };

  const onData = (chunk: Buffer | string): void => {
    const text = chunk.toString("utf-8");
    if (text === "q" || text === "Q" || text === "\u0003") {
      cleanup();
      return;
    }
    if (text === "r" || text === "R") {
      void renderFrame();
    }
  };

  stdout.write("\u001b[?1049h");
  stdout.write("\u001b[?25l");
  stdin.setEncoding("utf-8");
  stdin.resume();
  if (typeof stdin.setRawMode === "function") {
    stdin.setRawMode(true);
  }
  stdin.on("data", onData);
  process.on("SIGWINCH", onResize);

  await renderFrame();
  interval = setInterval(() => {
    void renderFrame();
  }, refreshMs);
}
