import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("artifact commands", () => {
  let tmpDir: string;
  let origCwd: string;
  let origLog: typeof console.log;
  let logOutput: string[];

  beforeEach(() => {
    tmpDir = join(tmpdir(), `am-artifact-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
    origCwd = process.cwd();
    process.chdir(tmpDir);
    origLog = console.log;
    logOutput = [];
    console.log = (...args: any[]) => {
      logOutput.push(args.map(String).join(" "));
    };
  });

  afterEach(() => {
    process.chdir(origCwd);
    console.log = origLog;
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it("submit records a generic artifact and links it to a task", async () => {
    const { cmdInit } = await import("../../src/commands/init.js");
    const { cmdTask } = await import("../../src/commands/task.js");
    const { cmdArtifact } = await import("../../src/commands/artifact.js");

    await cmdInit([]);
    await cmdTask(["create", "Write", "report"]);
    writeFileSync(join(tmpDir, "report.md"), "# Report\n");

    await cmdArtifact(["submit", "T1", "--by", "codex", "--type", "report", "--path", "report.md", "--summary", "implementation-report"]);

    const artifactStore = JSON.parse(readFileSync(join(tmpDir, ".apex-manager", "artifacts", "index.json"), "utf-8"));
    assert.strictEqual(artifactStore.artifacts.length, 1);
    assert.strictEqual(artifactStore.artifacts[0].task_id, "T1");
    assert.strictEqual(artifactStore.artifacts[0].by, "codex");
    assert.strictEqual(artifactStore.artifacts[0].type, "report");

    const taskStore = JSON.parse(readFileSync(join(tmpDir, ".apex-manager", "tasks.json"), "utf-8"));
    assert.deepStrictEqual(taskStore.tasks[0].artifacts, [artifactStore.artifacts[0].id]);
  });

  it("list and show expose stored artifact metadata", async () => {
    const { cmdInit } = await import("../../src/commands/init.js");
    const { cmdTask } = await import("../../src/commands/task.js");
    const { cmdArtifact } = await import("../../src/commands/artifact.js");

    await cmdInit([]);
    await cmdTask(["create", "Write", "report"]);
    writeFileSync(join(tmpDir, "report.md"), "# Report\n");
    await cmdArtifact(["submit", "T1", "--by", "codex", "--type", "report", "--path", "report.md", "--summary", "implementation-report"]);

    await cmdArtifact(["list"]);
    await cmdArtifact(["show", "ART-1"]);

    const output = logOutput.join("\n");
    assert.ok(output.includes("ART-1"));
    assert.ok(output.includes("implementation-report"));
    assert.ok(output.includes("report.md"));
  });
});
