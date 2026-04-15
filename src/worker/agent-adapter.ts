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
}

// ── Built-in adapters ────────────────────────────────────────────────

const claudeAdapter: AgentAdapter = {
  name: "claude",
  binary: "claude",
  protocolInjection: { type: "system-prompt-file", flag: "--append-system-prompt-file" },
  interruptKeys: getInterruptKeys("claude", "tmux"),
  skipProxyEnv: false,
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
    return `cd "${opts.worktreePath}" && claude${model} --append-system-prompt-file "${opts.protocolPath}"`;
  },
};

const codexAdapter: AgentAdapter = {
  name: "codex",
  binary: "codex",
  protocolInjection: { type: "stdin" },
  interruptKeys: getInterruptKeys("codex", "tmux"),
  skipProxyEnv: true,
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
    return `cd "${opts.worktreePath}" && cat "${opts.protocolPath}" | codex${model} exec --full-auto`;
  },
};

const geminiAdapter: AgentAdapter = {
  name: "gemini",
  binary: "gemini",
  protocolInjection: { type: "cli-argument", flag: "-p" },
  interruptKeys: getInterruptKeys("gemini", "tmux"),
  skipProxyEnv: true,
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
    return `cd "${opts.worktreePath}" && gemini${model} --yolo -p "$(cat '${opts.protocolPath}')"`;
  },
};

const opencodeAdapter: AgentAdapter = {
  name: "opencode",
  binary: "opencode",
  protocolInjection: { type: "cli-argument", flag: "-p" },
  interruptKeys: getInterruptKeys("opencode", "tmux"),
  skipProxyEnv: true,
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
    return `cd "${opts.worktreePath}" && opencode${model} run -p "$(cat '${opts.protocolPath}')"`;
  },
};

export const BUILTIN_ADAPTERS: Record<string, AgentAdapter> = {
  claude: claudeAdapter,
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
