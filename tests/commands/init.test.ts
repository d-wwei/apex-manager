import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("cmdInit", () => {
  let tmpDir: string;
  let origCwd: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `am-init-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
    origCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(origCwd);
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it("creates the default .apex-manager layout", async () => {
    const { cmdInit } = await import("../../src/commands/init.js");
    await cmdInit([]);

    assert.ok(existsSync(join(tmpDir, ".apex-manager", "config.yaml")));
    assert.ok(existsSync(join(tmpDir, ".apex-manager", "tasks.json")));
    assert.ok(existsSync(join(tmpDir, ".apex-manager", "agents.json")));
    assert.ok(existsSync(join(tmpDir, ".apex-manager", "event-log.jsonl")));
    assert.ok(existsSync(join(tmpDir, ".apex-manager", "events.jsonl")));
    assert.ok(existsSync(join(tmpDir, ".apex-manager", "state.snapshot.json")));
    assert.ok(existsSync(join(tmpDir, ".apex-manager", "workers")));
    assert.ok(existsSync(join(tmpDir, ".apex-manager", "worktrees")));
    assert.ok(existsSync(join(tmpDir, ".apex-manager", "notifications")));
    assert.ok(existsSync(join(tmpDir, ".apex-manager", "artifacts", "index.json")));
    assert.ok(existsSync(join(tmpDir, ".apex-manager", "messages", "index.json")));
  });

  it("is idempotent and does not overwrite existing stores", async () => {
    const { cmdInit } = await import("../../src/commands/init.js");
    await cmdInit([]);

    const tasksPath = join(tmpDir, ".apex-manager", "tasks.json");
    writeFileSync(tasksPath, JSON.stringify({
      tasks: [{ id: "T9", title: "keep", description: "keep", status: "open", depends_on: [], blocked_by: [], evidence: [], created_at: "a", updated_at: "a" }],
      next_id: 10,
    }, null, 2));

    await cmdInit([]);

    const tasks = JSON.parse(readFileSync(tasksPath, "utf-8"));
    assert.strictEqual(tasks.tasks.length, 1);
    assert.strictEqual(tasks.tasks[0].id, "T9");
    assert.strictEqual(tasks.next_id, 10);
  });
});
