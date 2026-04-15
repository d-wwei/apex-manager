import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { spawnSync } from "child_process";

// --- Test helpers ---

function makeTmpDir(): string {
  const dir = join(tmpdir(), `am-merge-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeJSON(path: string, data: unknown) {
  const dir = join(path, "..");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
}

function setupWorker(dir: string, taskId: string, opts: { verdict?: string; summary?: string; dirty?: boolean }) {
  const workersDir = join(dir, ".apex-manager", "workers", taskId);
  mkdirSync(workersDir, { recursive: true });

  // meta.json
  writeJSON(join(workersDir, "meta.json"), {
    task_id: taskId,
    window_handle: null,
    worktree_path: `.apex-manager/worktrees/${taskId}`,
    branch: `apex-mgr/${taskId}`,
    started_at: "2026-01-01T00:00:00Z",
    agent: "claude",
  });

  // result.json (only if verdict provided)
  if (opts.verdict !== undefined) {
    writeJSON(join(workersDir, "result.json"), {
      verdict: opts.verdict,
      summary: opts.summary ?? "test summary",
    });
  }

  // Create worktree directory (simulated -- not a real git worktree)
  const wtPath = join(dir, ".apex-manager", "worktrees", taskId);
  mkdirSync(wtPath, { recursive: true });

  // If dirty, put an uncommitted file marker
  if (opts.dirty) {
    writeFileSync(join(wtPath, "dirty-file.txt"), "uncommitted");
  }
}

function writeTasksJson(dir: string, tasks: any[]) {
  const amDir = join(dir, ".apex-manager");
  mkdirSync(amDir, { recursive: true });
  writeFileSync(
    join(amDir, "tasks.json"),
    JSON.stringify({ tasks, next_id: tasks.length + 1 }, null, 2),
  );
}

// --- Tests ---

describe("worker merge", () => {
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

    // Initialize as git repo (with config for CI where no global gitconfig exists)
    spawnSync("git", ["init"], { cwd: tmpDir });
    spawnSync("git", ["-C", tmpDir, "config", "user.name", "test"]);
    spawnSync("git", ["-C", tmpDir, "config", "user.email", "test@test.com"]);
    spawnSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: tmpDir });

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
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  // --- merge: refuses if no result.json ---

  it("merge refuses if no result.json", async () => {
    writeTasksJson(tmpDir, []);
    // Create meta but no result
    const workersDir = join(tmpDir, ".apex-manager", "workers", "T1");
    mkdirSync(workersDir, { recursive: true });
    writeFileSync(
      join(workersDir, "meta.json"),
      JSON.stringify({ task_id: "T1", branch: "apex-mgr/T1", worktree_path: ".apex-manager/worktrees/T1" }),
    );

    const { cmdMerge } = await import("../../src/commands/worker.js");
    try {
      await cmdMerge(["T1"]);
    } catch (e: any) {
      assert.ok(e.message.includes("process.exit(1)"));
    }
    const output = errorOutput.join("\n");
    assert.ok(output.includes("No result.json"));
  });

  // --- merge: refuses if verdict !== "pass" ---

  it("merge refuses if verdict is not pass", async () => {
    writeTasksJson(tmpDir, [{ id: "T2", title: "Failing task", depends_on: [], status: "done" }]);
    setupWorker(tmpDir, "T2", { verdict: "fail" });

    const { cmdMerge } = await import("../../src/commands/worker.js");
    try {
      await cmdMerge(["T2"]);
    } catch (e: any) {
      assert.ok(e.message.includes("process.exit(1)"));
    }
    const output = errorOutput.join("\n");
    assert.ok(output.includes("verdict is 'fail'"));
  });

  // --- merge: refuses if uncommitted changes ---

  it("merge refuses if worktree has uncommitted changes", async () => {
    writeTasksJson(tmpDir, [{ id: "T3", title: "Dirty task", depends_on: [], status: "done" }]);

    // Set up a real git worktree so `git status --porcelain` works
    const branch = "apex-mgr/T3";
    spawnSync("git", ["worktree", "add", ".apex-manager/worktrees/T3", "-b", branch], { cwd: tmpDir });

    // Write an untracked file into the worktree
    const wtPath = join(tmpDir, ".apex-manager", "worktrees", "T3");
    writeFileSync(join(wtPath, "dirty.txt"), "uncommitted");

    // Set up worker meta + passing result
    const workersDir = join(tmpDir, ".apex-manager", "workers", "T3");
    mkdirSync(workersDir, { recursive: true });
    writeFileSync(
      join(workersDir, "meta.json"),
      JSON.stringify({
        task_id: "T3",
        branch,
        worktree_path: ".apex-manager/worktrees/T3",
        started_at: "2026-01-01T00:00:00Z",
        agent: "claude",
      }),
    );
    writeFileSync(join(workersDir, "result.json"), JSON.stringify({ verdict: "pass" }));

    const { cmdMerge } = await import("../../src/commands/worker.js");
    try {
      await cmdMerge(["T3"]);
    } catch (e: any) {
      assert.ok(e.message.includes("process.exit(1)"));
    }
    const output = errorOutput.join("\n");
    assert.ok(output.includes("uncommitted changes"));
  });

  // --- strategy flag parsing ---

  it("parseStrategy returns local by default", async () => {
    writeTasksJson(tmpDir, [{ id: "T4", title: "Good task", depends_on: [], status: "done" }]);

    // Create a real branch with a commit so merge can succeed
    const branch = "apex-mgr/T4";
    spawnSync("git", ["worktree", "add", ".apex-manager/worktrees/T4", "-b", branch], { cwd: tmpDir });
    const wtPath = join(tmpDir, ".apex-manager", "worktrees", "T4");
    writeFileSync(join(wtPath, "feature.txt"), "new feature");
    spawnSync("git", ["-C", wtPath, "add", "feature.txt"]);
    spawnSync("git", ["-C", wtPath, "commit", "-m", "add feature"]);

    const workersDir = join(tmpDir, ".apex-manager", "workers", "T4");
    mkdirSync(workersDir, { recursive: true });
    writeFileSync(
      join(workersDir, "meta.json"),
      JSON.stringify({ task_id: "T4", branch, worktree_path: ".apex-manager/worktrees/T4" }),
    );
    writeFileSync(join(workersDir, "result.json"), JSON.stringify({ verdict: "pass" }));

    const { cmdMerge } = await import("../../src/commands/worker.js");
    await cmdMerge(["T4"]);

    const output = logOutput.join("\n");
    assert.ok(output.includes("strategy 'local'"));
  });

  it("parseStrategy parses --strategy squash", async () => {
    writeTasksJson(tmpDir, [{ id: "T5", title: "Squash task", depends_on: [], status: "done" }]);

    const branch = "apex-mgr/T5";
    spawnSync("git", ["worktree", "add", ".apex-manager/worktrees/T5", "-b", branch], { cwd: tmpDir });
    const wtPath = join(tmpDir, ".apex-manager", "worktrees", "T5");
    writeFileSync(join(wtPath, "feature.txt"), "squash feature");
    spawnSync("git", ["-C", wtPath, "add", "feature.txt"]);
    spawnSync("git", ["-C", wtPath, "commit", "-m", "add squash feature"]);

    const workersDir = join(tmpDir, ".apex-manager", "workers", "T5");
    mkdirSync(workersDir, { recursive: true });
    writeFileSync(
      join(workersDir, "meta.json"),
      JSON.stringify({ task_id: "T5", branch, worktree_path: ".apex-manager/worktrees/T5" }),
    );
    writeFileSync(join(workersDir, "result.json"), JSON.stringify({ verdict: "pass" }));

    const { cmdMerge } = await import("../../src/commands/worker.js");
    await cmdMerge(["T5", "--strategy", "squash"]);

    const output = logOutput.join("\n");
    assert.ok(output.includes("strategy 'squash'"));
  });
});

// --- topoSort ---

describe("topoSort", () => {
  it("sorts tasks with no deps first", async () => {
    const { topoSort } = await import("../../src/commands/worker.js");

    const tasks = [
      { id: "T1", title: "A", depends_on: ["T2"], status: "done" as const },
      { id: "T2", title: "B", depends_on: [], status: "done" as const },
      { id: "T3", title: "C", depends_on: ["T1"], status: "done" as const },
    ] as any[];

    const result = topoSort(["T1", "T2", "T3"], tasks);
    // T2 has no deps -> first. T1 depends on T2 -> second. T3 depends on T1 -> third.
    assert.deepStrictEqual(result, ["T2", "T1", "T3"]);
  });

  it("handles independent tasks (no deps)", async () => {
    const { topoSort } = await import("../../src/commands/worker.js");

    const tasks = [
      { id: "T1", title: "A", depends_on: [], status: "done" as const },
      { id: "T2", title: "B", depends_on: [], status: "done" as const },
    ] as any[];

    const result = topoSort(["T1", "T2"], tasks);
    // Both independent -- input order preserved
    assert.deepStrictEqual(result, ["T1", "T2"]);
  });

  it("only includes relevant task IDs", async () => {
    const { topoSort } = await import("../../src/commands/worker.js");

    const tasks = [
      { id: "T1", title: "A", depends_on: ["T2"], status: "done" as const },
      { id: "T2", title: "B", depends_on: [], status: "done" as const },
      { id: "T3", title: "C", depends_on: [], status: "done" as const },
    ] as any[];

    // Only merge T1 and T3, not T2
    const result = topoSort(["T1", "T3"], tasks);
    // T2 is not in the set, so T1's dep on T2 is a no-op. Both T1 and T3 are independent here.
    assert.deepStrictEqual(result, ["T1", "T3"]);
  });

  it("diamond dependency is handled", async () => {
    const { topoSort } = await import("../../src/commands/worker.js");

    const tasks = [
      { id: "T1", title: "Base", depends_on: [], status: "done" as const },
      { id: "T2", title: "Left", depends_on: ["T1"], status: "done" as const },
      { id: "T3", title: "Right", depends_on: ["T1"], status: "done" as const },
      { id: "T4", title: "Top", depends_on: ["T2", "T3"], status: "done" as const },
    ] as any[];

    const result = topoSort(["T1", "T2", "T3", "T4"], tasks);
    // T1 must come before T2 and T3, which must come before T4
    assert.ok(result.indexOf("T1") < result.indexOf("T2"));
    assert.ok(result.indexOf("T1") < result.indexOf("T3"));
    assert.ok(result.indexOf("T2") < result.indexOf("T4"));
    assert.ok(result.indexOf("T3") < result.indexOf("T4"));
  });
});

// --- help includes merge ---

describe("help text includes merge commands", () => {
  let origLog: typeof console.log;
  let logOutput: string[];

  beforeEach(() => {
    logOutput = [];
    origLog = console.log;
    console.log = (...args: any[]) => { logOutput.push(args.map(String).join(" ")); };
  });
  afterEach(() => {
    console.log = origLog;
  });

  it("help text mentions merge and merge-all", async () => {
    const { cmdWorker } = await import("../../src/commands/worker.js");
    try {
      await cmdWorker(["help"]);
    } catch {}
    const output = logOutput.join("\n");
    assert.ok(output.includes("merge <task-id>"));
    assert.ok(output.includes("merge-all"));
    assert.ok(output.includes("--strategy"));
  });
});
