import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ── Helpers ────────────────────────────────────────────────────────

function makeTmpDir(): string {
  const dir = join(tmpdir(), `am-worker-status-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeWorkerFile(dir: string, taskId: string, file: string, data: unknown): void {
  const wdir = join(dir, ".apex-manager", "workers", taskId);
  mkdirSync(wdir, { recursive: true });
  writeFileSync(join(wdir, file), JSON.stringify(data, null, 2));
}

function makeMeta(taskId: string, agent = "claude", startedAt?: string) {
  return {
    task_id: taskId,
    window_handle: null,
    worktree_path: `.apex-manager/worktrees/${taskId}`,
    branch: `apex-mgr/${taskId}`,
    started_at: startedAt ?? new Date().toISOString(),
    agent,
  };
}

// ── Setup / Teardown ──────────────────────────────────────────────

let tmpDir: string;
let origCwd: string;
let origLog: typeof console.log;
let origError: typeof console.error;
let origExit: typeof process.exit;
let logOutput: string[];
let errorOutput: string[];

beforeEach(() => {
  tmpDir = makeTmpDir();
  origCwd = process.cwd();
  process.chdir(tmpDir);
  mkdirSync(join(tmpDir, ".apex-manager", "workers"), { recursive: true });

  logOutput = [];
  errorOutput = [];
  origLog = console.log;
  origError = console.error;
  origExit = process.exit;
  console.log = (...args: any[]) => { logOutput.push(args.map(String).join(" ")); };
  console.error = (...args: any[]) => { errorOutput.push(args.map(String).join(" ")); };
  process.exit = ((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as any;
});

afterEach(() => {
  process.chdir(origCwd);
  console.log = origLog;
  console.error = origError;
  process.exit = origExit;
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

// ── timeAgo ───────────────────────────────────────────────────────

describe("timeAgo", () => {
  it("returns 'just now' for recent timestamps", async () => {
    const { timeAgo } = await import("../../src/commands/worker.js");
    const now = new Date().toISOString();
    assert.strictEqual(timeAgo(now), "just now");
  });

  it("returns minutes for timestamps within the hour", async () => {
    const { timeAgo } = await import("../../src/commands/worker.js");
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    assert.strictEqual(timeAgo(fiveMinAgo), "5 min ago");
  });

  it("returns hours for timestamps within the day", async () => {
    const { timeAgo } = await import("../../src/commands/worker.js");
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    assert.strictEqual(timeAgo(twoHoursAgo), "2 hr ago");
  });

  it("returns days for older timestamps", async () => {
    const { timeAgo } = await import("../../src/commands/worker.js");
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    assert.strictEqual(timeAgo(threeDaysAgo), "3 days ago");
  });

  it("returns '1 min ago' for 90 seconds", async () => {
    const { timeAgo } = await import("../../src/commands/worker.js");
    const ninetySecAgo = new Date(Date.now() - 90 * 1000).toISOString();
    assert.strictEqual(timeAgo(ninetySecAgo), "1 min ago");
  });
});

// ── list ──────────────────────────────────────────────────────────

describe("apex worker list", () => {
  it("prints table header and worker rows", async () => {
    // Set up a completed worker
    const started = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    writeWorkerFile(tmpDir, "T1", "meta.json", makeMeta("T1", "claude", started));
    writeWorkerFile(tmpDir, "T1", "status.json", {
      task_id: "T1", stage: "review", progress: "3/5", last_activity: new Date().toISOString(), errors: [],
    });
    writeWorkerFile(tmpDir, "T1", "result.json", {
      task_id: "T1", verdict: "pass", summary: "Done", findings: [], completed_at: new Date().toISOString(), branch: "apex-mgr/T1", commit: "abc",
    });

    const { cmdWorker } = await import("../../src/commands/worker.js");
    await cmdWorker(["list"]);

    const output = logOutput.join("\n");
    assert.ok(output.includes("ID"));
    assert.ok(output.includes("Agent"));
    assert.ok(output.includes("Stage"));
    assert.ok(output.includes("Status"));
    assert.ok(output.includes("T1"));
    assert.ok(output.includes("claude"));
    assert.ok(output.includes("review"));
    assert.ok(output.includes("completed"));
  });

  it("prints 'No workers' when none exist", async () => {
    // Empty workers dir already exists from beforeEach
    const { cmdWorker } = await import("../../src/commands/worker.js");
    await cmdWorker(["list"]);

    const output = logOutput.join("\n");
    assert.ok(output.includes("No workers"));
  });

  it("shows CRASHED status for dead worker", async () => {
    writeWorkerFile(tmpDir, "T3", "meta.json", {
      ...makeMeta("T3", "gemini"),
      pid: 2147483647, // non-existent PID
    });

    const { cmdWorker } = await import("../../src/commands/worker.js");
    await cmdWorker(["list"]);

    const output = logOutput.join("\n");
    assert.ok(output.includes("T3"));
    assert.ok(output.includes("CRASHED"));
  });
});

// ── status ────────────────────────────────────────────────────────

describe("apex worker status", () => {
  it("prints detailed info for a valid worker", async () => {
    writeWorkerFile(tmpDir, "T1", "meta.json", makeMeta("T1", "claude"));
    writeWorkerFile(tmpDir, "T1", "status.json", {
      task_id: "T1", stage: "execute", progress: "3/5 subtasks done",
      last_activity: new Date().toISOString(), errors: [],
    });

    const { cmdWorker } = await import("../../src/commands/worker.js");
    await cmdWorker(["status", "T1"]);

    const output = logOutput.join("\n");
    assert.ok(output.includes("Worker T1"));
    assert.ok(output.includes("claude"));
    assert.ok(output.includes("execute"));
    assert.ok(output.includes("3/5 subtasks done"));
  });

  it("shows verdict and summary for completed worker", async () => {
    writeWorkerFile(tmpDir, "T1", "meta.json", makeMeta("T1", "claude"));
    writeWorkerFile(tmpDir, "T1", "result.json", {
      task_id: "T1", verdict: "pass", summary: "All tests green",
      findings: [], completed_at: new Date().toISOString(), branch: "apex-mgr/T1", commit: "abc",
    });

    const { cmdWorker } = await import("../../src/commands/worker.js");
    await cmdWorker(["status", "T1"]);

    const output = logOutput.join("\n");
    assert.ok(output.includes("pass"));
    assert.ok(output.includes("All tests green"));
  });

  it("exits with error for missing task-id argument", async () => {
    const { cmdWorker } = await import("../../src/commands/worker.js");
    try {
      await cmdWorker(["status"]);
    } catch (e: any) {
      assert.ok(e.message.includes("process.exit(1)"));
    }
    const output = errorOutput.join("\n");
    assert.ok(output.includes("Usage"));
  });

  it("exits with error for non-existent worker", async () => {
    const { cmdWorker } = await import("../../src/commands/worker.js");
    try {
      await cmdWorker(["status", "T999"]);
    } catch (e: any) {
      assert.ok(e.message.includes("process.exit(1)"));
    }
    const output = errorOutput.join("\n");
    assert.ok(output.includes("T999"));
  });
});

// ── report ────────────────────────────────────────────────────────

describe("apex worker report", () => {
  it("includes monitor report section", async () => {
    writeWorkerFile(tmpDir, "T1", "meta.json", {
      ...makeMeta("T1", "claude"),
      pid: undefined,
    });
    writeWorkerFile(tmpDir, "T1", "result.json", {
      task_id: "T1", verdict: "pass", summary: "OK",
      findings: [], completed_at: new Date().toISOString(), branch: "apex-mgr/T1", commit: "abc",
    });

    const { cmdWorker } = await import("../../src/commands/worker.js");
    await cmdWorker(["report"]);

    const output = logOutput.join("\n");
    assert.ok(output.includes("T1"));
  });

  it("includes cost section header", async () => {
    const { cmdWorker } = await import("../../src/commands/worker.js");
    await cmdWorker(["report"]);

    const output = logOutput.join("\n");
    // Should have cost section (even if empty)
    assert.ok(output.includes("Cost"));
  });

  it("includes rate limit section header", async () => {
    const { cmdWorker } = await import("../../src/commands/worker.js");
    await cmdWorker(["report"]);

    const output = logOutput.join("\n");
    // Should have rate limit section (even if no data)
    assert.ok(output.includes("Rate"));
  });
});
