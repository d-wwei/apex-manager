import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { TerminalAdapter, WindowHandle } from "../../src/worker/terminal.js";

function makeFakeAdapter(sent: string[]): TerminalAdapter {
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

function makeAckingAdapter(sent: string[]): TerminalAdapter {
  return {
    name: () => "tmux",
    available: () => true,
    createWindow: async () => ({ id: "@1", name: "fake", adapter: "tmux" }),
    send: async (_handle: WindowHandle, text: string) => {
      sent.push(text);
    },
    readScreen: async () => "$ ready\nACK MSG-1",
    close: async () => {},
    isAlive: async () => true,
    rename: async () => {},
    sendKey: async () => {},
  };
}

function makeBusyAdapter(sent: string[]): TerminalAdapter {
  return {
    name: () => "tmux",
    available: () => true,
    createWindow: async () => ({ id: "@1", name: "fake", adapter: "tmux" }),
    send: async (_handle: WindowHandle, text: string) => {
      sent.push(text);
    },
    readScreen: async () => "running task... esc to interrupt",
    close: async () => {},
    isAlive: async () => true,
    rename: async () => {},
    sendKey: async () => {},
  };
}

function makeUrgentAdapter(sent: string[], keys: string[]): TerminalAdapter {
  let reads = 0;
  return {
    name: () => "tmux",
    available: () => true,
    createWindow: async () => ({ id: "@1", name: "fake", adapter: "tmux" }),
    send: async (_handle: WindowHandle, text: string) => {
      sent.push(text);
    },
    readScreen: async () => {
      reads += 1;
      return reads < 2 ? "running task... esc to interrupt" : "$ ready";
    },
    close: async () => {},
    isAlive: async () => true,
    rename: async () => {},
    sendKey: async (_handle: WindowHandle, key: string) => {
      keys.push(key);
    },
  };
}

describe("structured worker messaging", () => {
  let tmpDir: string;
  let origCwd: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `am-msg-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(tmpDir, ".apex-manager", "workers", "T1"), { recursive: true });
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

  it("stores, envelopes, and delivers a structured message", async () => {
    const sent: string[] = [];
    const { sendStructuredMessage } = await import("../../src/worker/messages.js");

    const message = await sendStructuredMessage({
      from: "manager",
      to: "T1",
      taskId: "T1",
      kind: "directive",
      body: "Please re-check the empty state.",
      directiveAction: "amend",
      adapter: makeFakeAdapter(sent),
    });

    assert.strictEqual(message.id, "MSG-1");
    assert.strictEqual(message.delivery_status, "delivered");
    assert.strictEqual(sent.length, 1);
    assert.ok(sent[0].includes("[PLAN-AGENT]"));
    assert.ok(sent[0].includes("[APEX-MSG id=MSG-1"));
    assert.ok(sent[0].includes("ACK MSG-1"));

    const directive = JSON.parse(readFileSync(join(tmpDir, ".apex-manager", "workers", "T1", "directive.json"), "utf-8"));
    assert.strictEqual(directive.action, "amend");
    assert.strictEqual(directive.content.description, "Please re-check the empty state.");

    const store = JSON.parse(readFileSync(join(tmpDir, ".apex-manager", "messages", "index.json"), "utf-8"));
    assert.strictEqual(store.messages.length, 1);
    assert.strictEqual(store.messages[0].delivery_status, "delivered");

    const eventLog = readFileSync(join(tmpDir, ".apex-manager", "event-log.jsonl"), "utf-8");
    assert.ok(eventLog.includes("\"type\":\"message.created\""));
    assert.ok(eventLog.includes("\"type\":\"message.delivered\""));
  });

  it("can wait for and record ACKs", async () => {
    const sent: string[] = [];
    const { sendStructuredMessage } = await import("../../src/worker/messages.js");

    const message = await sendStructuredMessage({
      from: "manager",
      to: "T1",
      taskId: "T1",
      kind: "question",
      body: "Did you inspect the edge case?",
      directiveAction: "info",
      waitForAck: true,
      ackTimeoutMs: 100,
      adapter: makeAckingAdapter(sent),
    });

    assert.strictEqual(message.delivery_status, "acked");
    assert.ok(message.acknowledged_at);

    const store = JSON.parse(readFileSync(join(tmpDir, ".apex-manager", "messages", "index.json"), "utf-8"));
    assert.strictEqual(store.messages[0].delivery_status, "acked");

    const eventLog = readFileSync(join(tmpDir, ".apex-manager", "event-log.jsonl"), "utf-8");
    assert.ok(eventLog.includes("\"type\":\"message.acknowledged\""));
  });

  it("keeps normal messages pending while the worker is busy", async () => {
    const sent: string[] = [];
    const { sendStructuredMessage } = await import("../../src/worker/messages.js");

    const message = await sendStructuredMessage({
      from: "manager",
      to: "T1",
      taskId: "T1",
      kind: "directive",
      body: "Wait until you are idle before reading this.",
      directiveAction: "info",
      adapter: makeBusyAdapter(sent),
    });

    assert.strictEqual(message.delivery_status, "pending");
    assert.strictEqual(sent.length, 0);

    const store = JSON.parse(readFileSync(join(tmpDir, ".apex-manager", "messages", "index.json"), "utf-8"));
    assert.strictEqual(store.messages[0].delivery_status, "pending");

    const events = readFileSync(join(tmpDir, ".apex-manager", "events.jsonl"), "utf-8");
    assert.ok(events.includes("\"type\":\"message.created\""));
    assert.ok(!events.includes("\"type\":\"message.delivered\""));
  });

  it("interrupts first for urgent messages before delivering", async () => {
    const sent: string[] = [];
    const keys: string[] = [];
    const { sendStructuredMessage } = await import("../../src/worker/messages.js");

    const message = await sendStructuredMessage({
      from: "manager",
      to: "T1",
      taskId: "T1",
      kind: "directive",
      priority: "urgent",
      body: "Stop and switch approach now.",
      directiveAction: "abort",
      idleWaitTimeoutMs: 20,
      idlePollIntervalMs: 1,
      adapter: makeUrgentAdapter(sent, keys),
    });

    assert.strictEqual(message.delivery_status, "delivered");
    assert.deepStrictEqual(keys, ["C-c"]);
    assert.strictEqual(sent.length, 1);
    assert.ok(sent[0].includes("[PLAN-AGENT:INTERRUPT]"));
  });
});
