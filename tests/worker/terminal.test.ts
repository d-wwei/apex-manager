import { describe, it, afterEach } from "node:test";
import assert from "node:assert";
import type { WindowHandle, TerminalAdapter } from "../../src/worker/terminal.js";
import { CmuxAdapter, TmuxAdapter, detectAdapter } from "../../src/worker/terminal.js";

// --- WindowHandle structure ---

describe("WindowHandle", () => {
  it("has required fields: id, name, adapter", () => {
    const handle: WindowHandle = {
      id: "surface-abc",
      name: "T1-auth-api",
      adapter: "cmux",
    };

    assert.strictEqual(handle.id, "surface-abc");
    assert.strictEqual(handle.name, "T1-auth-api");
    assert.strictEqual(handle.adapter, "cmux");
  });

  it("adapter field is 'cmux' or 'tmux'", () => {
    const cmuxHandle: WindowHandle = { id: "s1", name: "w1", adapter: "cmux" };
    const tmuxHandle: WindowHandle = { id: "t1", name: "w2", adapter: "tmux" };

    assert.ok(["cmux", "tmux"].includes(cmuxHandle.adapter));
    assert.ok(["cmux", "tmux"].includes(tmuxHandle.adapter));
  });
});

// --- CmuxAdapter ---

describe("CmuxAdapter", () => {
  it("name() returns 'cmux'", () => {
    const adapter = new CmuxAdapter();
    assert.strictEqual(adapter.name(), "cmux");
  });

  it("available() returns boolean without throwing", () => {
    const adapter = new CmuxAdapter();
    const result = adapter.available();
    assert.strictEqual(typeof result, "boolean");
  });

  it("implements TerminalAdapter interface", () => {
    const adapter: TerminalAdapter = new CmuxAdapter();
    assert.strictEqual(typeof adapter.name, "function");
    assert.strictEqual(typeof adapter.available, "function");
    assert.strictEqual(typeof adapter.createWindow, "function");
    assert.strictEqual(typeof adapter.send, "function");
    assert.strictEqual(typeof adapter.readScreen, "function");
    assert.strictEqual(typeof adapter.close, "function");
    assert.strictEqual(typeof adapter.isAlive, "function");
    assert.strictEqual(typeof adapter.rename, "function");
    assert.strictEqual(typeof adapter.sendKey, "function");
  });
});

// --- TmuxAdapter ---

describe("TmuxAdapter", () => {
  it("name() returns 'tmux'", () => {
    const adapter = new TmuxAdapter();
    assert.strictEqual(adapter.name(), "tmux");
  });

  it("available() returns boolean without throwing", () => {
    const adapter = new TmuxAdapter();
    const result = adapter.available();
    assert.strictEqual(typeof result, "boolean");
  });

  it("implements TerminalAdapter interface", () => {
    const adapter: TerminalAdapter = new TmuxAdapter();
    assert.strictEqual(typeof adapter.name, "function");
    assert.strictEqual(typeof adapter.available, "function");
    assert.strictEqual(typeof adapter.createWindow, "function");
    assert.strictEqual(typeof adapter.send, "function");
    assert.strictEqual(typeof adapter.readScreen, "function");
    assert.strictEqual(typeof adapter.close, "function");
    assert.strictEqual(typeof adapter.isAlive, "function");
    assert.strictEqual(typeof adapter.rename, "function");
    assert.strictEqual(typeof adapter.sendKey, "function");
  });
});

// --- detectAdapter ---

describe("detectAdapter", () => {
  const origEnv = { ...process.env };

  afterEach(() => {
    // Restore environment
    process.env = { ...origEnv };
  });

  it("returns CmuxAdapter when CMUX_SURFACE is set", () => {
    process.env.CMUX_SURFACE = "some-surface-id";
    const adapter = detectAdapter();
    assert.strictEqual(adapter.name(), "cmux");
  });

  it("returns adapter that is a TerminalAdapter", () => {
    // In CI or on a dev machine, at least tmux or cmux should be available.
    // If neither is available, detectAdapter throws -- that's tested separately.
    try {
      const adapter = detectAdapter();
      assert.strictEqual(typeof adapter.name, "function");
      assert.strictEqual(typeof adapter.createWindow, "function");
      assert.strictEqual(typeof adapter.send, "function");
      assert.strictEqual(typeof adapter.readScreen, "function");
      assert.strictEqual(typeof adapter.close, "function");
      assert.strictEqual(typeof adapter.isAlive, "function");
      assert.strictEqual(typeof adapter.rename, "function");
      assert.strictEqual(typeof adapter.sendKey, "function");
    } catch (e: any) {
      // If no terminal multiplexer is available, that's expected
      assert.ok(e.message.includes("requires tmux or cmux"));
    }
  });

  it("throws when no multiplexer is available", () => {
    // Clear env vars that would trigger cmux
    delete process.env.CMUX_SURFACE;
    delete process.env.TMUX;
    // Override PATH to empty so neither cmux nor tmux is found
    process.env.PATH = "/nonexistent";

    assert.throws(() => detectAdapter(), /requires tmux or cmux/);
  });
});
