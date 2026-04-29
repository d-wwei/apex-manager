import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { WindowHandle, TerminalAdapter } from "../../src/worker/terminal.js";
import { CmuxAdapter, TmuxAdapter, detectAdapter, inspectTmuxHandle } from "../../src/worker/terminal.js";

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

describe("CmuxAdapter command submission", () => {
  let tmpPathDir: string;
  let logPath: string;
  const origEnv = { ...process.env };

  beforeEach(() => {
    tmpPathDir = join(tmpdir(), `am-cmux-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpPathDir, { recursive: true });
    logPath = join(tmpPathDir, "cmux.log");

    const script = `#!/bin/sh
echo "$@" >> "$CMUX_LOG"
case "$1" in
  new-split)
    echo "surface-123"
    exit 0
    ;;
  new-surface)
    echo "surface-fallback"
    exit 0
    ;;
  send|send-key|rename-tab|close-surface|validate-surface|read-screen|ping|--version)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`;
    const scriptPath = join(tmpPathDir, "cmux");
    writeFileSync(scriptPath, script);
    chmodSync(scriptPath, 0o755);

    process.env = {
      ...origEnv,
      PATH: `${tmpPathDir}:${origEnv.PATH ?? ""}`,
      CMUX_LOG: logPath,
    };
  });

  afterEach(() => {
    process.env = { ...origEnv };
    rmSync(tmpPathDir, { recursive: true, force: true });
  });

  it("send() appends enter after cmux send", async () => {
    const adapter = new CmuxAdapter();
    await adapter.send({ id: "surface-1", name: "T1-auth", adapter: "cmux" }, "echo ready");

    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    assert.deepStrictEqual(lines, [
      "send surface-1 echo ready",
      "send-key surface-1 enter",
    ]);
  });

  it("createWindow() submits the initial command in a new split", async () => {
    const adapter = new CmuxAdapter();
    const handle = await adapter.createWindow("T1-auth", "echo boot");

    assert.strictEqual(handle.id, "surface-123");

    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    assert.deepStrictEqual(lines, [
      "new-split right",
      "send surface-123 echo boot",
      "send-key surface-123 enter",
      "rename-tab surface-123 T1-auth",
    ]);
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

describe("TmuxAdapter detached sessions", () => {
  let tmpPathDir: string;
  let logPath: string;
  const origEnv = { ...process.env };

  beforeEach(() => {
    tmpPathDir = join(tmpdir(), `am-tmux-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpPathDir, { recursive: true });
    logPath = join(tmpPathDir, "tmux.log");

    const tmuxScript = `#!/bin/sh
echo "tmux:$@" >> "$TMUX_LOG"
case "$1" in
  new-session)
    echo "@42"
    exit 0
    ;;
  display-message)
    echo "apex-worker-t1-auth-abc123\t@42\tT1-auth"
    exit 0
    ;;
  list-clients)
    echo "/dev/ttys001\tapex-worker-t1-auth-abc123\t@42\tT1-auth"
    exit 0
    ;;
  kill-session|kill-window|kill-pane|list-panes|list-windows|send-keys|capture-pane|has-session|select-layout)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`;
    const osascriptScript = `#!/bin/sh
echo "osascript:$@" >> "$TMUX_LOG"
exit 0
`;

    writeFileSync(join(tmpPathDir, "tmux"), tmuxScript);
    writeFileSync(join(tmpPathDir, "osascript"), osascriptScript);
    chmodSync(join(tmpPathDir, "tmux"), 0o755);
    chmodSync(join(tmpPathDir, "osascript"), 0o755);

    process.env = {
      ...origEnv,
      PATH: `${tmpPathDir}:${origEnv.PATH ?? ""}`,
    };
    process.env.TMUX_LOG = logPath;
    delete process.env.TMUX;
  });

  afterEach(() => {
    process.env = { ...origEnv };
    rmSync(tmpPathDir, { recursive: true, force: true });
  });

  it("creates a dedicated tmux session when launched outside tmux", async () => {
    const adapter = new TmuxAdapter();
    const handle = await adapter.createWindow("T1-auth", "echo boot");

    assert.strictEqual(handle.id, "@42");
    assert.ok(handle.session?.startsWith("apex-worker-t1-auth-"));

    const log = readFileSync(logPath, "utf-8");
    assert.ok(log.includes("tmux:new-session -d -s apex-worker-t1-auth-"));
    assert.ok(log.includes("osascript:-e"));
  });

  it("send() submits text and Enter as separate tmux commands", async () => {
    const adapter = new TmuxAdapter();
    await adapter.send({ id: "@42", name: "T1-auth", adapter: "tmux" }, "echo ready");

    const log = readFileSync(logPath, "utf-8");
    assert.ok(log.includes("tmux:send-keys -t @42 -l echo ready"));
    assert.ok(log.includes("tmux:send-keys -t @42 Enter"));
  });

  it("can inspect tmux client-to-window mappings", () => {
    const info = inspectTmuxHandle({
      id: "@42",
      name: "T1-auth",
      adapter: "tmux",
      session: "apex-worker-t1-auth-abc123",
    });

    assert.ok(info);
    assert.strictEqual(info?.session, "apex-worker-t1-auth-abc123");
    assert.strictEqual(info?.windowId, "@42");
    assert.strictEqual(info?.matchedClients.length, 1);
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
