import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { TerminalAdapter, WindowHandle } from "../../src/worker/terminal.js";

function makeIdleAdapter(sent: string[]): TerminalAdapter {
  return {
    name: () => "tmux",
    available: () => true,
    createWindow: async () => ({ id: "@1", name: "fake", adapter: "tmux" }),
    send: async (_handle: WindowHandle, text: string) => {
      sent.push(text);
    },
    readScreen: async () => "$ ready",
    close: async () => {},
    isAlive: async () => true,
    rename: async () => {},
    sendKey: async () => {},
  };
}

function makeAckAdapter(): TerminalAdapter {
  return {
    name: () => "tmux",
    available: () => true,
    createWindow: async () => ({ id: "@1", name: "fake", adapter: "tmux" }),
    send: async () => {},
    readScreen: async () => "ACK MSG-1",
    close: async () => {},
    isAlive: async () => true,
    rename: async () => {},
    sendKey: async () => {},
  };
}

describe("daemon message queue loop", () => {
  let tmpDir: string;
  let origCwd: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `am-daemon-msg-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(tmpDir, ".apex-manager", "workers", "T1"), { recursive: true });
    mkdirSync(join(tmpDir, ".apex-manager", "messages"), { recursive: true });
    origCwd = process.cwd();
    process.chdir(tmpDir);

    writeFileSync(join(tmpDir, ".apex-manager", "workers", "T1", "meta.json"), JSON.stringify({
      task_id: "T1",
      window_handle: { id: "@1", name: "T1-auth", adapter: "tmux" },
      worktree_path: ".apex-manager/worktrees/T1",
      branch: "apex-mgr/T1",
      started_at: new Date().toISOString(),
      agent: "codex",
    }, null, 2));
  });

  afterEach(() => {
    process.chdir(origCwd);
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it("delivers pending messages when the worker becomes idle", async () => {
    const sent: string[] = [];
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
        body: "Read when idle.",
        delivery_status: "pending",
        created_at: new Date().toISOString(),
      }],
    }, null, 2));

    const { processMessageQueueOnce } = await import("../../src/worker/messages.js");
    await processMessageQueueOnce({ adapter: makeIdleAdapter(sent) });

    const store = JSON.parse(readFileSync(join(tmpDir, ".apex-manager", "messages", "index.json"), "utf-8"));
    assert.strictEqual(store.messages[0].delivery_status, "delivered");
    assert.strictEqual(sent.length, 1);
  });

  it("marks delivered messages as acked when daemon sees an ACK", async () => {
    writeFileSync(join(tmpDir, ".apex-manager", "messages", "index.json"), JSON.stringify({
      next_id: 2,
      messages: [{
        id: "MSG-1",
        from: "manager",
        to: "T1",
        task_id: "T1",
        kind: "question",
        priority: "normal",
        ack_required: true,
        ack_timeout_ms: 30_000,
        body: "Did you check it?",
        delivery_status: "delivered",
        created_at: new Date().toISOString(),
        delivered_at: new Date().toISOString(),
      }],
    }, null, 2));

    const { processMessageQueueOnce } = await import("../../src/worker/messages.js");
    await processMessageQueueOnce({ adapter: makeAckAdapter() });

    const store = JSON.parse(readFileSync(join(tmpDir, ".apex-manager", "messages", "index.json"), "utf-8"));
    assert.strictEqual(store.messages[0].delivery_status, "acked");
    assert.ok(store.messages[0].acknowledged_at);
  });

  it("marks delivered messages as ack_timeout after the deadline", async () => {
    writeFileSync(join(tmpDir, ".apex-manager", "messages", "index.json"), JSON.stringify({
      next_id: 2,
      messages: [{
        id: "MSG-1",
        from: "manager",
        to: "T1",
        task_id: "T1",
        kind: "question",
        priority: "normal",
        ack_required: true,
        ack_timeout_ms: 1,
        body: "Did you check it?",
        delivery_status: "delivered",
        created_at: new Date(Date.now() - 10_000).toISOString(),
        delivered_at: new Date(Date.now() - 10_000).toISOString(),
      }],
    }, null, 2));

    const { processMessageQueueOnce } = await import("../../src/worker/messages.js");
    await processMessageQueueOnce({ adapter: makeIdleAdapter([]) });

    const store = JSON.parse(readFileSync(join(tmpDir, ".apex-manager", "messages", "index.json"), "utf-8"));
    assert.strictEqual(store.messages[0].delivery_status, "ack_timeout");
  });
});
