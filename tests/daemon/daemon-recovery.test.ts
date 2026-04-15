import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createDaemonState, discoverWorkers } from "../../src/daemon/daemon.js";

// TODO: bun:test spyOn for console.log is not available in node:test.
// The test that checks log output ("discoverWorkers logs recovery of pre-existing workers")
// is adapted to skip spy-based assertions. If needed, use a logging mock library.

describe("daemon recovery on startup", () => {
  let tmpDir: string;
  let origCwd: string;
  let origLog: typeof console.log;
  let logCalls: string[];

  beforeEach(() => {
    tmpDir = join(tmpdir(), `am-daemon-recovery-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
    origCwd = process.cwd();
    process.chdir(tmpDir);
    logCalls = [];
    origLog = console.log;
    console.log = (...args: any[]) => { logCalls.push(args.map(String).join(" ")); };
  });

  afterEach(() => {
    process.chdir(origCwd);
    console.log = origLog;
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  function writeWorkerFiles(taskId: string, opts: { meta?: any; result?: any; status?: any }) {
    const dir = join(tmpDir, ".apex-manager", "workers", taskId);
    mkdirSync(dir, { recursive: true });
    if (opts.meta) {
      writeFileSync(join(dir, "meta.json"), JSON.stringify(opts.meta, null, 2));
    }
    if (opts.result) {
      writeFileSync(join(dir, "result.json"), JSON.stringify(opts.result, null, 2));
    }
    if (opts.status) {
      writeFileSync(join(dir, "status.json"), JSON.stringify(opts.status, null, 2));
    }
  }

  it("discoverWorkers picks up existing workers on fresh daemon start", async () => {
    writeWorkerFiles("T1", {
      meta: { task_id: "T1", window_handle: null, worktree_path: ".apex-manager/worktrees/T1", branch: "apex-mgr/T1", started_at: new Date().toISOString(), agent: "claude" },
    });
    writeWorkerFiles("T2", {
      meta: { task_id: "T2", window_handle: null, worktree_path: ".apex-manager/worktrees/T2", branch: "apex-mgr/T2", started_at: new Date().toISOString(), agent: "codex" },
    });

    const state = createDaemonState(tmpDir, null);
    await discoverWorkers(state);

    assert.strictEqual(state.workers.size, 2);
    assert.ok(state.workers.has("T1"));
    assert.ok(state.workers.has("T2"));
  });

  it("discovered workers with result.json have resultChecked=false for tick to process", async () => {
    writeWorkerFiles("T3", {
      meta: { task_id: "T3", window_handle: null, worktree_path: ".apex-manager/worktrees/T3", branch: "apex-mgr/T3", started_at: new Date().toISOString(), agent: "claude" },
      result: { verdict: "pass", summary: "All tests pass" },
    });

    const state = createDaemonState(tmpDir, null);
    await discoverWorkers(state);

    const worker = state.workers.get("T3");
    assert.ok(worker !== undefined);
    assert.strictEqual(worker!.resultChecked, false);
  });

  it("discoverWorkers logs recovery of pre-existing workers", async () => {
    writeWorkerFiles("T4", {
      meta: { task_id: "T4", window_handle: { id: "@1", name: "T4-test" }, worktree_path: ".apex-manager/worktrees/T4", branch: "apex-mgr/T4", started_at: new Date().toISOString(), agent: "gemini" },
      result: { verdict: "pass", summary: "Done" },
    });

    const state = createDaemonState(tmpDir, null);
    await discoverWorkers(state);

    // Should log recovery info containing "T4"
    assert.ok(logCalls.some(line => line.includes("T4")));
  });

  it("discoverWorkers does not re-add already tracked workers", async () => {
    writeWorkerFiles("T5", {
      meta: { task_id: "T5", window_handle: null, worktree_path: ".apex-manager/worktrees/T5", branch: "apex-mgr/T5", started_at: new Date().toISOString(), agent: "claude" },
    });

    const state = createDaemonState(tmpDir, null);
    await discoverWorkers(state);
    assert.strictEqual(state.workers.size, 1);

    // Second call should not duplicate
    await discoverWorkers(state);
    assert.strictEqual(state.workers.size, 1);
  });
});
