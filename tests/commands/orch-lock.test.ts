import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("orch lock management", () => {
  let tmpDir: string;
  let origCwd: string;
  let origLog: typeof console.log;
  let origError: typeof console.error;
  let logOutput: string[];
  let errorOutput: string[];

  beforeEach(() => {
    tmpDir = join(tmpdir(), `am-orch-lock-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(tmpDir, ".apex-manager"), { recursive: true });
    origCwd = process.cwd();
    process.chdir(tmpDir);

    logOutput = [];
    errorOutput = [];
    origLog = console.log;
    origError = console.error;
    console.log = (...args: any[]) => { logOutput.push(args.map(String).join(" ")); };
    console.error = (...args: any[]) => { errorOutput.push(args.map(String).join(" ")); };
  });

  afterEach(() => {
    process.chdir(origCwd);
    console.log = origLog;
    console.error = origError;
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it("updateLock updates plan_agent_handle in existing lock", async () => {
    // Create a lock file first
    const lockPath = join(tmpDir, ".apex-manager", "orch.lock");
    writeFileSync(lockPath, JSON.stringify({
      pid: process.pid,
      session_id: "old-session",
      plan_agent_handle: null,
      started_at: new Date().toISOString(),
    }, null, 2));

    const { updateLock } = await import("../../src/commands/orch.js");
    const newHandle = { id: "@99", name: "plan-agent", adapter: "cmux" };
    updateLock({ plan_agent_handle: newHandle, session_id: "new-session" });

    const updated = JSON.parse(readFileSync(lockPath, "utf-8"));
    assert.deepStrictEqual(updated.plan_agent_handle, newHandle);
    assert.strictEqual(updated.session_id, "new-session");
    // pid and started_at should be preserved
    assert.strictEqual(updated.pid, process.pid);
    assert.ok(updated.started_at !== undefined);
  });

  it("updateLock is no-op when lock does not exist", async () => {
    const { updateLock } = await import("../../src/commands/orch.js");
    // Should not throw
    updateLock({ session_id: "new" });
    assert.strictEqual(existsSync(join(tmpDir, ".apex-manager", "orch.lock")), false);
  });

  it("--force with --handle parses handle into lock", async () => {
    // Create a stale lock (dead PID)
    const lockPath = join(tmpDir, ".apex-manager", "orch.lock");
    writeFileSync(lockPath, JSON.stringify({
      pid: 999999, // very likely dead
      session_id: "stale",
      plan_agent_handle: null,
      started_at: new Date().toISOString(),
    }, null, 2));

    const { parseHandleFlag } = await import("../../src/commands/orch.js");
    const handle = parseHandleFlag(["--handle", '{"id":"@42","name":"plan-agent","adapter":"cmux"}']);
    assert.deepStrictEqual(handle, { id: "@42", name: "plan-agent", adapter: "cmux" });
  });

  it("parseHandleFlag returns null when no --handle", async () => {
    const { parseHandleFlag } = await import("../../src/commands/orch.js");
    assert.strictEqual(parseHandleFlag(["--force"]), null);
  });
});

describe("acquireLock", () => {
  let tmpDir: string;
  let origCwd: string;
  let origLog: typeof console.log;
  let logOutput: string[];

  beforeEach(() => {
    tmpDir = join(tmpdir(), `am-acquire-lock-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(tmpDir, ".apex-manager"), { recursive: true });
    origCwd = process.cwd();
    process.chdir(tmpDir);
    logOutput = [];
    origLog = console.log;
    console.log = (...args: any[]) => { logOutput.push(args.map(String).join(" ")); };
  });

  afterEach(() => {
    process.chdir(origCwd);
    console.log = origLog;
    // Clean up lock
    try {
      const { releaseLock } = require("../../src/commands/orch.js");
      releaseLock();
    } catch {}
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it("first acquire succeeds", async () => {
    const { acquireLock, releaseLock } = await import("../../src/commands/orch.js");
    const result = acquireLock("test-session-1", null);
    assert.strictEqual(result, true);
    assert.ok(existsSync(join(tmpDir, ".apex-manager", "orch.lock")));

    const lock = JSON.parse(readFileSync(join(tmpDir, ".apex-manager", "orch.lock"), "utf-8"));
    assert.strictEqual(lock.session_id, "test-session-1");
    assert.strictEqual(lock.pid, process.pid);
    releaseLock();
  });

  it("second acquire with live PID fails", async () => {
    const { acquireLock, releaseLock } = await import("../../src/commands/orch.js");
    // First acquire succeeds (our own PID is alive)
    acquireLock("session-a", null);

    // Second acquire should fail (PID is still alive -- it's us)
    const result = acquireLock("session-b", null);
    assert.strictEqual(result, false);
    releaseLock();
  });

  it("acquire with dead PID succeeds (stale lock recovery)", async () => {
    const { acquireLock, releaseLock } = await import("../../src/commands/orch.js");
    // Write a lock with a dead PID
    writeFileSync(join(tmpDir, ".apex-manager", "orch.lock"), JSON.stringify({
      pid: 999999, // very likely dead
      session_id: "dead-session",
      plan_agent_handle: null,
      started_at: new Date().toISOString(),
    }, null, 2));

    const result = acquireLock("new-session", null);
    assert.strictEqual(result, true);

    const lock = JSON.parse(readFileSync(join(tmpDir, ".apex-manager", "orch.lock"), "utf-8"));
    assert.strictEqual(lock.session_id, "new-session");
    releaseLock();
  });

  it("acquire with corrupt lock file recovers", async () => {
    const { acquireLock, releaseLock } = await import("../../src/commands/orch.js");
    // Write corrupt JSON
    writeFileSync(join(tmpDir, ".apex-manager", "orch.lock"), "not-json{{{");

    const result = acquireLock("recovery-session", null);
    assert.strictEqual(result, true);

    const lock = JSON.parse(readFileSync(join(tmpDir, ".apex-manager", "orch.lock"), "utf-8"));
    assert.strictEqual(lock.session_id, "recovery-session");
    releaseLock();
  });

  it("acquireLock stores plan_agent_handle", async () => {
    const { acquireLock, releaseLock } = await import("../../src/commands/orch.js");
    const handle = { id: "@42", name: "plan-agent" };
    acquireLock("handle-session", handle as any);

    const lock = JSON.parse(readFileSync(join(tmpDir, ".apex-manager", "orch.lock"), "utf-8"));
    assert.deepStrictEqual(lock.plan_agent_handle, handle);
    releaseLock();
  });
});
