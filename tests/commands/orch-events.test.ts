import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("orch event inspection", () => {
  let tmpDir: string;
  let origCwd: string;
  let origLog: typeof console.log;
  let logOutput: string[];

  beforeEach(() => {
    tmpDir = join(tmpdir(), `am-orch-events-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(tmpDir, ".apex-manager"), { recursive: true });
    origCwd = process.cwd();
    process.chdir(tmpDir);

    logOutput = [];
    origLog = console.log;
    console.log = (...args: any[]) => { logOutput.push(args.map(String).join(" ")); };

    writeFileSync(join(tmpDir, ".apex-manager", "events.jsonl"), [
      JSON.stringify({ type: "task.created", timestamp: "2026-04-29T00:00:00.000Z", task: { id: "T1" } }),
      JSON.stringify({ type: "message.created", timestamp: "2026-04-29T00:01:00.000Z", message: { id: "MSG-1" } }),
    ].join("\n") + "\n");
  });

  afterEach(() => {
    process.chdir(origCwd);
    console.log = origLog;
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it("prints the most recent events", async () => {
    const { cmdOrch } = await import("../../src/commands/orch.js");
    await cmdOrch(["events", "--tail", "1"]);

    const output = logOutput.join("\n");
    assert.ok(output.includes("message.created"));
    assert.ok(!output.includes("task.created"));
  });

  it("can rebuild and print snapshot summaries", async () => {
    const { cmdOrch } = await import("../../src/commands/orch.js");
    await cmdOrch(["snapshot", "--rebuild"]);

    const output = logOutput.join("\n");
    assert.ok(output.includes("tasks=1"));
    assert.ok(output.includes("messages=1"));
  });
});
