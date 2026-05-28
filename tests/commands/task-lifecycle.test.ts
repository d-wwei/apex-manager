import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("task lifecycle commands", () => {
  let tmpDir: string;
  let origCwd: string;
  let origExit: typeof process.exit;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `am-task-life-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
    origCwd = process.cwd();
    process.chdir(tmpDir);
    origExit = process.exit;
    process.exit = ((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as any;
  });

  afterEach(() => {
    process.chdir(origCwd);
    process.exit = origExit;
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  async function loadTask(taskId: string) {
    const store = JSON.parse(readFileSync(join(tmpDir, ".apex-manager", "tasks.json"), "utf-8"));
    return store.tasks.find((task: any) => task.id === taskId);
  }

  it("claim marks a task in progress and records the actor", async () => {
    const { cmdInit } = await import("../../src/commands/init.js");
    const { cmdTask } = await import("../../src/commands/task.js");
    await cmdInit([]);
    await cmdTask(["create", "Build", "feature"]);

    await cmdTask(["claim", "T1", "--by", "codex"]);

    const task = await loadTask("T1");
    assert.strictEqual(task.status, "in_progress");
    assert.strictEqual(task.claimed_by, "codex");
    assert.ok(task.claimed_at);
  });

  it("complete marks a task done and records summary and evidence", async () => {
    const { cmdInit } = await import("../../src/commands/init.js");
    const { cmdTask } = await import("../../src/commands/task.js");
    await cmdInit([]);
    await cmdTask(["create", "Build", "feature"]);
    await cmdTask(["claim", "T1", "--by", "codex"]);

    await cmdTask(["complete", "T1", "--by", "codex", "--summary", "implemented", "--evidence", "ART-1"]);

    const task = await loadTask("T1");
    assert.strictEqual(task.status, "done");
    assert.strictEqual(task.completed_by, "codex");
    assert.strictEqual(task.completion_summary, "implemented");
    assert.ok(task.completed_at);
    assert.deepStrictEqual(task.evidence, ["ART-1"]);
  });

  it("complete rejects a different worker than the claimant", async () => {
    const { cmdInit } = await import("../../src/commands/init.js");
    const { cmdTask } = await import("../../src/commands/task.js");
    await cmdInit([]);
    await cmdTask(["create", "Build", "feature"]);
    await cmdTask(["claim", "T1", "--by", "T1"]);

    await assert.rejects(
      () => cmdTask(["complete", "T1", "--by", "T2", "--summary", "forged"]),
      /process\.exit\(1\)/,
    );

    const task = await loadTask("T1");
    assert.strictEqual(task.status, "in_progress");
    assert.strictEqual(task.completed_by, undefined);
  });

  it("block marks a task blocked and records reason and actor", async () => {
    const { cmdInit } = await import("../../src/commands/init.js");
    const { cmdTask } = await import("../../src/commands/task.js");
    await cmdInit([]);
    await cmdTask(["create", "Build", "feature"]);

    await cmdTask(["block", "T1", "--by", "codex", "--reason", "waiting-on-api"]);

    const task = await loadTask("T1");
    assert.strictEqual(task.status, "blocked");
    assert.strictEqual(task.block_reason, "waiting-on-api");
    assert.ok(task.blocked_by.includes("codex"));
  });

  it("retry re-opens an in-progress task under the same id with attempt history", async () => {
    const { cmdInit } = await import("../../src/commands/init.js");
    const { cmdTask } = await import("../../src/commands/task.js");
    await cmdInit([]);
    await cmdTask(["create", "Build", "feature", "--agent", "codex"]);
    await cmdTask(["claim", "T1", "--by", "T1"]);

    await cmdTask(["retry", "T1", "--agent", "claude", "--reason", "worker crashed"]);

    const task = await loadTask("T1");
    assert.strictEqual(task.status, "open");
    assert.strictEqual(task.agent, "claude");
    assert.strictEqual(task.attempt, 2);
    assert.strictEqual(task.claimed_by, undefined);
    assert.strictEqual(task.attempts[0].status, "failed");
    assert.strictEqual(task.attempts[0].note, "worker crashed");
  });

  it("retry archives an existing worker directory so daemon can respawn the same task id", async () => {
    const { cmdInit } = await import("../../src/commands/init.js");
    const { cmdTask } = await import("../../src/commands/task.js");
    await cmdInit([]);
    await cmdTask(["create", "Build", "feature", "--agent", "codex"]);
    await cmdTask(["claim", "T1", "--by", "T1"]);
    const workerDir = join(tmpDir, ".apex-manager", "workers", "T1");
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(join(workerDir, "meta.json"), JSON.stringify({
      task_id: "T1",
      window_handle: null,
      worktree_path: ".apex-manager/worktrees/T1",
      branch: "apex-mgr/T1",
      started_at: new Date().toISOString(),
      agent: "codex",
    }));

    await cmdTask(["retry", "T1", "--agent", "claude", "--reason", "worker crashed"]);

    assert.strictEqual(existsSync(workerDir), false);
    assert.strictEqual(existsSync(join(tmpDir, ".apex-manager", "workers-archive")), true);
  });
});
