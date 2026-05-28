import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { spawnSync } from "child_process";
import { createDaemonState, discoverWorkers, tick } from "../../src/daemon/daemon.js";

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

  it("reconciles task done without result.json as completed_orphaned", async () => {
    mkdirSync(join(tmpDir, ".apex-manager"), { recursive: true });
    writeFileSync(join(tmpDir, ".apex-manager", "tasks.json"), JSON.stringify({
      tasks: [{
        id: "T6",
        title: "Done externally",
        description: "Done externally",
        status: "done",
        depends_on: [],
        blocked_by: [],
        evidence: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }],
      next_id: 7,
    }, null, 2));
    writeWorkerFiles("T6", {
      meta: { task_id: "T6", window_handle: null, worktree_path: ".apex-manager/worktrees/T6", branch: "apex-mgr/T6", started_at: new Date().toISOString(), agent: "claude" },
    });

    const state = createDaemonState(tmpDir, null);
    await tick(state);

    const meta = JSON.parse(readFileSync(join(tmpDir, ".apex-manager", "workers", "T6", "meta.json"), "utf-8"));
    assert.ok(meta.orphaned_task_done);
    assert.strictEqual(state.workers.get("T6")?.resultChecked, true);
  });

  it("reconciles a late task claim into verified launch state", async () => {
    mkdirSync(join(tmpDir, ".apex-manager"), { recursive: true });
    writeFileSync(join(tmpDir, ".apex-manager", "tasks.json"), JSON.stringify({
      tasks: [{
        id: "T8",
        title: "Late claim",
        description: "Late claim",
        status: "in_progress",
        claimed_by: "T8",
        depends_on: [],
        blocked_by: [],
        evidence: [],
        attempts: [{
          attempt: 1,
          agent: "codex",
          worker_id: "T8",
          status: "unverified",
          started_at: new Date().toISOString(),
        }],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }],
      next_id: 9,
    }, null, 2));
    writeWorkerFiles("T8", {
      meta: {
        task_id: "T8",
        window_handle: null,
        worktree_path: ".apex-manager/worktrees/T8",
        branch: "apex-mgr/T8",
        started_at: new Date().toISOString(),
        agent: "codex",
        launch_verification: { state: "failed", note: "initial smoke timeout" },
      },
    });

    const state = createDaemonState(tmpDir, null);
    await tick(state);

    const meta = JSON.parse(readFileSync(join(tmpDir, ".apex-manager", "workers", "T8", "meta.json"), "utf-8"));
    const taskStore = JSON.parse(readFileSync(join(tmpDir, ".apex-manager", "tasks.json"), "utf-8"));
    assert.strictEqual(meta.launch_verification.state, "verified");
    assert.strictEqual(meta.launch_verification.action_signal, "task_claimed");
    assert.strictEqual(taskStore.tasks[0].attempts[0].status, "verified");
  });

  it("does not reconcile non-worker manual block as launch verification", async () => {
    mkdirSync(join(tmpDir, ".apex-manager"), { recursive: true });
    writeFileSync(join(tmpDir, ".apex-manager", "tasks.json"), JSON.stringify({
      tasks: [{
        id: "T9",
        title: "Manual block",
        description: "Manual block",
        status: "blocked",
        blocked_by: ["plan-agent"],
        depends_on: [],
        evidence: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }],
      next_id: 10,
    }, null, 2));
    writeWorkerFiles("T9", {
      meta: {
        task_id: "T9",
        window_handle: null,
        worktree_path: ".apex-manager/worktrees/T9",
        branch: "apex-mgr/T9",
        started_at: new Date().toISOString(),
        agent: "codex",
        launch_verification: { state: "failed", note: "initial smoke timeout" },
      },
    });

    const state = createDaemonState(tmpDir, null);
    await tick(state);

    const meta = JSON.parse(readFileSync(join(tmpDir, ".apex-manager", "workers", "T9", "meta.json"), "utf-8"));
    assert.strictEqual(meta.launch_verification.state, "failed");
  });

  it("blocks a task when the main repo changes during isolated worker execution", async () => {
    spawnSync("git", ["init"], { cwd: tmpDir });
    mkdirSync(join(tmpDir, ".apex-manager"), { recursive: true });
    writeFileSync(join(tmpDir, ".apex-manager", "tasks.json"), JSON.stringify({
      tasks: [{
        id: "T7",
        title: "Isolated",
        description: "Isolated",
        status: "in_progress",
        depends_on: [],
        blocked_by: [],
        evidence: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }],
      next_id: 8,
    }, null, 2));
    writeWorkerFiles("T7", {
      meta: {
        task_id: "T7",
        window_handle: null,
        worktree_path: ".apex-manager/worktrees/T7",
        branch: "apex-mgr/T7",
        started_at: new Date(Date.now() - 30_000).toISOString(),
        agent: "claude",
        isolation_mode: "git-worktree",
        main_repo_baseline_status: "",
      },
    });
    writeFileSync(join(tmpDir, "main-edit.txt"), "worker wrote main repo\n");

    const state = createDaemonState(tmpDir, null);
    await tick(state);

    const taskStore = JSON.parse(readFileSync(join(tmpDir, ".apex-manager", "tasks.json"), "utf-8"));
    assert.strictEqual(taskStore.tasks[0].status, "blocked");
    assert.match(taskStore.tasks[0].block_reason, /isolation violation/);
  });

  it("blocks isolation violation before integrating a passing result", async () => {
    spawnSync("git", ["init"], { cwd: tmpDir });
    mkdirSync(join(tmpDir, ".apex-manager"), { recursive: true });
    writeFileSync(join(tmpDir, ".apex-manager", "tasks.json"), JSON.stringify({
      tasks: [{
        id: "T10",
        title: "Pass with main drift",
        description: "Pass with main drift",
        status: "in_progress",
        depends_on: [],
        blocked_by: [],
        evidence: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }],
      next_id: 11,
    }, null, 2));
    writeWorkerFiles("T10", {
      meta: {
        task_id: "T10",
        window_handle: null,
        worktree_path: ".apex-manager/worktrees/T10",
        branch: "apex-mgr/T10",
        started_at: new Date(Date.now() - 30_000).toISOString(),
        agent: "claude",
        isolation_mode: "git-worktree",
        main_repo_baseline_status: "\n---diff---\n",
      },
      result: { task_id: "T10", verdict: "pass", summary: "done" },
    });
    writeFileSync(join(tmpDir, "main-edit.txt"), "worker wrote main repo\n");

    const state = createDaemonState(tmpDir, null);
    await tick(state);

    const taskStore = JSON.parse(readFileSync(join(tmpDir, ".apex-manager", "tasks.json"), "utf-8"));
    assert.strictEqual(taskStore.tasks[0].status, "blocked");
    assert.strictEqual(state.workers.get("T10")?.resultChecked, true);
  });

  it("rejects pass result when worker does not own the claimed task", async () => {
    mkdirSync(join(tmpDir, ".apex-manager"), { recursive: true });
    writeFileSync(join(tmpDir, ".apex-manager", "tasks.json"), JSON.stringify({
      tasks: [{
        id: "T11",
        title: "Forged result",
        description: "Forged result",
        status: "in_progress",
        claimed_by: "T-other",
        depends_on: [],
        blocked_by: [],
        evidence: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }],
      next_id: 12,
    }, null, 2));
    writeFileSync(join(tmpDir, ".apex-manager", "events.jsonl"), "");
    writeWorkerFiles("T11", {
      meta: {
        task_id: "T11",
        window_handle: null,
        worktree_path: ".apex-manager/worktrees/T11",
        branch: "apex-mgr/T11",
        started_at: new Date(Date.now() - 30_000).toISOString(),
        agent: "claude",
        launch_verification: { state: "verified" },
      },
      result: { task_id: "T11", verdict: "pass", summary: "forged" },
    });

    const state = createDaemonState(tmpDir, null);
    await tick(state);

    const events = readFileSync(join(tmpDir, ".apex-manager", "events.jsonl"), "utf-8");
    assert.ok(events.includes("worker_result_rejected"));
    assert.ok(events.includes("claimed_by"));
  });
});
