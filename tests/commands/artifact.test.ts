import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("artifact commands", () => {
  let tmpDir: string;
  let origCwd: string;
  let origLog: typeof console.log;
  let origExit: typeof process.exit;
  let logOutput: string[];

  beforeEach(() => {
    tmpDir = join(tmpdir(), `am-artifact-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
    origCwd = process.cwd();
    process.chdir(tmpDir);
    origLog = console.log;
    origExit = process.exit;
    logOutput = [];
    console.log = (...args: any[]) => {
      logOutput.push(args.map(String).join(" "));
    };
    process.exit = ((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as any;
  });

  afterEach(() => {
    process.chdir(origCwd);
    console.log = origLog;
    process.exit = origExit;
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

  it("resolves relative artifact paths from the worker worktree", async () => {
    const { cmdInit } = await import("../../src/commands/init.js");
    const { cmdTask } = await import("../../src/commands/task.js");
    const { cmdArtifact } = await import("../../src/commands/artifact.js");

    await cmdInit([]);
    await cmdTask(["create", "Write", "report"]);

    const workerDir = join(tmpDir, ".apex-manager", "workers", "T1");
    const worktreeDir = join(tmpDir, ".apex-manager", "worktrees", "T1");
    mkdirSync(join(workerDir), { recursive: true });
    mkdirSync(join(worktreeDir, "docs"), { recursive: true });
    writeFileSync(join(workerDir, "meta.json"), JSON.stringify({
      task_id: "T1",
      worktree_path: ".apex-manager/worktrees/T1",
      branch: "apex-mgr/T1",
      started_at: new Date().toISOString(),
      agent: "codex",
      window_handle: null,
    }));
    writeFileSync(join(worktreeDir, "docs", "report.md"), "# Report\n");

    await cmdArtifact(["submit", "T1", "--by", "T1", "--type", "report", "--path", "docs/report.md", "--summary", "worktree-report"]);

    const artifactStore = JSON.parse(readFileSync(join(tmpDir, ".apex-manager", "artifacts", "index.json"), "utf-8"));
    assert.strictEqual(realpathSync(artifactStore.artifacts[0].absolute_path), realpathSync(join(worktreeDir, "docs", "report.md")));
  });

  it("prefers worker worktree when cwd has the same relative artifact path", async () => {
    const { cmdInit } = await import("../../src/commands/init.js");
    const { cmdTask } = await import("../../src/commands/task.js");
    const { cmdArtifact } = await import("../../src/commands/artifact.js");

    await cmdInit([]);
    await cmdTask(["create", "Write", "report"]);

    const workerDir = join(tmpDir, ".apex-manager", "workers", "T1");
    const worktreeDir = join(tmpDir, ".apex-manager", "worktrees", "T1");
    mkdirSync(join(workerDir), { recursive: true });
    mkdirSync(join(worktreeDir, "docs"), { recursive: true });
    mkdirSync(join(tmpDir, "docs"), { recursive: true });
    writeFileSync(join(workerDir, "meta.json"), JSON.stringify({
      task_id: "T1",
      worktree_path: ".apex-manager/worktrees/T1",
      branch: "apex-mgr/T1",
      started_at: new Date().toISOString(),
      agent: "codex",
      window_handle: null,
    }));
    writeFileSync(join(tmpDir, "docs", "report.md"), "# Root Report\n");
    writeFileSync(join(worktreeDir, "docs", "report.md"), "# Worktree Report\n");

    await cmdArtifact(["submit", "T1", "--by", "T1", "--type", "report", "--path", "docs/report.md", "--summary", "worktree-report"]);

    const artifactStore = JSON.parse(readFileSync(join(tmpDir, ".apex-manager", "artifacts", "index.json"), "utf-8"));
    assert.strictEqual(realpathSync(artifactStore.artifacts[0].absolute_path), realpathSync(join(worktreeDir, "docs", "report.md")));
  });

  it("rejects artifact paths outside project and worker worktree", async () => {
    const { cmdInit } = await import("../../src/commands/init.js");
    const { cmdTask } = await import("../../src/commands/task.js");
    const { cmdArtifact } = await import("../../src/commands/artifact.js");

    await cmdInit([]);
    await cmdTask(["create", "Write", "report"]);
    const outsidePath = join(tmpDir, "..", `secret-${Date.now()}.txt`);
    writeFileSync(outsidePath, "OPENAI_API_KEY=sk-testsecret123456789\n");

    try {
      await assert.rejects(
        () => cmdArtifact(["submit", "T1", "--by", "T1", "--type", "report", "--path", outsidePath, "--summary", "secret"]),
        /process\.exit\(1\)/,
      );
    } finally {
      rmSync(outsidePath, { force: true });
    }
  });
});
