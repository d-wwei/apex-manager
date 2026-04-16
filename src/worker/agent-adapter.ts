/**
 * Agent adapter interface and built-in adapter registry.
 *
 * Each adapter describes how to start and interact with a specific AI
 * agent CLI (claude, codex, gemini, opencode, or custom agents defined
 * in config).  The registry centralises agent-specific knowledge that
 * was previously scattered across protocol-template.ts, interrupt.ts,
 * and cross-model.ts.
 */

import type { AdaptersMap } from "../types/config.js";
import { interruptKeys as getInterruptKeys } from "./interrupt.js";

// ── Env forwarding helper ───────────────────────────────────────────

/**
 * Collect auth-related env vars from the current process and return a
 * shell-safe prefix string like `VAR1=val VAR2=val2 `.
 * Only includes vars that exist.  Returns empty string when nothing to forward.
 */
const AUTH_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "OPENROUTER_API_KEY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
];

export function buildEnvPrefix(skip?: string[]): string {
  const skipSet = new Set(skip ?? []);
  const parts: string[] = [];
  for (const key of AUTH_ENV_KEYS) {
    if (skipSet.has(key)) continue;
    const val = process.env[key];
    if (val) {
      // Shell-safe: single-quote the value, escaping any embedded single quotes
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
  /** Canonical agent name (e.g. "claude", "codex"). */
  name: string;
  /** Binary or command to invoke (e.g. "claude", "codex"). */
  binary: string;
  /** Build the full shell command string to start the agent. */
  buildStartCommand(opts: StartOpts): string;
  /** How the protocol file is injected into the agent. */
  protocolInjection: ProtocolInjectionMethod;
  /** Agent's known capabilities. */
  capabilities: AgentCapabilities;
  /** Raw key names for terminal sendKey (e.g. ["Escape"], ["C-c"]). */
  interruptKeys: string[];
  /** If true, skip injecting HTTP_PROXY / HTTPS_PROXY env vars. */
  skipProxyEnv: boolean;
  /** Whether the agent runs persistently (interactive) or exits after one execution. */
  executionMode: "persistent" | "one-shot";
  /**
   * If true, the protocol is injected by sending a terminal message AFTER
   * window creation, telling the agent to read the protocol file.
   * This is used for agents that don't support system-prompt-file or stdin pipe
   * in interactive mode.
   */
  needsPostCreateSend: boolean;
}

// ── Built-in adapters ────────────────────────────────────────────────

const claudeAdapter: AgentAdapter = {
  name: "claude",
  binary: "claude",
  protocolInjection: { type: "system-prompt-file", flag: "--append-system-prompt-file" },
  interruptKeys: getInterruptKeys("claude", "tmux"),
  skipProxyEnv: false,
  executionMode: "persistent",
  needsPostCreateSend: false,
  capabilities: {
    canExecuteBash: true,
    canWriteFiles: true,
    canReadFiles: true,
    canRunApexCLI: true,
    preferredLanguage: "zh",
    maxPromptBytes: 1_000_000,
    autoApprovalFlag: "--dangerously-skip-permissions",
  },
  buildStartCommand(opts: StartOpts): string {
    const model = opts.model ? ` --model "${opts.model}"` : "";
    const env = buildEnvPrefix();
    return `cd "${opts.worktreePath}" && ${env}claude${model} --append-system-prompt-file "${opts.protocolPath}"`;
  },
};

const codexAdapter: AgentAdapter = {
  name: "codex",
  binary: "codex",
  protocolInjection: { type: "stdin" },
  interruptKeys: getInterruptKeys("codex", "tmux"),
  skipProxyEnv: true,
  executionMode: "persistent",
  needsPostCreateSend: true,
  capabilities: {
    canExecuteBash: true,
    canWriteFiles: true,
    canReadFiles: true,
    canRunApexCLI: true,
    preferredLanguage: "en",
    maxPromptBytes: 200_000,
    autoApprovalFlag: "--full-auto",
  },
  buildStartCommand(opts: StartOpts): string {
    const model = opts.model ? ` --model "${opts.model}"` : "";
    return `cd "${opts.worktreePath}" && codex${model} --full-auto`;
  },
};

const geminiAdapter: AgentAdapter = {
  name: "gemini",
  binary: "gemini",
  protocolInjection: { type: "stdin" },
  interruptKeys: getInterruptKeys("gemini", "tmux"),
  skipProxyEnv: true,
  executionMode: "persistent",
  needsPostCreateSend: true,
  capabilities: {
    canExecuteBash: true,
    canWriteFiles: true,
    canReadFiles: true,
    canRunApexCLI: true,
    preferredLanguage: "en",
    maxPromptBytes: 200_000,
    autoApprovalFlag: "--yolo",
  },
  buildStartCommand(opts: StartOpts): string {
    const model = opts.model ? ` --model "${opts.model}"` : "";
    return `cd "${opts.worktreePath}" && gemini${model} --yolo`;
  },
};

const opencodeAdapter: AgentAdapter = {
  name: "opencode",
  binary: "opencode",
  protocolInjection: { type: "stdin" },
  interruptKeys: getInterruptKeys("opencode", "tmux"),
  skipProxyEnv: true,
  executionMode: "persistent",
  needsPostCreateSend: true,
  capabilities: {
    canExecuteBash: true,
    canWriteFiles: true,
    canReadFiles: true,
    canRunApexCLI: true,
    preferredLanguage: "en",
    maxPromptBytes: 200_000,
  },
  buildStartCommand(opts: StartOpts): string {
    const model = opts.model ? ` --model "${opts.model}"` : "";
    return `cd "${opts.worktreePath}" && opencode${model}`;
  },
};

const ftClaudeAdapter: AgentAdapter = {
  name: "ft-claude",
  binary: "ft-claude",
  protocolInjection: { type: "system-prompt-file", flag: "--append-system-prompt-file" },
  interruptKeys: getInterruptKeys("claude", "tmux"),
  skipProxyEnv: false,
  executionMode: "persistent",
  needsPostCreateSend: false,
  capabilities: {
    canExecuteBash: true,
    canWriteFiles: true,
    canReadFiles: true,
    canRunApexCLI: true,
    preferredLanguage: "zh",
    maxPromptBytes: 1_000_000,
    autoApprovalFlag: "--dangerously-skip-permissions",
  },
  buildStartCommand(opts: StartOpts): string {
    const model = opts.model ? ` --model "${opts.model}"` : "";
    const env = buildEnvPrefix();
    return `cd "${opts.worktreePath}" && ${env}ft-claude${model} --append-system-prompt-file "${opts.protocolPath}"`;
  },
};

export const BUILTIN_ADAPTERS: Record<string, AgentAdapter> = {
  claude: claudeAdapter,
  "ft-claude": ftClaudeAdapter,
  codex: codexAdapter,
  gemini: geminiAdapter,
  opencode: opencodeAdapter,
};

// ── Default adapter for unknown custom agents ────────────────────────

function makeDefaultAdapter(name: string, command: string, args: string[]): AgentAdapter {
  return {
    name,
    binary: command,
    protocolInjection: { type: "none" },
    interruptKeys: getInterruptKeys(name, "tmux"),
    skipProxyEnv: true,
    executionMode: "persistent",
    needsPostCreateSend: false,
    capabilities: {
      canExecuteBash: true,
      canWriteFiles: true,
      canReadFiles: true,
      canRunApexCLI: false,
      preferredLanguage: "en",
      maxPromptBytes: 200_000,
    },
    buildStartCommand(opts: StartOpts): string {
      const argsStr = args.length > 0 ? " " + args.join(" ") : "";
      return `cd "${opts.worktreePath}" && ${command}${argsStr}`;
    },
  };
}

// ── Resolver: config + builtin ───────────────────────────────────────

/**
 * Resolve an agent adapter with config overrides.
 *
 * Priority: config override > builtin > error.
 *
 * When a config override exists for a builtin agent, the resulting
 * adapter merges: buildStartCommand from config, capabilities from
 * builtin.  For unknown custom agents, a default adapter is returned.
 */
export function resolveAdapterWithConfig(
  agent: string,
  configAdapters: AdaptersMap | undefined,
): AgentAdapter {
  const configEntry = configAdapters?.[agent];
  const builtin = BUILTIN_ADAPTERS[agent];

  // Case 1: config override for a builtin agent — merge
  if (configEntry && builtin) {
    const args = configEntry.args ?? [];
    return {
      ...builtin,
      binary: configEntry.command,
      buildStartCommand(opts: StartOpts): string {
        const argsStr = args.length > 0 ? " " + args.join(" ") : "";
        return `cd "${opts.worktreePath}" && ${configEntry.command}${argsStr}`;
      },
    };
  }

  // Case 2: config entry for a custom (non-builtin) agent
  if (configEntry && !builtin) {
    return makeDefaultAdapter(agent, configEntry.command, configEntry.args ?? []);
  }

  // Case 3: builtin, no config override
  if (builtin) {
    return builtin;
  }

  // Case 4: unknown agent, no config — error
  throw new Error(
    `Unknown agent "${agent}". Add it to config.adapters or use a builtin: ${Object.keys(BUILTIN_ADAPTERS).join(", ")}`,
  );
}

// ── Convenience: builtin-only lookup ─────────────────────────────────

/**
 * Resolve a builtin adapter by name.  No async config loading.
 * Throws for unknown agents.
 */
export function resolveAdapter(agent: string): AgentAdapter {
  return resolveAdapterWithConfig(agent, undefined);
}
