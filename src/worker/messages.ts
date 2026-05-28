import { existsSync, readFileSync, writeFileSync } from "fs";
import { readJSON, updateJSON } from "../utils/json.js";
import { apexPath, DEFAULT_MESSAGE_STORE, ensureProjectLayout } from "../utils/project-state.js";
import { recordKernelEvent } from "../utils/events.js";
import type { MessageRecord, MessageStore } from "../types/message.js";
import type { WorkerMeta } from "./monitor.js";
import type { TerminalAdapter, WindowHandle } from "./terminal.js";
import { adapterForHandle, detectAdapter } from "./terminal.js";
import { loadAgentsConfig } from "./agent-adapter.js";
import { interruptKeys } from "./interrupt.js";
import { isWorkerIdleScreen, waitForWorkerIdle } from "./idle.js";
import { redactSecrets } from "../utils/redact.js";

export interface SendStructuredMessageOptions {
  from: string;
  to: string;
  taskId?: string;
  kind: string;
  priority?: "normal" | "urgent";
  ackRequired?: boolean;
  body: string;
  directiveAction?: "amend" | "pause" | "abort" | "info";
  waitForAck?: boolean;
  ackTimeoutMs?: number;
  idleWaitTimeoutMs?: number;
  idlePollIntervalMs?: number;
  adapter?: TerminalAdapter;
}

export interface ProcessMessageQueueResult {
  delivered: number;
  acked: number;
  timedOut: number;
  failed: number;
}

function messageStorePath(): string {
  return apexPath("messages", "index.json");
}

function workerMetaPath(taskId: string): string {
  return apexPath("workers", taskId, "meta.json");
}

function workerDirectivePath(taskId: string): string {
  return apexPath("workers", taskId, "directive.json");
}

async function loadMessageStore(): Promise<MessageStore> {
  ensureProjectLayout();
  return readJSON<MessageStore>(messageStorePath(), DEFAULT_MESSAGE_STORE);
}

async function updateMessageStore<R>(
  updater: (store: MessageStore) => Promise<R> | R,
): Promise<R> {
  ensureProjectLayout();
  return updateJSON<MessageStore, R>(
    messageStorePath(),
    DEFAULT_MESSAGE_STORE,
    async (store) => {
      const result = await updater(store);
      return { data: store, result };
    },
  );
}

function loadWorkerMeta(taskId: string): WorkerMeta | null {
  const path = workerMetaPath(taskId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as WorkerMeta;
  } catch {
    return null;
  }
}

function writeDirective(
  taskId: string,
  action: "amend" | "pause" | "abort" | "info",
  body: string,
  priority: "normal" | "urgent",
): void {
  writeFileSync(workerDirectivePath(taskId), JSON.stringify({
    from: "plan-agent",
    created_at: new Date().toISOString(),
    action,
    content: {
      description: body,
      urgency: priority === "urgent" ? "high" : "normal",
    },
  }, null, 2));
}

function cloneMessage(message: MessageRecord): MessageRecord {
  return JSON.parse(JSON.stringify(message)) as MessageRecord;
}

async function updateStoredMessage(
  messageId: string,
  updater: (message: MessageRecord) => Promise<void> | void,
): Promise<MessageRecord> {
  return updateMessageStore(async (store) => {
    const message = requireMessage(store, messageId);
    await updater(message);
    return cloneMessage(message);
  });
}

async function recordMessageEvent(
  type: string,
  message: MessageRecord,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await recordKernelEvent({
    type,
    timestamp: new Date().toISOString(),
    message: { ...cloneMessage(message), body: redactSecrets(message.body) },
    ...extra,
  });
}

function findMessage(store: MessageStore, messageId: string): MessageRecord | undefined {
  return store.messages.find((entry) => entry.id === messageId);
}

function requireMessage(store: MessageStore, messageId: string): MessageRecord {
  const message = findMessage(store, messageId);
  if (!message) {
    throw new Error(`Message ${messageId} not found`);
  }
  return message;
}

export function renderMessageEnvelope(message: MessageRecord): string {
  const prefix = message.priority === "urgent" ? "[PLAN-AGENT:INTERRUPT]" : "[PLAN-AGENT]";
  const ackBlock = message.ack_required
    ? `\n\nAfter receiving this message, reply exactly:\nACK ${message.id}`
    : "";

  return `${prefix}
[APEX-MSG id=${message.id} from=${message.from} to=${message.to} kind=${message.kind} priority=${message.priority} ack=${message.ack_required ? "required" : "none"}]
${message.body}${ackBlock}
[/APEX-MSG]`;
}

function messageAckSeen(screen: string, messageId: string): boolean {
  return screen.includes(`ACK ${messageId}`);
}

