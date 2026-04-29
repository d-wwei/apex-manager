/**
 * Per-agent interrupt key sequences.
 *
 * Key names are adapter-specific:
 *   cmux: "escape", "ctrl-c"
 *   tmux: "Escape", "C-c"
 *
 * Agent interrupt type ("esc" or "ctrlc") is now defined in agents.json.
 * This module provides the terminal-adapter key mapping.
 */

type AdapterName = "cmux" | "tmux";

const KEY_MAP: Record<string, Record<AdapterName, string>> = {
  esc:   { cmux: "escape", tmux: "Escape" },
  ctrlc: { cmux: "ctrl-c", tmux: "C-c" },
};

/**
 * Map abstract interrupt key name(s) to terminal adapter-specific key strings.
 *
 * @param interrupt - "esc" or "ctrlc" (from agent config)
 * @param adapter - terminal adapter name ("cmux" or "tmux")
 */
export function interruptKeys(interrupt: string, adapter: AdapterName = "tmux"): string[] {
  const normalized = interrupt === "claude"
    ? "esc"
    : interrupt === "codex" || interrupt === "gemini" || interrupt === "opencode" || interrupt === "ft-claude"
      ? "ctrlc"
      : interrupt;
  const canonical = normalized === "esc" ? ["esc"] : normalized === "ctrlc" ? ["ctrlc"] : ["esc", "ctrlc"];
  return canonical.map(k => KEY_MAP[k]?.[adapter] ?? k);
}
