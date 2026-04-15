/**
 * Cost summary aggregation and budget checking.
 */

import { existsSync, readFileSync } from "fs";
import { readCostSummary, type CostSummary, type RateLimitInfo } from "./proxy.js";

// ─── Helpers ────────────────────────────────────────────────────────

/** Format token count: >=1000 → "120k", <1000 → "500" */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return Number.isInteger(k) ? `${k}k` : `${parseFloat(k.toFixed(1))}k`;
}

function formatUSD(n: number): string {
  return `$${n.toFixed(2)}`;
}

function formatNum(n: number): string {
  return n.toLocaleString("en-US");
}

/** Load task id→title map from .apex-manager/tasks.json (best-effort). */
function loadTaskTitles(): Record<string, string> {
  const map: Record<string, string> = {};
  try {
    if (!existsSync(".apex-manager/tasks.json")) return map;
    const raw = JSON.parse(readFileSync(".apex-manager/tasks.json", "utf-8"));
    for (const t of raw.tasks ?? []) {
      if (t.id && t.title) map[t.id] = t.title;
    }
  } catch { /* best-effort */ }
  return map;
}

// ─── Public API ─────────────────────────────────────────────────────

/** Format a human-readable cost report table. */
export function formatCostReport(summary: CostSummary, budget?: number): string {
  const titles = loadTaskTitles();
  const lines: string[] = [];
  const taskIds = Object.keys(summary.by_task);

  // Determine column width from longest label
  const labels = taskIds.map((id) => titles[id] ? `${id} (${titles[id]})` : id);
  const maxLabel = Math.max(10, ...labels.map((l) => l.length));

  for (let i = 0; i < taskIds.length; i++) {
    const id = taskIds[i];
    const t = summary.by_task[id];
    const label = labels[i];
    const detail = `input: ${formatTokens(t.total_input_tokens)}, output: ${formatTokens(t.total_output_tokens)}, ${t.request_count} calls`;
    lines.push(`${label.padEnd(maxLabel)}  ${formatUSD(t.total_cost_usd).padStart(7)}  (${detail})`);
  }

  if (taskIds.length > 0) {
    lines.push("─".repeat(maxLabel + 30));
  }
  lines.push(`${"Total".padEnd(maxLabel)}  ${formatUSD(summary.total_cost_usd).padStart(7)}`);

  if (budget !== undefined && budget > 0) {
    const remaining = Math.max(0, budget - summary.total_cost_usd);
    const pct = Math.round((summary.total_cost_usd / budget) * 100);
    lines.push("");
    lines.push(`Budget: ${formatUSD(budget)} | Used: ${formatUSD(summary.total_cost_usd)} | Remaining: ${formatUSD(remaining)} (${pct}%)`);
  }

  return lines.join("\n");
}

/** Check current spend against a budget. */
export async function checkBudget(
  config: { budget_usd?: number; budget_warn?: number },
): Promise<{ status: "ok" | "warn" | "exceeded"; used: number; budget: number }> {
  if (!config.budget_usd) {
    return { status: "ok", used: 0, budget: 0 };
  }

  const summary = await readCostSummary();
  const used = summary.total_cost_usd;
  const budget = config.budget_usd;
  const warnThreshold = config.budget_warn ?? 0.80;

  let status: "ok" | "warn" | "exceeded" = "ok";
  if (used >= budget) {
    status = "exceeded";
  } else if (used >= budget * warnThreshold) {
    status = "warn";
  }

  return { status, used, budget };
}

/** Format rate-limit info for display. */
export function formatRateLimitStatus(info: RateLimitInfo | null): string {
  if (!info) return "No rate limit data";

  const tokenPct = Math.round((info.tokens_remaining / info.tokens_limit) * 100);
  const reqPct = Math.round((info.requests_remaining / info.requests_limit) * 100);
  const status = info.throttled ? "THROTTLED" : "OK";

  return [
    `Tokens: ${formatNum(info.tokens_remaining)} / ${formatNum(info.tokens_limit)} (${tokenPct}%)`,
    `Requests: ${formatNum(info.requests_remaining)} / ${formatNum(info.requests_limit)} (${reqPct}%)`,
    `Status: ${status}`,
  ].join("\n");
}
