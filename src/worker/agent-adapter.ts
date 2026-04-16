/**
 * Agent adapter — config-driven agent registry.
 *
 * Agents are defined in .apex-manager/agents.json.  Only "claude" has a
 * built-in fallback for zero-config usage; all other agents (codex,
 * gemini, ft-claude, custom tools) must be declared in agents.json.
 */

import { existsSync, readFileSync } from "fs";
import type { AgentEntry, AgentsMap } from "../types/config.js";

// ── Env forwarding helper ───────────────────────────────────────────

/**
 * Explicit env var names to forward, plus prefix patterns (ending with *)
 * that match any env var starting with that prefix.
 */
const AUTH_ENV_ENTRIES: string[] = [
  // Anthropic / Claude — wildcard covers AUTH_TOKEN, BASE_URL, DEFAULT_*_MODEL, etc.
  "ANTHROPIC_*",
  "CLAUDE_API_KEY",
  // Other AI agents
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "OPENROUTER_API_KEY",
  // Proxy
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
];

export function buildEnvPrefix(skip?: string[]): string {
  const skipSet = new Set(skip ?? []);

  // Expand wildcard entries against actual env vars
  const keys = new Set<string>();
  for (const entry of AUTH_ENV_ENTRIES) {
    if (entry.endsWith("*")) {
      const prefix = entry.slice(0, -1);
      for (const envKey of Object.keys(process.env)) {
        if (envKey.startsWith(prefix)) keys.add(envKey);
      }
    } else {
      keys.add(entry);
    }
  }

  const parts: string[] = [];
  for (const key of keys) {
    if (skipSet.has(key)) continue;
    const val = process.env[key];
    if (val) {
      const escaped = val.replace(/'/g, "'\\''");
      parts.push(`${key}='${escaped}'`);
    }
  }
  return parts.length > 0 ? parts.join(" ") + " " : "";
}

// ── Supporting types ─────────────────────────────────────────────────

export type ProtocolInjectionMethod =
  | { type: "system-prompt-file"; flag: string }
  | { type: "cli-argument"; flag: string }
  | { type: "stdin" }
  | { type: "env-var"; name: string }
  | { type: "none" };

export interface AgentCapabilities {
  canExecuteBash: boolean;
  canWriteFiles: boolean;
  canReadFiles: boolean;
  canRunApexCLI: boolean;
  preferredLanguage: "zh" | "en";
  maxPromptBytes: number;
  autoApprovalFlag?: string;
}

export interface StartOpts {
  worktreePath: string;
  protocolPath: string;
  model?: string;
}

// ── AgentAdapter interface ───────────────────────────────────────────

export interface AgentAdapter {
  name: string;
  binary: string;
  buildStartCommand(opts: StartOpts): string;
  protocolInjection: ProtocolInjectionMethod;
  capabilities: AgentCapabilities;
  interruptKeys: string[];
  skipProxyEnv: boolean;
  executionMode: "persistent" | "one-shot";
  needsPostCreateSend: boolean;
}

// ── Interrupt key mapping ───────────────────────────────────────────

type AdapterName = "cmux" | "tmux";

const KEY_MAP: Record<string, Record<AdapterName, string>> = {
  esc:   { cmux: "escape", tmux: "Escape" },
  ctrlc: { cmux: "ctrl-c", tmux: "C-c" },
};

function resolveInterruptKeys(interrupt: "esc" | "ctrlc", adapter: AdapterName = "tmux"): string[] {
  const keys = interrupt === "esc" ? ["esc"] : ["ctrlc"];
  return keys.map(k => KEY_MAP[k]?.[adapter] ?? k);
}

// ── Agents config ───────────────────────────────────────────────────

const AGENTS_JSON_PATH = ".apex-manager/agents.json";

/**
 * Load agents.json from the project directory.
 * Returns empty map if file does not exist.
 */
export function loadAgentsConfig(): AgentsMap {
  if (!existsSync(AGENTS_JSON_PATH)) return {};
  try {
    const raw = readFileSync(AGENTS_JSON_PATH, "utf-8");
    return JSON.parse(raw) as AgentsMap;
  } catch {
    return {};
  }
}

/**
 * Default AgentEntry values for fields not specified by the user.
 */
const ENTRY_DEFAULTS: Required<Omit<AgentEntry, "command">> = {
  args: [],
  protocol: "post-create-send",
  protocol_flag: "--append-system-prompt-file",
  interrupt: "ctrlc",
  language: "en",
  env_forward: false,
  skip_proxy_env: false,
  execution_mode: "persistent",
  auto_approval_flag: "",
};

/**
 * The claude fallback entry — used when no agents.json exists or when
 * "claude" is requested but not explicitly defined in config.
 */
const CLAUDE_FALLBACK_ENTRY: AgentEntry = {
  command: "claude",
  args: [],
  protocol: "system-prompt-file",
  protocol_flag: "--append-system-prompt-file",
  interrupt: "esc",
  language: "zh",
  env_forward: true,
  skip_proxy_env: false,
  execution_mode: "persistent",
  auto_approval_flag: "--dangerously-skip-permissions",
};

// ── Build adapter from config entry ─────────────────────────────────

/**
 * Construct a full AgentAdapter from a name + AgentEntry.
 */
export function buildAdapterFromEntry(name: string, entry: AgentEntry): AgentAdapter {
  const protocol = entry.protocol ?? ENTRY_DEFAULTS.protocol;
  const protocolFlag = entry.protocol_flag ?? ENTRY_DEFAULTS.protocol_flag;
  const interrupt = entry.interrupt ?? ENTRY_DEFAULTS.interrupt;
  const language = entry.language ?? ENTRY_DEFAULTS.language;
  const envForward = entry.env_forward ?? ENTRY_DEFAULTS.env_forward;
  const skipProxy = entry.skip_proxy_env ?? ENTRY_DEFAULTS.skip_proxy_env;
  const execMode = entry.execution_mode ?? ENTRY_DEFAULTS.execution_mode;
  const autoApproval = entry.auto_approval_flag ?? ENTRY_DEFAULTS.auto_approval_flag;
  const args = entry.args ?? [];

  let protocolInjection: ProtocolInjectionMethod;
  let needsPostCreateSend = false;

  switch (protocol) {
    case "system-prompt-file":
      protocolInjection = { type: "system-prompt-file", flag: protocolFlag };
      break;
    case "post-create-send":
      protocolInjection = { type: "none" };
      needsPostCreateSend = true;
      break;
    default:
      protocolInjection = { type: "none" };
      break;
  }

  return {
    name,
    binary: entry.command,
    protocolInjection,
    interruptKeys: resolveInterruptKeys(interrupt, "tmux"),
    skipProxyEnv: skipProxy,
    executionMode: execMode,
    needsPostCreateSend,
    capabilities: {
      canExecuteBash: true,
      canWriteFiles: true,
      canReadFiles: true,
      canRunApexCLI: true,
      preferredLanguage: language,
      maxPromptBytes: protocol === "system-prompt-file" ? 1_000_000 : 200_000,
      autoApprovalFlag: autoApproval || undefined,
    },
    buildStartCommand(opts: StartOpts): string {
      const model = opts.model ? ` --model "${opts.model}"` : "";
      const env = envForward ? buildEnvPrefix(skipProxy ? ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"] : []) : "";
      const argsStr = args.length > 0 ? " " + args.join(" ") : "";
      const approvalStr = autoApproval ? ` ${autoApproval}` : "";

      if (protocol === "system-prompt-file") {
        return `cd "${opts.worktreePath}" && ${env}${entry.command}${model}${argsStr} ${protocolFlag} "${opts.protocolPath}"${approvalStr}`;
      }
      // post-create-send or none: just start the agent
      return `cd "${opts.worktreePath}" && ${env}${entry.command}${model}${argsStr}${approvalStr}`;
    },
  };
}

// ── Resolver ────────────────────────────────────────────────────────

/**
 * Resolve an agent adapter.
 *
 * Priority: agents.json > claude fallback > error.
 */
export function resolveAdapterWithConfig(
  agent: string,
  configAgents: AgentsMap | undefined,
): AgentAdapter {
  const entry = configAgents?.[agent];

  // Case 1: found in config
  if (entry) {
    return buildAdapterFromEntry(agent, entry);
  }

  // Case 2: "claude" requested but not in config — use built-in fallback
  if (agent === "claude") {
    return buildAdapterFromEntry("claude", CLAUDE_FALLBACK_ENTRY);
  }

  // Case 3: unknown agent
  const available = configAgents ? Object.keys(configAgents) : [];
  if (!available.includes("claude")) available.push("claude");
  throw new Error(
    `Unknown agent "${agent}". Define it in .apex-manager/agents.json. Available: ${available.join(", ")}`,
  );
}

/**
 * Convenience: resolve using agents.json from disk.
 */
export function resolveAdapter(agent: string): AgentAdapter {
  return resolveAdapterWithConfig(agent, loadAgentsConfig());
}

// ── Backward compat exports ─────────────────────────────────────────

/**
 * @deprecated Use loadAgentsConfig() + resolveAdapterWithConfig() instead.
 * Kept for callers that reference BUILTIN_ADAPTERS directly.
 * Returns only the claude fallback.
 */
export const BUILTIN_ADAPTERS: Record<string, AgentAdapter> = {
  claude: buildAdapterFromEntry("claude", CLAUDE_FALLBACK_ENTRY),
};

/**
 * Default agent entries for `apex-manager init` to write to agents.json.
 */
export const DEFAULT_AGENTS: AgentsMap = {
  claude: {
    command: "claude",
    protocol: "system-prompt-file",
    protocol_flag: "--append-system-prompt-file",
    interrupt: "esc",
    language: "zh",
    env_forward: true,
    auto_approval_flag: "--dangerously-skip-permissions",
  },
  codex: {
    command: "codex",
    protocol: "post-create-send",
    interrupt: "ctrlc",
    language: "en",
    auto_approval_flag: "--full-auto",
  },
  gemini: {
    command: "gemini",
    protocol: "post-create-send",
    interrupt: "ctrlc",
    language: "en",
    auto_approval_flag: "--yolo",
  },
  opencode: {
    command: "opencode",
    protocol: "post-create-send",
    interrupt: "ctrlc",
    language: "en",
  },
};
