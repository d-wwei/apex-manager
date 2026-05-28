/**
 * Orchestration Daemon — Plan Agent Notification
 *
 * Sends messages to the Plan Agent's terminal when idle, or writes to a
 * file-based notification queue when the Plan Agent is busy or disconnected.
 */

import { existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync, renameSync } from "fs";
import { join } from "path";
import type { WindowHandle, TerminalAdapter } from "../worker/terminal.js";
import { redactSecrets } from "../utils/redact.js";

const NOTIFICATIONS_DIR = ".apex-manager/notifications";

/**
 * Notify the Plan Agent about a daemon event.
 * Tries terminal first; falls back to file queue if Plan Agent is busy/disconnected.
 */
export async function notifyPlanAgent(
  adapter: TerminalAdapter | null,
  planAgentHandle: WindowHandle | null,
  message: string,
): Promise<void> {
  if (adapter && planAgentHandle) {
    try {
      // Check if Plan Agent terminal is idle (showing prompt)
      const screen = await adapter.readScreen(planAgentHandle, 5);
      const isIdle = screen.includes("❯") && !screen.includes("esc to interrupt");

      if (isIdle) {
        await adapter.send(planAgentHandle, `[DAEMON] ${redactSecrets(message)}`);
        return;
      }
    } catch {
      // Terminal read/send failed — fall through to file queue
    }
  }

  // Fall back to file-based notification queue
  appendNotification(message);
}

/**
 * Write a notification to the file queue.
 * Plan Agent reads these when it reconnects or checks for pending notifications.
 */
export function appendNotification(message: string): void {
  mkdirSync(NOTIFICATIONS_DIR, { recursive: true });

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const seq = String(readdirSync(NOTIFICATIONS_DIR).length + 1).padStart(3, "0");
  const filename = `${seq}-${ts}.json`;

  writeFileSync(join(NOTIFICATIONS_DIR, filename), JSON.stringify({
    message: redactSecrets(message),
    created_at: new Date().toISOString(),
    read: false,
  }, null, 2));
}

/**
 * Read and consume all pending notifications.
 * Returns notifications in chronological order, marks them as processed.
 */
export function readPendingNotifications(): Array<{ message: string; created_at: string }> {
  if (!existsSync(NOTIFICATIONS_DIR)) return [];

  const files = readdirSync(NOTIFICATIONS_DIR)
    .filter(f => f.endsWith(".json") && !f.includes(".processed."))
    .sort();

  const notifications: Array<{ message: string; created_at: string }> = [];

  for (const file of files) {
    const filePath = join(NOTIFICATIONS_DIR, file);
    try {
      const data = JSON.parse(readFileSync(filePath, "utf-8"));
      notifications.push({ message: data.message, created_at: data.created_at });

      // Rename to mark as processed
      const processedPath = filePath.replace(".json", ".processed.json");
      renameSync(filePath, processedPath);
    } catch {
      // Skip malformed files
    }
  }

  return notifications;
}
