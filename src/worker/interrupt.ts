/**
 * Per-agent interrupt key sequences.
 *
 * Different AI agent CLIs respond to different key combinations.
 * Returns the keys to send (in order) to interrupt a running agent.
 *
 * Key names are adapter-specific:
 *   cmux: "escape", "ctrl-c"
 *   tmux: "Escape", "C-c"
 */

type AdapterName = "cmux" | "tmux";

const KEY_MAP: Record<string, Record<AdapterName, string>> = {
  esc:   { cmux: "escape", tmux: "Escape" },
  ctrlc: { cmux: "ctrl-c", tmux: "C-c" },
};

const AGENT_KEYS: Record<string, string[]> = {
  claude:   ["esc"],
  codex:    ["ctrlc"],
  gemini:   ["ctrlc"],
  opencode: ["ctrlc"],
};

export function interruptKeys(agent: string, adapter: AdapterName = "tmux"): string[] {
  const canonical = AGENT_KEYS[agent] ?? ["esc", "ctrlc"];
  return canonical.map(k => KEY_MAP[k]?.[adapter] ?? k);
}
