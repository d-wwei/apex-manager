export interface AgentEntry {
  /** Binary or command to invoke. Required. */
  command: string;
  /** Extra CLI arguments. */
  args?: string[];
  /** How to inject the protocol file: "system-prompt-file" | "post-create-send" | "none". Default: "post-create-send". */
  protocol?: "system-prompt-file" | "post-create-send" | "none";
  /** CLI flag for system-prompt-file injection (e.g. "--append-system-prompt-file"). */
  protocol_flag?: string;
  /** Interrupt key type: "esc" | "ctrlc". Default: "ctrlc". */
  interrupt?: "esc" | "ctrlc";
  /** Preferred output language: "zh" | "en". Default: "en". */
  language?: "zh" | "en";
  /** Forward auth env vars (ANTHROPIC_*, etc.) to worker. Default: false. */
  env_forward?: boolean;
  /** Skip proxy env vars (HTTP_PROXY etc.). Default: false. */
  skip_proxy_env?: boolean;
  /** Execution mode. Default: "persistent". */
  execution_mode?: "persistent" | "one-shot";
  /** Auto-approval flag (e.g. "--dangerously-skip-permissions", "--full-auto", "--yolo"). */
  auto_approval_flag?: string;
}

/** @deprecated Use AgentEntry instead */
export type AdapterEntry = AgentEntry;

export type AgentsMap = Record<string, AgentEntry>;
/** @deprecated Use AgentsMap instead */
export type AdaptersMap = AgentsMap;

export interface ManagerConfig {
  max_concurrent_workers: number;
  worker_default_agent: string;
  worker_agent_rules: { category: string; agent: string }[];
  rate_limit_enabled: boolean;
  rate_limit_threshold: number;
  budget_usd: number;
  budget_warn: number;
  polling_interval_ms: number;
  adapters?: AdaptersMap;
}

export const DEFAULT_CONFIG: ManagerConfig = {
  max_concurrent_workers: 3,
  worker_default_agent: "claude",
  worker_agent_rules: [],
  rate_limit_enabled: false,
  rate_limit_threshold: 50,
  budget_usd: 0,
  budget_warn: 0,
  polling_interval_ms: 10000,
};
