import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdirSync, readFileSync, rmSync } from "fs";
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
});
