import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("cmdMsg", () => {
  let tmpDir: string;
  let origCwd: string;
  let origLog: typeof console.log;
  let origError: typeof console.error;
  let origExit: typeof process.exit;
  let logOutput: string[];
  let errorOutput: string[];

  beforeEach(() => {
    tmpDir = join(tmpdir(), `am-msg-cmd-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(tmpDir, ".apex-manager", "messages"), { recursive: true });
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

    writeFileSync(join(tmpDir, ".apex-manager", "messages", "index.json"), JSON.stringify({
      next_id: 2,
      messages: [{
        id: "MSG-1",
        from: "manager",
        to: "T1",
        task_id: "T1",
        kind: "directive",
        priority: "normal",
        ack_required: true,
        ack_timeout_ms: 30_000,
        body: "Please re-check it.",
        delivery_status: "delivered",
        created_at: new Date().toISOString(),
        delivered_at: new Date().toISOString(),
      }],
    }, null, 2));
    writeFileSync(join(tmpDir, ".apex-manager", "events.jsonl"), "");
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

  it("lists and shows stored messages", async () => {
    const { cmdMsg } = await import("../../src/commands/msg.js");

    await cmdMsg(["list"]);
    await cmdMsg(["show", "MSG-1"]);

    const output = logOutput.join("\n");
    assert.ok(output.includes("MSG-1"));
    assert.ok(output.includes("directive"));
    assert.ok(output.includes("Please re-check it."));
  });

  it("can manually ACK a message", async () => {
    const { cmdMsg } = await import("../../src/commands/msg.js");

    await cmdMsg(["ack", "MSG-1", "--by", "T1"]);

    const store = JSON.parse(readFileSync(join(tmpDir, ".apex-manager", "messages", "index.json"), "utf-8"));
    assert.strictEqual(store.messages[0].delivery_status, "acked");
    assert.strictEqual(store.messages[0].acknowledged_by, "T1");

    const events = readFileSync(join(tmpDir, ".apex-manager", "events.jsonl"), "utf-8");
    assert.ok(events.includes("\"type\":\"message.acknowledged\""));
  });
});
