import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  formatCostReport,
  checkBudget,
  formatRateLimitStatus,
  formatTokens,
} from "../../src/worker/cost.js";
import type { CostSummary, RateLimitInfo } from "../../src/worker/proxy.js";

let testDir: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  testDir = join(tmpdir(), `am-test-cost-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(testDir, { recursive: true });
  process.chdir(testDir);
  mkdirSync(".apex-manager", { recursive: true });
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(testDir, { recursive: true, force: true });
});

// ─── formatTokens ───────────────────────────────────────────────────

describe("formatTokens", () => {
  it("formats thousands with k suffix", () => {
    assert.strictEqual(formatTokens(120000), "120k");
  });

  it("formats fractional thousands", () => {
    assert.strictEqual(formatTokens(35500), "35.5k");
  });

  it("formats small counts without suffix", () => {
    assert.strictEqual(formatTokens(500), "500");
  });

  it("formats zero", () => {
    assert.strictEqual(formatTokens(0), "0");
  });

  it("formats exact thousand", () => {
    assert.strictEqual(formatTokens(1000), "1k");
  });

  it("rounds to one decimal", () => {
    assert.strictEqual(formatTokens(1234), "1.2k");
  });
});

// ─── formatCostReport ───────────────────────────────────────────────

describe("formatCostReport", () => {
  const summary: CostSummary = {
    total_cost_usd: 0.73,
    total_requests: 20,
    by_task: {
      T1: { total_cost_usd: 0.45, total_input_tokens: 120000, total_output_tokens: 35000, request_count: 12 },
      T2: { total_cost_usd: 0.28, total_input_tokens: 80000, total_output_tokens: 20000, request_count: 8 },
    },
  };

  it("formats basic cost report without budget", () => {
    const report = formatCostReport(summary);
    assert.ok(report.includes("T1"));
    assert.ok(report.includes("$0.45"));
    assert.ok(report.includes("120k"));
    assert.ok(report.includes("35k"));
    assert.ok(report.includes("12 calls"));
    assert.ok(report.includes("T2"));
    assert.ok(report.includes("$0.28"));
    assert.ok(report.includes("$0.73"));
    assert.ok(!report.includes("Budget"));
  });

  it("includes task titles from tasks.json when available", () => {
    const tasks = {
      tasks: [
        { id: "T1", title: "auth-api", status: "done", depends_on: [], blocked_by: [], evidence: [], created_at: "", updated_at: "" },
        { id: "T2", title: "pagination", status: "done", depends_on: [], blocked_by: [], evidence: [], created_at: "", updated_at: "" },
      ],
      next_id: 3,
    };
    writeFileSync(".apex-manager/tasks.json", JSON.stringify(tasks));

    const report = formatCostReport(summary);
    assert.ok(report.includes("auth-api"));
    assert.ok(report.includes("pagination"));
  });

  it("formats report with budget info", () => {
    const report = formatCostReport(summary, 5.0);
    assert.ok(report.includes("Budget"));
    assert.ok(report.includes("$5.00"));
    assert.ok(report.includes("$0.73"));
    assert.ok(report.includes("Remaining"));
  });

  it("handles empty summary", () => {
    const empty: CostSummary = { total_cost_usd: 0, total_requests: 0, by_task: {} };
    const report = formatCostReport(empty);
    assert.ok(report.includes("$0.00"));
  });
});

// ─── checkBudget ────────────────────────────────────────────────────

describe("checkBudget", () => {
  it("returns ok when no budget set", async () => {
    const result = await checkBudget({});
    assert.strictEqual(result.status, "ok");
  });

  it("returns ok when under warning threshold", async () => {
    const entries = [
      JSON.stringify({ task_id: "T1", model: "claude-sonnet-4", input_tokens: 1000, output_tokens: 500, cost_usd: 0.50, ts: "2025-01-01T00:00:00Z" }),
    ];
    writeFileSync(".apex-manager/cost-log.jsonl", entries.join("\n") + "\n");

    const result = await checkBudget({ budget_usd: 5.0 });
    assert.strictEqual(result.status, "ok");
    assert.ok(Math.abs(result.used! - 0.50) < 0.01);
    assert.strictEqual(result.budget, 5.0);
  });

  it("returns warn when usage exceeds warning threshold", async () => {
    const entries = [
      JSON.stringify({ task_id: "T1", model: "claude-sonnet-4", input_tokens: 1000, output_tokens: 500, cost_usd: 4.20, ts: "2025-01-01T00:00:00Z" }),
    ];
    writeFileSync(".apex-manager/cost-log.jsonl", entries.join("\n") + "\n");

    const result = await checkBudget({ budget_usd: 5.0 });
    assert.strictEqual(result.status, "warn");
  });

  it("returns exceeded when usage meets budget", async () => {
    const entries = [
      JSON.stringify({ task_id: "T1", model: "claude-sonnet-4", input_tokens: 1000, output_tokens: 500, cost_usd: 5.00, ts: "2025-01-01T00:00:00Z" }),
    ];
    writeFileSync(".apex-manager/cost-log.jsonl", entries.join("\n") + "\n");

    const result = await checkBudget({ budget_usd: 5.0 });
    assert.strictEqual(result.status, "exceeded");
  });

  it("respects custom warning threshold", async () => {
    const entries = [
      JSON.stringify({ task_id: "T1", model: "claude-sonnet-4", input_tokens: 1000, output_tokens: 500, cost_usd: 3.00, ts: "2025-01-01T00:00:00Z" }),
    ];
    writeFileSync(".apex-manager/cost-log.jsonl", entries.join("\n") + "\n");

    const resultDefault = await checkBudget({ budget_usd: 5.0 });
    assert.strictEqual(resultDefault.status, "ok");

    const resultCustom = await checkBudget({ budget_usd: 5.0, budget_warn: 0.50 });
    assert.strictEqual(resultCustom.status, "warn");
  });

  it("exceeded takes priority over warn", async () => {
    const entries = [
      JSON.stringify({ task_id: "T1", model: "claude-sonnet-4", input_tokens: 1000, output_tokens: 500, cost_usd: 6.00, ts: "2025-01-01T00:00:00Z" }),
    ];
    writeFileSync(".apex-manager/cost-log.jsonl", entries.join("\n") + "\n");

    const result = await checkBudget({ budget_usd: 5.0 });
    assert.strictEqual(result.status, "exceeded");
  });
});

// ─── formatRateLimitStatus ──────────────────────────────────────────

describe("formatRateLimitStatus", () => {
  it("formats rate limit info", () => {
    const info: RateLimitInfo = {
      tokens_remaining: 80000,
      tokens_limit: 100000,
      requests_remaining: 500,
      requests_limit: 1000,
      utilization_5h: 0.5,
      throttled: false,
      updated_at: "2025-01-01T00:00:00Z",
    };

    const output = formatRateLimitStatus(info);
    assert.ok(output.includes("80,000"));
    assert.ok(output.includes("100,000"));
    assert.ok(output.includes("80%"));
    assert.ok(output.includes("500"));
    assert.ok(output.includes("1,000"));
    assert.ok(output.includes("50%"));
    assert.ok(output.includes("OK"));
    assert.ok(!output.includes("THROTTLED"));
  });

  it("shows throttled warning", () => {
    const info: RateLimitInfo = {
      tokens_remaining: 5000,
      tokens_limit: 100000,
      requests_remaining: 50,
      requests_limit: 1000,
      utilization_5h: 0.95,
      throttled: true,
      updated_at: "2025-01-01T00:00:00Z",
    };

    const output = formatRateLimitStatus(info);
    assert.ok(output.includes("THROTTLED"));
  });

  it("returns message when null", () => {
    const output = formatRateLimitStatus(null);
    assert.ok(output.includes("No rate limit data"));
  });
});