async function waitForAck(
  adapter: TerminalAdapter,
  handle: WindowHandle,
  messageId: string,
  timeoutMs: number,
): Promise<boolean> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const screen = await adapter.readScreen(handle, 20);
    if (messageAckSeen(screen, messageId)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return false;
}

async function markDelivered(messageId: string): Promise<MessageRecord> {
  const delivered = await updateStoredMessage(messageId, (message) => {
    const now = new Date().toISOString();
    message.delivery_status = "delivered";
    message.delivered_at = now;
    message.last_delivery_attempt_at = now;
    message.delivery_attempts = (message.delivery_attempts ?? 0) + 1;
    message.last_error = undefined;
  });
  await recordMessageEvent("message.delivered", delivered, {
    to: delivered.to,
    transport: "terminal",
  });
  return delivered;
}

async function markAcked(messageId: string, by: string): Promise<MessageRecord> {
  const acked = await updateStoredMessage(messageId, (message) => {
    message.delivery_status = "acked";
    message.acknowledged_at = new Date().toISOString();
    message.acknowledged_by = by;
  });
  await recordMessageEvent("message.acknowledged", acked, {
    by,
  });
  return acked;
}

async function markAckTimeout(messageId: string): Promise<MessageRecord> {
  const timedOut = await updateStoredMessage(messageId, (message) => {
    message.delivery_status = "ack_timeout";
  });
  await recordMessageEvent("message.ack_timeout", timedOut, {
    by: timedOut.to,
  });
  return timedOut;
}

async function markFailed(messageId: string, error: unknown): Promise<MessageRecord> {
  const failed = await updateStoredMessage(messageId, (message) => {
    message.delivery_status = "failed";
    message.last_error = String(error);
    message.last_delivery_attempt_at = new Date().toISOString();
    message.delivery_attempts = (message.delivery_attempts ?? 0) + 1;
  });
  await recordMessageEvent("message.failed", failed, {
    to: failed.to,
    transport: "terminal",
    error: String(error),
  });
  return failed;
}

async function maybeInterruptWorker(
  adapter: TerminalAdapter,
  meta: WorkerMeta,
  handle: WindowHandle,
  idleWaitTimeoutMs: number,
  idlePollIntervalMs: number,
): Promise<boolean> {
  const adapterName = adapter.name() as "cmux" | "tmux";
  const agentsCfg = loadAgentsConfig();
  const interruptType = agentsCfg[meta.agent]?.interrupt ?? "esc";
  const keys = interruptKeys(interruptType, adapterName);

  for (const key of keys) {
    await adapter.sendKey(handle, key);
  }

  return waitForWorkerIdle(adapter, handle, meta.agent, idleWaitTimeoutMs, idlePollIntervalMs);
}

async function attemptDelivery(
  message: MessageRecord,
  meta: WorkerMeta,
  adapter: TerminalAdapter,
  options: {
    waitForAck?: boolean;
    idleWaitTimeoutMs?: number;
    idlePollIntervalMs?: number;
  } = {},
): Promise<MessageRecord> {
  if (!meta.window_handle) {
    throw new Error(`Worker ${message.to} has no terminal handle`);
  }

  const handle = meta.window_handle as WindowHandle;
  const screen = await adapter.readScreen(handle, 20);
  let idle = isWorkerIdleScreen(screen, meta.agent);

  if (!idle && message.priority === "urgent") {
    idle = await maybeInterruptWorker(
      adapter,
      meta,
      handle,
      options.idleWaitTimeoutMs ?? 5_000,
      options.idlePollIntervalMs ?? 500,
    );
  }

  if (!idle) {
    if (message.priority === "urgent") {
      message = await updateStoredMessage(message.id, (storedMessage) => {
        storedMessage.last_error = "worker remained busy after interrupt";
      });
    }
    return message;
  }

  await adapter.send(handle, renderMessageEnvelope(message));
  message = await markDelivered(message.id);

  if (options.waitForAck && message.ack_required) {
    const acked = await waitForAck(adapter, handle, message.id, message.ack_timeout_ms ?? 30_000);
    if (acked) {
      message = await markAcked(message.id, message.to);
    } else {
      message = await markAckTimeout(message.id);
    }
  }

  return message;
}

async function reconcileDeliveredMessageAck(
  message: MessageRecord,
  adapter: TerminalAdapter,
  now = new Date(),
): Promise<MessageRecord> {
  const meta = loadWorkerMeta(message.to);
  if (!meta?.window_handle) {
    return message;
  }

  const screen = await adapter.readScreen(meta.window_handle as WindowHandle, 20);
  if (messageAckSeen(screen, message.id)) {
    return markAcked(message.id, message.to);
  }

  const ackTimeoutMs = message.ack_timeout_ms ?? 30_000;
  const deliveredAt = new Date(message.delivered_at ?? message.created_at).getTime();
  if (now.getTime() - deliveredAt >= ackTimeoutMs) {
    return markAckTimeout(message.id);
  }

  return message;
}

