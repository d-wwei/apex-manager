import type { TerminalAdapter, WindowHandle } from "./terminal.js";

function normalizeScreen(screen: string): string {
  return screen.toLowerCase();
}

export function isWorkerIdleScreen(screen: string, agent: string): boolean {
  const normalized = normalizeScreen(screen);

  if (agent === "claude" || agent === "ft-claude") {
    return screen.includes("❯") && !normalized.includes("esc to interrupt");
  }

  if (agent === "codex" || agent === "gemini" || agent === "opencode") {
    const hasPrompt = screen.includes("$") || screen.includes("❯") || screen.includes(">");
    const busyHints = [
      "esc to interrupt",
      "running",
      "thinking",
      "applying patch",
      "executing",
    ];
    return hasPrompt && !busyHints.some((hint) => normalized.includes(hint));
  }

  return screen.includes("$") || screen.includes("❯");
}

export async function waitForWorkerIdle(
  adapter: TerminalAdapter,
  handle: WindowHandle,
  agent: string,
  timeoutMs = 5_000,
  pollIntervalMs = 500,
): Promise<boolean> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const screen = await adapter.readScreen(handle, 20);
    if (isWorkerIdleScreen(screen, agent)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  return false;
}
