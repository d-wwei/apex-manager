import { spawnSync } from "child_process";

// --- WindowHandle ---

export interface WindowHandle {
  id: string;       // tmux target or cmux surface ID
  name: string;     // window title (e.g. "T1-auth-api")
  adapter: string;  // "cmux" | "tmux"
}

// --- TerminalAdapter ---

export interface TerminalAdapter {
  name(): string;
  available(): boolean;
  createWindow(name: string, command: string): Promise<WindowHandle>;
  send(handle: WindowHandle, text: string): Promise<void>;
  readScreen(handle: WindowHandle, lines?: number): Promise<string>;
  close(handle: WindowHandle): Promise<void>;
  isAlive(handle: WindowHandle): Promise<boolean>;
  rename(handle: WindowHandle, name: string): Promise<void>;
  sendKey(handle: WindowHandle, key: string): Promise<void>;
}

// --- Helpers ---

function run(cmd: string, args: string[], timeoutMs = 10_000): { ok: boolean; stdout: string; stderr: string } {
  try {
    const result = spawnSync(cmd, args, { encoding: "utf-8", timeout: timeoutMs, env: process.env });
    return {
      ok: result.status === 0,
      stdout: (result.stdout ?? "").trim(),
      stderr: (result.stderr ?? "").trim(),
    };
  } catch {
    return { ok: false, stdout: "", stderr: "spawn failed" };
  }
}

function which(binary: string): boolean {
  try {
    const result = spawnSync("which", [binary], { encoding: "utf-8", timeout: 5_000, env: process.env });
    return result.status === 0;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- CmuxAdapter ---

const CMUX_BIN = "/Applications/cmux.app/Contents/Resources/bin/cmux";

export class CmuxAdapter implements TerminalAdapter {
  name(): string {
    return "cmux";
  }

  available(): boolean {
    try {
      return which("cmux") || run(CMUX_BIN, ["--version"], 5_000).ok;
    } catch {
      return false;
    }
  }

  private bin(): string {
    return which("cmux") ? "cmux" : CMUX_BIN;
  }

  async createWindow(name: string, command: string): Promise<WindowHandle> {
    const bin = this.bin();
    const create = run(bin, ["new-surface"]);
    if (!create.ok) {
      throw new Error(`cmux new-surface failed: ${create.stderr}`);
    }
    const surfaceId = create.stdout;

    // Send command to the new surface
    const send = run(bin, ["send", surfaceId, command]);
    if (!send.ok) {
      throw new Error(`cmux send failed: ${send.stderr}`);
    }

    // Rename the tab
    run(bin, ["rename-tab", surfaceId, name]);

    return { id: surfaceId, name, adapter: "cmux" };
  }

  async send(handle: WindowHandle, text: string): Promise<void> {
    const result = run(this.bin(), ["send", handle.id, text]);
    if (!result.ok) {
      throw new Error(`cmux send failed: ${result.stderr}`);
    }
  }

  async readScreen(handle: WindowHandle, lines?: number): Promise<string> {
    const args = ["read-screen", handle.id];
    if (lines !== undefined) {
      args.push("--lines", String(lines));
    }
    const result = run(this.bin(), args, 10_000);
    if (!result.ok) {
      throw new Error(`cmux read-screen failed: ${result.stderr}`);
    }
    return result.stdout;
  }

  async close(handle: WindowHandle): Promise<void> {
    // Idempotent -- ignore errors (surface may already be closed)
    run(this.bin(), ["close-surface", handle.id]);
  }

  async isAlive(handle: WindowHandle): Promise<boolean> {
    const delays = [200, 400, 800];
    for (let i = 0; i < delays.length; i++) {
      const result = run(this.bin(), ["validate-surface", handle.id]);
      if (result.ok) return true;
      if (i < delays.length - 1) {
        await sleep(delays[i]);
      }
    }
    return false;
  }

  async rename(handle: WindowHandle, name: string): Promise<void> {
    const result = run(this.bin(), ["rename-tab", handle.id, name]);
    if (!result.ok) {
      throw new Error(`cmux rename-tab failed: ${result.stderr}`);
    }
    handle.name = name;
  }

  async sendKey(handle: WindowHandle, key: string): Promise<void> {
    const result = run(this.bin(), ["send-key", handle.id, key]);
    if (!result.ok) {
      throw new Error(`cmux send-key failed: ${result.stderr}`);
    }
  }
}

// --- TmuxAdapter ---

export class TmuxAdapter implements TerminalAdapter {
  name(): string {
    return "tmux";
  }

  available(): boolean {
    try {
      return which("tmux");
    } catch {
      return false;
    }
  }

  async createWindow(name: string, command: string): Promise<WindowHandle> {
    const result = run("tmux", ["new-window", "-n", name, "-P", "-F", "#{window_id}", command]);
    if (!result.ok) {
      throw new Error(`tmux new-window failed: ${result.stderr}`);
    }
    const target = result.stdout;
    return { id: target, name, adapter: "tmux" };
  }

  async send(handle: WindowHandle, text: string): Promise<void> {
    const result = run("tmux", ["send-keys", "-t", handle.id, text, "Enter"]);
    if (!result.ok) {
      throw new Error(`tmux send-keys failed: ${result.stderr}`);
    }
  }

  async readScreen(handle: WindowHandle, lines?: number): Promise<string> {
    const args = ["capture-pane", "-t", handle.id, "-p"];
    if (lines && lines > 0) {
      args.push("-S", `-${lines}`);
    }
    const result = run("tmux", args);
    if (!result.ok) {
      throw new Error(`tmux capture-pane failed: ${result.stderr}`);
    }
    return result.stdout;
  }

  async close(handle: WindowHandle): Promise<void> {
    run("tmux", ["kill-window", "-t", handle.id]);
  }

  async isAlive(handle: WindowHandle): Promise<boolean> {
    const result = run("tmux", ["list-windows", "-F", "#{window_id}"]);
    if (!result.ok) return false;
    const windowIds = result.stdout.split("\n");
    return windowIds.includes(handle.id);
  }

  async rename(handle: WindowHandle, name: string): Promise<void> {
    const result = run("tmux", ["rename-window", "-t", handle.id, name]);
    if (!result.ok) {
      throw new Error(`tmux rename-window failed: ${result.stderr}`);
    }
    handle.name = name;
  }

  async sendKey(handle: WindowHandle, key: string): Promise<void> {
    const result = run("tmux", ["send-keys", "-t", handle.id, key]);
    if (!result.ok) {
      throw new Error(`tmux send-keys failed: ${result.stderr}`);
    }
  }
}

// --- Auto-detection ---

export function detectAdapter(): TerminalAdapter {
  // Priority 1: CMUX_SURFACE env var means we're inside a cmux session
  if (process.env.CMUX_SURFACE) {
    return new CmuxAdapter();
  }

  // Priority 2: cmux binary available AND inside a tmux session (cmux runs atop tmux)
  const cmuxAvail = which("cmux") || run(CMUX_BIN, ["--version"], 5_000).ok;
  if (cmuxAvail && process.env.TMUX) {
    return new CmuxAdapter();
  }

  // Priority 3: tmux available
  if (which("tmux")) {
    return new TmuxAdapter();
  }

  throw new Error(
    "apex-manager worker requires tmux or cmux. Install: brew install tmux",
  );
}
