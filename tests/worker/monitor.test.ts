import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  listWorkers,
  checkWorkerHealth,
  getMonitorReport,
  type WorkerStatus,
  type WorkerResult,
  type WorkerMeta,
  type WorkerHealth,
  type WorkerInfo,
} from "../../src/worker/monitor.js";

let testDir: string;
let originalCwd: string;
let originalPath: string | undefined;

// ── Helpers ────────────────────────────────────────────────────────

function writeWorkerFile(taskId: string, file: string, data: unknown): void {
  const dir = join(testDir, ".apex-manager", "workers", taskId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), JSON.stringify(data, null, 2));
}

function makeMeta(taskId: string, overrides: Partial<WorkerMeta> = {}): WorkerMeta {
  return {
    task_id: taskId,
    pid: 99999,
    window_handle: { id: "surf-1", name: `${taskId}-slug`, adapter: "cmux" },
    worktree_path: `.apex-manager/worktrees/${taskId}`,
    branch: `apex-mgr/${taskId}`,
    started_at: new Date().toISOString(),
    agent: "claude",
    ...overrides,
  };
}

function makeStatus(overrides: Partial<WorkerStatus> = {}): WorkerStatus {
  return {
    task_id: "T1",
    stage: "implement",
    progress: "3/5 tests passing",
    last_activity: new Date().toISOString(),
    errors: [],
    ...overrides,
  };
}

function makeResult(overrides: Partial<WorkerResult> = {}): WorkerResult {
  return {
    task_id: "T1",
    verdict: "pass",
    summary: "All tests passing",
    findings: ["Implemented auth module", "Added 5 tests"],
    completed_at: new Date().toISOString(),
    branch: "apex-mgr/T1",
    commit: "abc1234",
    ...overrides,
  };
}

function installFakeCmux(script: string): void {
  const binDir = join(testDir, "bin");
  mkdirSync(binDir, { recursive: true });
  const scriptPath = join(binDir, "cmux");
  writeFileSync(scriptPath, script);
  chmodSync(scriptPath, 0o755);
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
}

// ── Setup / Teardown ───────────────────────────────────────────────

