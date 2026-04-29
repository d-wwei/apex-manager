import { spawnSync } from "child_process";

// --- WindowHandle ---

export interface WindowHandle {
  id: string;       // tmux target or cmux surface ID
  name: string;     // window title (e.g. "T1-auth-api")
  adapter: string;  // "cmux" | "tmux"
  session?: string; // tmux session name when applicable
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

  private submit(surfaceId: string): void {
    const result = run(this.bin(), ["send-key", surfaceId, "enter"]);
    if (!result.ok) {
      throw new Error(`cmux send-key failed: ${result.stderr}`);
    }
  }

  async createWindow(name: string, command: string): Promise<WindowHandle> {
    const bin = this.bin();

    // Use split (visible pane next to Plan Agent) instead of new-surface (hidden tab)
    const create = run(bin, ["new-split", "right"]);
    if (!create.ok) {
      // Fallback to new-surface if split fails (e.g. no active workspace)
      const fallback = run(bin, ["new-surface"]);
      if (!fallback.ok) {
        throw new Error(`cmux new-split and new-surface both failed: ${create.stderr}`);
      }
      const surfaceId = fallback.stdout;
      const sendResult = run(bin, ["send", surfaceId, command]);
      if (!sendResult.ok) {
        throw new Error(`cmux send failed: ${sendResult.stderr}`);
      }
      this.submit(surfaceId);
      run(bin, ["rename-tab", surfaceId, name]);
      return { id: surfaceId, name, adapter: "cmux" };
    }

    const surfaceId = create.stdout;

    // Send command to the new split pane
    const sendResult = run(bin, ["send", surfaceId, command]);
    if (!sendResult.ok) {
      throw new Error(`cmux send failed: ${sendResult.stderr}`);
    }
    this.submit(surfaceId);

    // Rename the tab for identification
    run(bin, ["rename-tab", surfaceId, name]);

    return { id: surfaceId, name, adapter: "cmux" };
  }