export async function listMessages(filters: {
  to?: string;
  status?: MessageRecord["delivery_status"];
} = {}): Promise<MessageRecord[]> {
  const store = await loadMessageStore();
  return store.messages.filter((message) => {
    if (filters.to && message.to !== filters.to) return false;
    if (filters.status && message.delivery_status !== filters.status) return false;
    return true;
  });
}

export async function getMessage(messageId: string): Promise<MessageRecord> {
  const store = await loadMessageStore();
  return requireMessage(store, messageId);
}

export async function ackMessage(messageId: string, by: string): Promise<MessageRecord> {
  return markAcked(messageId, by);
}

export async function processMessageQueueOnce(
  options: {
    adapter?: TerminalAdapter;
    now?: Date;
    idleWaitTimeoutMs?: number;
    idlePollIntervalMs?: number;
  } = {},
): Promise<ProcessMessageQueueResult> {
  const fallbackAdapter = options.adapter;
  const store = await loadMessageStore();
  const before = new Map(store.messages.map((message) => [message.id, message.delivery_status]));

  for (const message of store.messages) {
    if (message.delivery_status === "pending") {
      const meta = loadWorkerMeta(message.to);
      if (!meta) {
        continue;
      }
      try {
        const adapter = fallbackAdapter
          ?? (meta.window_handle
            ? adapterForHandle(meta.window_handle as WindowHandle)
            : detectAdapter());
        await attemptDelivery(message, meta, adapter, {
          idleWaitTimeoutMs: options.idleWaitTimeoutMs,
          idlePollIntervalMs: options.idlePollIntervalMs,
        });
      } catch (error) {
        await markFailed(message.id, error);
      }
    } else if (message.delivery_status === "delivered" && message.ack_required) {
      try {
        const meta = loadWorkerMeta(message.to);
        if (!meta?.window_handle) {
          continue;
        }
        const adapter = fallbackAdapter ?? adapterForHandle(meta.window_handle as WindowHandle);
        await reconcileDeliveredMessageAck(message, adapter, options.now ?? new Date());
      } catch {
        // Ignore read failures; daemon will retry on the next tick.
      }
    }
  }

  const afterStore = await loadMessageStore();
  const after = new Map(afterStore.messages.map((message) => [message.id, message.delivery_status]));
  let delivered = 0;
  let acked = 0;
  let timedOut = 0;
  let failed = 0;

  for (const [id, status] of after.entries()) {
    const previous = before.get(id);
    if (previous === status) continue;
    if (status === "delivered") delivered += 1;
    if (status === "acked") acked += 1;
    if (status === "ack_timeout") timedOut += 1;
    if (status === "failed") failed += 1;
  }

  return { delivered, acked, timedOut, failed };
}

export async function sendStructuredMessage(
  options: SendStructuredMessageOptions,
): Promise<MessageRecord> {
  ensureProjectLayout();

  const meta = loadWorkerMeta(options.to);
  if (!meta) {
    throw new Error(`Worker ${options.to} not found`);
  }
  if (!meta.window_handle) {
    throw new Error(`Worker ${options.to} has no terminal handle`);
  }

  const message = await updateMessageStore((store) => {
    const created: MessageRecord = {
      id: `MSG-${store.next_id}`,
      from: options.from,
      to: options.to,
      task_id: options.taskId,
      kind: options.kind,
      priority: options.priority ?? "normal",
      ack_required: options.ackRequired ?? true,
      ack_timeout_ms: options.ackRequired === false ? undefined : (options.ackTimeoutMs ?? 30_000),
      body: options.body,
      directive_action: options.directiveAction,
      delivery_status: "pending",
      delivery_attempts: 0,
      created_at: new Date().toISOString(),
    };

    store.messages.push(created);
    store.next_id += 1;
    return cloneMessage(created);
  });

  await recordMessageEvent("message.created", message, {
    from: message.from,
    to: message.to,
    kind: message.kind,
    priority: message.priority,
  });

  if (message.directive_action) {
    writeDirective(options.to, message.directive_action, message.body, message.priority);
  }

  const adapter = options.adapter ?? adapterForHandle(meta.window_handle as WindowHandle);

  try {
    return await attemptDelivery(message, meta, adapter, {
      waitForAck: options.waitForAck,
      idleWaitTimeoutMs: options.idleWaitTimeoutMs,
      idlePollIntervalMs: options.idlePollIntervalMs,
    });
  } catch (error) {
    await markFailed(message.id, error);
    throw error;
  }
}