beforeEach(() => {
  originalCwd = process.cwd();
  originalPath = process.env.PATH;
  testDir = join(tmpdir(), `am-test-monitor-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(testDir, { recursive: true });
  process.chdir(testDir);
  mkdirSync(".apex-manager/workers", { recursive: true });
});

afterEach(() => {
  process.chdir(originalCwd);
  process.env.PATH = originalPath;
  rmSync(testDir, { recursive: true, force: true });
});

// ─── listWorkers ───────────────────────────────────────────────────

describe("listWorkers", () => {
  it("returns empty array when no workers exist", async () => {
    const workers = await listWorkers();
    assert.deepStrictEqual(workers, []);
  });

  it("returns workers with meta only", async () => {
    const meta = makeMeta("T1");
    writeWorkerFile("T1", "meta.json", meta);

    const workers = await listWorkers();
    assert.strictEqual(workers.length, 1);
    assert.strictEqual(workers[0].meta.task_id, "T1");
    assert.strictEqual(workers[0].status, null);
    assert.strictEqual(workers[0].result, null);
  });

  it("returns workers with meta + status", async () => {
    writeWorkerFile("T1", "meta.json", makeMeta("T1"));
    writeWorkerFile("T1", "status.json", makeStatus({ task_id: "T1" }));

    const workers = await listWorkers();
    assert.strictEqual(workers.length, 1);
    assert.ok(workers[0].status !== null);
    assert.strictEqual(workers[0].status!.stage, "implement");
  });

  it("returns workers with meta + status + result", async () => {
    writeWorkerFile("T1", "meta.json", makeMeta("T1"));
    writeWorkerFile("T1", "status.json", makeStatus({ task_id: "T1" }));
    writeWorkerFile("T1", "result.json", makeResult({ task_id: "T1" }));

    const workers = await listWorkers();
    assert.strictEqual(workers.length, 1);
    assert.ok(workers[0].result !== null);
    assert.strictEqual(workers[0].result!.verdict, "pass");
  });

  it("returns multiple workers", async () => {
    writeWorkerFile("T1", "meta.json", makeMeta("T1"));
    writeWorkerFile("T2", "meta.json", makeMeta("T2"));
    writeWorkerFile("T3", "meta.json", makeMeta("T3"));

    const workers = await listWorkers();
    assert.strictEqual(workers.length, 3);
    const ids = workers.map((w) => w.meta.task_id).sort();
    assert.deepStrictEqual(ids, ["T1", "T2", "T3"]);
  });

  it("skips directories without meta.json", async () => {
    writeWorkerFile("T1", "meta.json", makeMeta("T1"));
    // T2 directory exists but has no meta.json
    mkdirSync(join(testDir, ".apex-manager", "workers", "T2"), { recursive: true });
    writeFileSync(join(testDir, ".apex-manager", "workers", "T2", "notes.txt"), "not meta");

    const workers = await listWorkers();
    assert.strictEqual(workers.length, 1);
    assert.strictEqual(workers[0].meta.task_id, "T1");
  });
});

// ─── checkWorkerHealth ─────────────────────────────────────────────

describe("checkWorkerHealth", () => {
  it("returns completed when result.json exists with pass verdict", async () => {
    writeWorkerFile("T1", "meta.json", makeMeta("T1"));
    writeWorkerFile("T1", "status.json", makeStatus({ task_id: "T1" }));
    writeWorkerFile("T1", "result.json", makeResult({ task_id: "T1", verdict: "pass" }));

    const health = await checkWorkerHealth("T1");
    assert.strictEqual(health.completed, true);
  });

  it("returns completed when result.json exists with fail verdict", async () => {
    writeWorkerFile("T1", "meta.json", makeMeta("T1"));
    writeWorkerFile("T1", "result.json", makeResult({ task_id: "T1", verdict: "fail" }));

    const health = await checkWorkerHealth("T1");
    assert.strictEqual(health.completed, true);
  });

  it("detects stale worker when last_activity is old", async () => {
    const oldTime = new Date(Date.now() - 15 * 60 * 1000).toISOString(); // 15 min ago
    writeWorkerFile("T1", "meta.json", makeMeta("T1", { pid: undefined, window_handle: null }));
    writeWorkerFile("T1", "status.json", makeStatus({ task_id: "T1", last_activity: oldTime }));

    const health = await checkWorkerHealth("T1");
    assert.strictEqual(health.stale, true);
  });

  it("not stale when last_activity is recent", async () => {
    writeWorkerFile("T1", "meta.json", makeMeta("T1", { pid: undefined, window_handle: null }));
    writeWorkerFile("T1", "status.json", makeStatus({ task_id: "T1", last_activity: new Date().toISOString() }));

    const health = await checkWorkerHealth("T1");
    assert.strictEqual(health.stale, false);
  });

  it("crashed when PID is dead and no result", async () => {
    // PID 2147483647 should not exist
    writeWorkerFile("T1", "meta.json", makeMeta("T1", {
      pid: 2147483647,
      window_handle: null,
      started_at: new Date(Date.now() - 30_000).toISOString(),
    }));

    const health = await checkWorkerHealth("T1");
    // No result.json + dead PID = crashed
    assert.strictEqual(health.crashed, true);
    assert.strictEqual(health.alive, false);
  });

  it("treats a fresh worker with no heartbeat as starting instead of crashed", async () => {
    writeWorkerFile("T1", "meta.json", makeMeta("T1", {
      pid: 2147483647,
      window_handle: null,
      started_at: new Date().toISOString(),
    }));

    const health = await checkWorkerHealth("T1");
    assert.strictEqual(health.starting, true);
    assert.strictEqual(health.crashed, false);
    assert.strictEqual(health.exitedWithoutResult, false);
  });

  it("not crashed when no PID and no window_handle (ambiguous, defaults not crashed)", async () => {
    writeWorkerFile("T1", "meta.json", makeMeta("T1", { pid: undefined, window_handle: null }));
    writeWorkerFile("T1", "status.json", makeStatus({ task_id: "T1" }));

    const health = await checkWorkerHealth("T1");
    assert.strictEqual(health.alive, false);
    assert.strictEqual(health.crashed, false);
  });

  it("throws when worker does not exist", async () => {
    await assert.rejects(() => checkWorkerHealth("NONEXISTENT"));
  });

  it("uses the recorded cmux adapter to collect screen tail diagnostics", async () => {
    installFakeCmux(`#!/bin/sh
case "$1" in
  read-screen)
    echo "last visible cmux line"
    exit 0
    ;;
  validate-surface)
    exit 1
    ;;
  --version|ping)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`);

    writeWorkerFile("T1", "meta.json", makeMeta("T1", {
      pid: 2147483647,
      window_handle: { id: "surface-7", name: "T1-auth", adapter: "cmux" },
      started_at: new Date(Date.now() - 30_000).toISOString(),
    }));

    const health = await checkWorkerHealth("T1");
    assert.strictEqual(health.crashed, true);
    assert.strictEqual(health.screenTail, "last visible cmux line");
  });
});

// ─── getMonitorReport ──────────────────────────────────────────────

describe("getMonitorReport", () => {
  it("returns 'no workers' message when empty", async () => {
    const report = await getMonitorReport();
    assert.ok(report.includes("No workers"));
  });

  it("shows completed pass status", async () => {
    writeWorkerFile("T1", "meta.json", makeMeta("T1", { pid: undefined, window_handle: null }));
    writeWorkerFile("T1", "status.json", makeStatus({ task_id: "T1", stage: "done" }));
    writeWorkerFile("T1", "result.json", makeResult({ task_id: "T1", verdict: "pass" }));

    const report = await getMonitorReport();
    assert.ok(report.includes("T1"));
    assert.ok(report.includes("pass"));
  });

  it("shows completed fail status", async () => {
    writeWorkerFile("T1", "meta.json", makeMeta("T1", { pid: undefined, window_handle: null }));
    writeWorkerFile("T1", "result.json", makeResult({ task_id: "T1", verdict: "fail" }));

    const report = await getMonitorReport();
    assert.ok(report.includes("T1"));
    assert.ok(report.includes("fail"));
  });

  it("shows CRASHED status for dead worker", async () => {
    writeWorkerFile("T1", "meta.json", makeMeta("T1", {
      pid: 2147483647,
      window_handle: null,
      started_at: new Date(Date.now() - 30_000).toISOString(),
    }));

    const report = await getMonitorReport();
    assert.ok(report.includes("T1"));
    assert.ok(report.includes("CRASHED"));
  });

  it("shows STARTING status before the first heartbeat grace window expires", async () => {
    writeWorkerFile("T1", "meta.json", makeMeta("T1", {
      pid: 2147483647,
      window_handle: null,
      started_at: new Date().toISOString(),
    }));

    const report = await getMonitorReport();
    assert.ok(report.includes("T1"));
    assert.ok(report.includes("STARTING"));
  });

  it("shows STALE status for inactive worker", async () => {
    const oldTime = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    writeWorkerFile("T1", "meta.json", makeMeta("T1", { pid: undefined, window_handle: null }));
    writeWorkerFile("T1", "status.json", makeStatus({ task_id: "T1", last_activity: oldTime }));

    const report = await getMonitorReport();
    assert.ok(report.includes("T1"));
    assert.ok(report.includes("STALE"));
  });

  it("shows multiple workers", async () => {
    writeWorkerFile("T1", "meta.json", makeMeta("T1", { pid: undefined, window_handle: null }));
    writeWorkerFile("T1", "result.json", makeResult({ task_id: "T1", verdict: "pass" }));

    writeWorkerFile("T2", "meta.json", makeMeta("T2", { pid: 2147483647, window_handle: null }));

    const report = await getMonitorReport();
    assert.ok(report.includes("T1"));
    assert.ok(report.includes("T2"));
  });

  it("includes stage and progress when available", async () => {
    writeWorkerFile("T1", "meta.json", makeMeta("T1", { pid: undefined, window_handle: null }));
    writeWorkerFile("T1", "status.json", makeStatus({ task_id: "T1", stage: "implement", progress: "3/5 tests passing" }));

    const report = await getMonitorReport();
    assert.ok(report.includes("implement"));
    assert.ok(report.includes("3/5 tests passing"));
  });
});