  async send(handle: WindowHandle, text: string): Promise<void> {
    const result = run(this.bin(), ["send", handle.id, text]);
    if (!result.ok) {
      throw new Error(`cmux send failed: ${result.stderr}`);
    }
    this.submit(handle.id);
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

const TMUX_SESSION_PREFIX = "apex-worker";

export interface TmuxClientInfo {
  tty: string;
  session: string;
  windowId: string;
  windowName: string;
}

export interface TmuxHandleInspection {
  session: string;
  windowId: string;
  windowName: string;
  clients: TmuxClientInfo[];
  matchedClients: TmuxClientInfo[];
}

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

  private sanitizeSessionFragment(name: string): string {
    const normalized = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return normalized || "worker";
  }

  private makeDetachedSessionName(name: string): string {
    const suffix = Math.random().toString(36).slice(2, 8);
    return `${TMUX_SESSION_PREFIX}-${this.sanitizeSessionFragment(name)}-${suffix}`;
  }

  private submit(handle: WindowHandle): void {
    const result = run("tmux", ["send-keys", "-t", handle.id, "Enter"]);
    if (!result.ok) {
      throw new Error(`tmux submit failed: ${result.stderr}`);
    }
  }

  /**
   * Open a visible terminal window attached to a worker-dedicated tmux session.
   * Auto-detects the user's terminal emulator on macOS; skips silently on
   * unsupported platforms or unknown terminals.
   */
  private openViewer(sessionName: string): void {
    const attachCmd = `tmux attach -t ${sessionName}`;

    if (process.platform === "darwin") {
      const term = process.env.TERM_PROGRAM ?? "";
      if (term === "iTerm.app") {
        run("osascript", ["-e",
          `tell application "iTerm2"
            create window with default profile command "${attachCmd}"
          end tell`]);
      } else {
        // Terminal.app, Warp, or unknown — Terminal.app as safe default
        run("osascript", ["-e",
          `tell application "Terminal" to do script "${attachCmd}"`]);
      }
    } else if (process.platform === "linux") {
      // Try common Linux terminal emulators
      if (which("x-terminal-emulator")) {
        run("x-terminal-emulator", ["-e", attachCmd]);
      } else if (which("gnome-terminal")) {
        run("gnome-terminal", ["--", "bash", "-c", attachCmd]);
      } else if (which("xterm")) {
        run("xterm", ["-e", attachCmd]);
      }
      // If none found, skip silently — user can attach manually
    }
    // Windows (WSL): use Windows Terminal (wt.exe) if available
    if (process.platform === "linux" && process.env.WSL_DISTRO_NAME) {
      if (which("wt.exe")) {
        run("wt.exe", ["new-tab", "wsl", "--", "tmux", "attach", "-t", sessionName]);
      }
      // If no wt.exe, user can run `tmux attach -t <session>` manually
    }
  }

  async createWindow(name: string, command: string): Promise<WindowHandle> {
    const insideTmux = !!process.env.TMUX;

    let result;
    if (insideTmux) {
      // Inside tmux: split current window — Worker appears as a visible pane
      // next to the Plan Agent. Use -h for horizontal split, -d to not switch focus.
      result = run("tmux", [
        "split-window", "-h", "-d",
        "-P", "-F", "#{pane_id}",
        command,
      ]);
      if (result.ok) {
        // Rebalance all panes evenly after each split
        run("tmux", ["select-layout", "tiled"]);
      }
    } else {
      // Outside tmux: each worker gets its own detached session and viewer.
      const sessionName = this.makeDetachedSessionName(name);
      result = run("tmux", ["new-session", "-d", "-s", sessionName, "-n", name, "-P", "-F", "#{window_id}", command]);
      if (result.ok) {
        this.openViewer(sessionName);
      }
      if (!result.ok) {
        throw new Error(`tmux create session failed: ${result.stderr}`);
      }
      const target = result.stdout;
      return { id: target, name, adapter: "tmux", session: sessionName };
    }

    if (!result.ok) {
      throw new Error(`tmux create pane/window failed: ${result.stderr}`);
    }
    const target = result.stdout;
    const sessionResult = run("tmux", ["display-message", "-p", "-t", target, "#{session_name}"]);
    return {
      id: target,
      name,
      adapter: "tmux",
      session: sessionResult.ok ? sessionResult.stdout : undefined,
    };
  }

  async send(handle: WindowHandle, text: string): Promise<void> {
    const result = run("tmux", ["send-keys", "-t", handle.id, "-l", text]);
    if (!result.ok) {
      throw new Error(`tmux send-keys failed: ${result.stderr}`);
    }
    await sleep(60);
    this.submit(handle);
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
    if (handle.session?.startsWith(TMUX_SESSION_PREFIX)) {
      run("tmux", ["kill-session", "-t", handle.session]);
      return;
    }
    // pane_id starts with %, window_id starts with @
    if (handle.id.startsWith("%")) {
      run("tmux", ["kill-pane", "-t", handle.id]);
    } else {
      run("tmux", ["kill-window", "-t", handle.id]);
    }
  }

  async isAlive(handle: WindowHandle): Promise<boolean> {
    if (handle.id.startsWith("%")) {
      // Pane: list all panes across all sessions
      const result = run("tmux", ["list-panes", "-a", "-F", "#{pane_id}"]);
      if (!result.ok) return false;
      return result.stdout.split("\n").includes(handle.id);
    }
    // Window: list all windows across all sessions
    const result = run("tmux", ["list-windows", "-a", "-F", "#{window_id}"]);
    if (!result.ok) return false;
    return result.stdout.split("\n").includes(handle.id);
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

export function adapterForHandle(handle: WindowHandle | null | undefined): TerminalAdapter {
  if (handle?.adapter === "cmux") {
    return new CmuxAdapter();
  }
  if (handle?.adapter === "tmux") {
    return new TmuxAdapter();
  }
  return detectAdapter();
}

export function inspectTmuxHandle(handle: WindowHandle): TmuxHandleInspection | null {
  if (handle.adapter !== "tmux" || !which("tmux")) {
    return null;
  }

  const target = run("tmux", ["display-message", "-p", "-t", handle.id, "#{session_name}\t#{window_id}\t#{window_name}"]);
  if (!target.ok) {
    return null;
  }

  const [session = "", windowId = "", windowName = ""] = target.stdout.split("\t");
  const clientsResult = run("tmux", ["list-clients", "-F", "#{client_tty}\t#{session_name}\t#{window_id}\t#{window_name}"]);
  const clients: TmuxClientInfo[] = clientsResult.ok
    ? clientsResult.stdout
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => {
          const [tty = "", clientSession = "", clientWindowId = "", clientWindowName = ""] = line.split("\t");
          return {
            tty,
            session: clientSession,
            windowId: clientWindowId,
            windowName: clientWindowName,
          };
        })
    : [];

  const matchedClients = clients.filter((client) => client.session === session && client.windowId === windowId);
  return { session, windowId, windowName, clients, matchedClients };
}

export function detectAdapter(): TerminalAdapter {
  // Priority 1: cmux env vars — any of these means we're inside a cmux session.
  // cmux sets CMUX_PANEL_ID, CMUX_SOCKET, CMUX_WORKSPACE_ID, or CMUX_SURFACE
  // depending on the version and context.
  const inCmux = !!(
    process.env.CMUX_SURFACE ||
    process.env.CMUX_PANEL_ID ||
    process.env.CMUX_SOCKET ||
    process.env.CMUX_WORKSPACE_ID
  );

  if (inCmux) {
    const adapter = new CmuxAdapter();
    if (adapter.available()) {
      return adapter;
    }
    // cmux env vars set but binary not found — warn and fall through
    console.warn("[warn] cmux environment detected but cmux binary not found in PATH or " + CMUX_BIN);
  }

  // Priority 2: cmux binary available AND inside a tmux session (cmux runs atop tmux)
  // Verify socket is actually reachable before committing to cmux.
  if (!inCmux) {
    const cmuxAvail = which("cmux") || run(CMUX_BIN, ["--version"], 5_000).ok;
    if (cmuxAvail && process.env.TMUX) {
      const bin = which("cmux") ? "cmux" : CMUX_BIN;
      const ping = run(bin, ["ping"], 5_000);
      if (ping.ok) {
        return new CmuxAdapter();
      }
      // cmux socket broken — fall through to tmux
    }
  }

  // Priority 3: tmux available
  if (which("tmux")) {
    return new TmuxAdapter();
  }

  throw new Error(
    "apex-manager worker requires tmux or cmux. Install: brew install tmux",
  );
}
