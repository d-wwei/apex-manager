import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { assertLaunchSurfaceAlive, verifyWorkerLaunch } from "../../src/worker/launch.js";
import type { TerminalAdapter, WindowHandle } from "../../src/worker/terminal.js";

function makeTerminal(opts: { alive: boolean; screen?: string; readError?: Error }): TerminalAdapter {
  return {
    name: () => "cmux",
    available: () => true,
    createWindow: async () => ({ id: "surface-1", name: "test", adapter: "cmux" }),
    send: async () => {},
    readScreen: async () => {
      if (opts.readError) throw opts.readError;
      return opts.screen ?? "$ ready";
    },
    close: async () => {},
    isAlive: async () => opts.alive,
    rename: async () => {},
    sendKey: async () => {},
  };
}

describe("worker launch verification", () => {
  const handle: WindowHandle = { id: "surface-1", name: "T1-test", adapter: "cmux" };

  it("marks a live terminal without task activity as unverified, not failed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "am-launch-"));
    try {
      mkdirSync(join(dir, ".apex-manager"), { recursive: true });
      writeFileSync(join(dir, ".apex-manager", "tasks.json"), JSON.stringify({ tasks: [], next_id: 1 }));

      const result = await verifyWorkerLaunch(dir, "T1", "T1", makeTerminal({ alive: true, screen: "$ ready" }), handle, 1);

      assert.strictEqual(result.state, "unverified");
      assert.match(result.note ?? "", /No task claim/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails fast when the launch surface disappears", async () => {
    await assert.rejects(
      () => assertLaunchSurfaceAlive("T1", makeTerminal({ alive: false }), handle),
      /spawn_failed_terminal_surface_missing/,
    );
  });

  it("tolerates a transient read-screen failure after surface creation", async () => {
    let reads = 0;
    const terminal = makeTerminal({ alive: true });
    terminal.readScreen = async () => {
      reads += 1;
      if (reads === 1) throw new Error("pane not ready");
      return "$ ready";
    };

    await assertLaunchSurfaceAlive("T1", terminal, handle);

    assert.strictEqual(reads, 2);
  });
});
