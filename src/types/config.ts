export interface AdapterEntry {
  command: string;
  args?: string[];
}

export type AdaptersMap = Record<string, AdapterEntry>;

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
