import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { TerminalAdapter, WindowHandle } from "../../src/worker/terminal.js";

function makeIdleAdapter(): TerminalAdapter {
  return {
    name: () => "tmux",
    available: () => true,
    createWindow: async () => ({ id: "@1", name: "fake", adapter: "tmux" }),
    send: async () => {},
    readScreen: async () => "$ ready",
    close: async () => {},
    isAlive: async () => true,
    rename: async () => {},
    sendKey: async () => {},
  };
}

describe("project snapshot rebuild", () => {
  let tmpDir: string;
  let origCwd: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `am-snapshot-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

  it("rebuilds snapshot state from recorded task, artifact, and message events", async () => {
    const { cmdInit } = await import("../../src/commands/init.js");
    const { cmdTask } = await import("../../src/commands/task.js");
    const { cmdArtifact } = await import("../../src/commands/artifact.js");
    const { sendStructuredMessage } = await import("../../src/worker/messages.js");
    const { rebuildProjectSnapshotFromEvents, readProjectSnapshot } = await import("../../src/utils/events.js");

    await cmdInit([]);
    await cmdTask(["create", "Build", "the feature"]);
    await cmdTask(["claim", "T1", "--by", "codex"]);

    writeFileSync(join(tmpDir, "report.md"), "done");
    await cmdArtifact(["submit", "T1", "--by", "codex", "--type", "report", "--path", "report.md", "--summary", "Implementation report"]);

    mkdirSync(join(tmpDir, ".apex-manager", "workers", "T1"), { recursive: true });
    writeFileSync(join(tmpDir, ".apex-manager", "workers", "T1", "meta.json"), JSON.stringify({
      task_id: "T1",
      window_handle: { id: "@1", name: "T1-auth", adapter: "tmux" },
      worktree_path: ".apex-manager/worktrees/T1",
      branch: "apex-mgr/T1",
      started_at: new Date().toISOString(),
      agent: "codex",
    }, null, 2));

    await sendStructuredMessage({
      from: "manager",
      to: "T1",
      taskId: "T1",
      kind: "directive",
      body: "Please verify the implementation.",
      directiveAction: "info",
      adapter: makeIdleAdapter(),
    });

    assert.ok(existsSync(join(tmpDir, ".apex-manager", "state.snapshot.json")));

    const snapshot = await readProjectSnapshot();
    assert.strictEqual(snapshot.tasks.length, 1);
    assert.strictEqual(snapshot.tasks[0].status, "in_progress");
    assert.deepStrictEqual(snapshot.tasks[0].artifacts, ["ART-1"]);
    assert.strictEqual(snapshot.artifacts.length, 1);
    assert.strictEqual(snapshot.messages.length, 1);

    unlinkSync(join(tmpDir, ".apex-manager", "state.snapshot.json"));
    const rebuilt = await rebuildProjectSnapshotFromEvents();
    assert.strictEqual(rebuilt.tasks.length, 1);
    assert.strictEqual(rebuilt.artifacts.length, 1);
    assert.strictEqual(rebuilt.messages.length, 1);

    const events = readFileSync(join(tmpDir, ".apex-manager", "events.jsonl"), "utf-8");
    assert.ok(events.includes("\"type\":\"task.created\""));
    assert.ok(events.includes("\"type\":\"task.updated\""));
    assert.ok(events.includes("\"type\":\"artifact.submitted\""));
    assert.ok(events.includes("\"type\":\"message.created\""));
  });
});
