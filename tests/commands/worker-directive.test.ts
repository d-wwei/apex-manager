import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("cmdDirective", () => {
  let tmpDir: string;
  let origCwd: string;
  let origLog: typeof console.log;
  let origError: typeof console.error;
  let origExit: typeof process.exit;
  let logOutput: string[];
  let errorOutput: string[];

  beforeEach(() => {
    tmpDir = join(tmpdir(), `am-directive-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
    origCwd = process.cwd();
    process.chdir(tmpDir);

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
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  function makeWorkerDir(taskId: string) {
    mkdirSync(join(tmpDir, ".apex-manager", "workers", taskId), { recursive: true });
  }

  it("writes directive.json with correct structure", async () => {
    makeWorkerDir("T1");
    const { cmdDirective } = await import("../../src/commands/worker.js");
    await cmdDirective(["T1", "amend", "Change API endpoint to /users/import"]);

    const dirPath = join(tmpDir, ".apex-manager", "workers", "T1", "directive.json");
    assert.ok(existsSync(dirPath));

    const data = JSON.parse(readFileSync(dirPath, "utf-8"));
    assert.strictEqual(data.from, "plan-agent");
    assert.strictEqual(data.action, "amend");
    assert.strictEqual(data.content.description, "Change API endpoint to /users/import");
    assert.strictEqual(data.content.urgency, "normal");
    assert.ok(data.created_at !== undefined);
  });

  it("supports --urgent flag", async () => {
    makeWorkerDir("T2");
    const { cmdDirective } = await import("../../src/commands/worker.js");
    await cmdDirective(["T2", "amend", "Stop current work", "--urgent"]);

    const data = JSON.parse(readFileSync(join(tmpDir, ".apex-manager", "workers", "T2", "directive.json"), "utf-8"));
    assert.strictEqual(data.content.urgency, "high");
  });

  it("rejects invalid action", async () => {
    makeWorkerDir("T3");
    const { cmdDirective } = await import("../../src/commands/worker.js");
    await assert.rejects(
      () => cmdDirective(["T3", "invalid_action", "content"]),
      /process\.exit\(1\)/,
    );
    assert.ok(errorOutput.some(line => line.includes("amend")));
  });

  it("rejects missing worker directory", async () => {
    const { cmdDirective } = await import("../../src/commands/worker.js");
    await assert.rejects(
      () => cmdDirective(["T99", "amend", "content"]),
      /process\.exit\(1\)/,
    );
    assert.ok(errorOutput.some(line => line.includes("T99")));
  });

  it("requires all three arguments", async () => {
    const { cmdDirective } = await import("../../src/commands/worker.js");
    await assert.rejects(
      () => cmdDirective(["T1"]),
      /process\.exit\(1\)/,
    );
    assert.ok(errorOutput.some(line => line.includes("Usage:")));
  });
});
