import { ackMessage, getMessage, listMessages, sendStructuredMessage } from "../worker/messages.js";
import type { MessageRecord } from "../types/message.js";
import { redactSecrets } from "../utils/redact.js";

function flagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : undefined;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function formatMessage(message: MessageRecord): string {
  return [
    `${message.id}  ${message.kind}  ${message.delivery_status}  ${message.from} -> ${message.to}`,
    `  priority: ${message.priority}  ack: ${message.ack_required ? "required" : "none"}`,
    `  body: ${redactSecrets(message.body)}`,
  ].join("\n");
}

async function cmdSend(args: string[]): Promise<void> {
  const to = flagValue(args, "--to") ?? args[0];
  const from = flagValue(args, "--from") ?? "manager";
  const kind = flagValue(args, "--kind") ?? "directive";
  const taskId = flagValue(args, "--task") ?? to;
  const priority = (flagValue(args, "--priority") as "normal" | "urgent" | undefined) ?? "normal";
  const body = flagValue(args, "--body")
    ?? args.slice(1).filter((arg) => !arg.startsWith("--")).join(" ");
  const directiveAction = (flagValue(args, "--action") as "amend" | "pause" | "abort" | "info" | undefined)
    ?? (kind === "question" ? "info" : "amend");
  const ackRequired = !hasFlag(args, "--no-ack");
  const waitForAck = hasFlag(args, "--wait-ack");

  if (!to || !body) {
    console.error("Usage: apex-manager msg send <to> <body> [--from <sender>] [--kind <directive|question|info>] [--task <task-id>] [--priority <normal|urgent>] [--action <amend|pause|abort|info>] [--no-ack] [--wait-ack]");
    console.error("   or: apex-manager msg send --from <sender> --to <target> --kind <kind> --body <text>");
    process.exit(1);
  }

  const message = await sendStructuredMessage({
    from,
    to,
    taskId,
    kind,
    priority,
    ackRequired,
    body,
    directiveAction,
    waitForAck,
  });

  console.log(`${message.id} ${message.delivery_status} for ${message.to}`);
}

async function cmdList(args: string[]): Promise<void> {
  const to = flagValue(args, "--to");
  const status = flagValue(args, "--status") as MessageRecord["delivery_status"] | undefined;
  const messages = await listMessages({ to, status });

  if (messages.length === 0) {
    console.log("No messages.");
    return;
  }

  for (const message of messages) {
    console.log(formatMessage(message));
  }
}

async function cmdShow(args: string[]): Promise<void> {
  const messageId = args[0];
  if (!messageId) {
    console.error("Usage: apex-manager msg show <message-id>");
    process.exit(1);
  }

  const message = await getMessage(messageId);
  console.log(formatMessage(message));
  console.log(`  created_at: ${message.created_at}`);
  if (message.delivered_at) console.log(`  delivered_at: ${message.delivered_at}`);
  if (message.acknowledged_at) console.log(`  acknowledged_at: ${message.acknowledged_at}`);
  if (message.acknowledged_by) console.log(`  acknowledged_by: ${message.acknowledged_by}`);
}

async function cmdAck(args: string[]): Promise<void> {
  const messageId = args[0];
  const by = flagValue(args, "--by") ?? "manual";

  if (!messageId) {
    console.error("Usage: apex-manager msg ack <message-id> [--by <worker-id>]");
    process.exit(1);
  }

  const message = await ackMessage(messageId, by);
  console.log(`${message.id} acked by ${by}`);
}

function printHelp(): void {
  console.log(`
apex-manager msg — generic team message commands

Usage:
  apex-manager msg send <to> <body> [--from <sender>] [--kind <directive|question|info>] [--task <task-id>] [--priority <normal|urgent>] [--action <amend|pause|abort|info>] [--no-ack] [--wait-ack]
  apex-manager msg send --from <sender> --to <target> --kind <kind> --body <text>
  apex-manager msg list [--to <task-id>] [--status <pending|delivered|acked|ack_timeout|failed>]
  apex-manager msg show <message-id>
  apex-manager msg ack <message-id> [--by <worker-id>]
`);
}

export async function cmdMsg(args: string[]): Promise<void> {
  const verb = args[0];

  switch (verb) {
    case "send":
      await cmdSend(args.slice(1));
      break;
    case "list":
      await cmdList(args.slice(1));
      break;
    case "show":
      await cmdShow(args.slice(1));
      break;
    case "ack":
      await cmdAck(args.slice(1));
      break;
    case "--help":
    case "help":
      printHelp();
      break;
    default:
      if (!verb) {
        printHelp();
      } else {
        console.error(`Unknown msg subcommand: ${verb}`);
        printHelp();
        process.exit(1);
      }
      break;
  }
}
