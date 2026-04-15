import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdirSync, rmSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  parseRateLimitHeaders,
  calculateCost,
  extractUsageFromBody,
  readRateLimit,
  readCostSummary,
  type RateLimitInfo,
  type CostEntry,
} from "../../src/worker/proxy.js";

let testDir: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  testDir = join(tmpdir(), `am-test-proxy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(testDir, { recursive: true });
  process.chdir(testDir);
  mkdirSync(".apex-manager", { recursive: true });
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(testDir, { recursive: true, force: true });
});

// ─── Rate Limit Header Extraction ────────────────────────────────────

describe("parseRateLimitHeaders", () => {
  it("extracts all four rate limit headers", () => {
    const headers = new Headers({
      "x-ratelimit-limit-tokens": "100000",
      "x-ratelimit-remaining-tokens": "80000",
      "x-ratelimit-limit-requests": "1000",
      "x-ratelimit-remaining-requests": "500",
    });

    const info = parseRateLimitHeaders(headers)!;
    assert.strictEqual(info.tokens_limit, 100000);
    assert.strictEqual(info.tokens_remaining, 80000);
    assert.strictEqual(info.requests_limit, 1000);
    assert.strictEqual(info.requests_remaining, 500);
  });

  it("calculates utilization_5h correctly", () => {
    const headers = new Headers({
      "x-ratelimit-limit-tokens": "100000",
      "x-ratelimit-remaining-tokens": "20000",
      "x-ratelimit-limit-requests": "1000",
      "x-ratelimit-remaining-requests": "100",
    });

    const info = parseRateLimitHeaders(headers)!;
    // token utilization: 1 - 20000/100000 = 0.80
    // request utilization: 1 - 100/1000 = 0.90
    // utilization_5h = max of both = 0.90
    assert.strictEqual(info.utilization_5h, 0.9);
  });

  it("sets throttled=true when utilization >= 0.90", () => {
    const headers = new Headers({
      "x-ratelimit-limit-tokens": "100000",
      "x-ratelimit-remaining-tokens": "5000",
      "x-ratelimit-limit-requests": "1000",
      "x-ratelimit-remaining-requests": "900",
    });

    const info = parseRateLimitHeaders(headers)!;
    // token utilization: 1 - 5000/100000 = 0.95
    assert.strictEqual(info.throttled, true);
  });

  it("sets throttled=false when utilization < 0.90", () => {
    const headers = new Headers({
      "x-ratelimit-limit-tokens": "100000",
      "x-ratelimit-remaining-tokens": "50000",
      "x-ratelimit-limit-requests": "1000",
      "x-ratelimit-remaining-requests": "800",
    });

    const info = parseRateLimitHeaders(headers)!;
    // token: 0.50, request: 0.20 -> max 0.50 < 0.90
    assert.strictEqual(info.throttled, false);
  });

  it("returns null when headers are missing", () => {
    const headers = new Headers({ "content-type": "application/json" });
    const info = parseRateLimitHeaders(headers);
    assert.strictEqual(info, null);
  });

  it("returns null when limit headers are zero (avoid division by zero)", () => {
    const headers = new Headers({
      "x-ratelimit-limit-tokens": "0",
      "x-ratelimit-remaining-tokens": "0",
      "x-ratelimit-limit-requests": "0",
      "x-ratelimit-remaining-requests": "0",
    });

    const info = parseRateLimitHeaders(headers);
    assert.strictEqual(info, null);
  });

  it("includes updated_at timestamp", () => {
    const headers = new Headers({
      "x-ratelimit-limit-tokens": "100000",
      "x-ratelimit-remaining-tokens": "80000",
      "x-ratelimit-limit-requests": "1000",
      "x-ratelimit-remaining-requests": "500",
    });

    const before = new Date().toISOString();
    const info = parseRateLimitHeaders(headers);
    const after = new Date().toISOString();

    assert.ok(info!.updated_at);
    assert.ok(info!.updated_at >= before);
    assert.ok(info!.updated_at <= after);
  });
});

// ─── Cost Calculation ────────────────────────────────────────────────

describe("calculateCost", () => {
  it("claude-opus-4 pricing: $15/MTok input, $75/MTok output", () => {
    const cost = calculateCost("claude-opus-4-20250514", 1_000_000, 1_000_000);
    assert.ok(Math.abs(cost - (15 + 75)) < 0.01);
  });

  it("claude-sonnet-4 pricing: $3/MTok input, $15/MTok output", () => {
    const cost = calculateCost("claude-sonnet-4-20250514", 1_000_000, 1_000_000);
    assert.ok(Math.abs(cost - (3 + 15)) < 0.01);
  });

  it("claude-haiku-4 pricing: $0.80/MTok input, $4/MTok output", () => {
    const cost = calculateCost("claude-haiku-4-20250514", 1_000_000, 1_000_000);
    assert.ok(Math.abs(cost - (0.8 + 4)) < 0.01);
  });

  it("defaults to sonnet pricing for unknown model", () => {
    const cost = calculateCost("unknown-model", 1_000_000, 1_000_000);
    assert.ok(Math.abs(cost - (3 + 15)) < 0.01);
  });

  it("handles small token counts correctly", () => {
    // 5000 input + 2000 output at sonnet rates
    // input: 5000 * 3 / 1_000_000 = 0.015
    // output: 2000 * 15 / 1_000_000 = 0.030
    const cost = calculateCost("claude-sonnet-4-20250514", 5000, 2000);
    assert.ok(Math.abs(cost - 0.045) < 0.0001);
  });

  it("handles zero tokens", () => {
    const cost = calculateCost("claude-sonnet-4-20250514", 0, 0);
    assert.strictEqual(cost, 0);
  });

  it("matches model by prefix (opus-4)", () => {
    const cost = calculateCost("claude-opus-4", 100_000, 100_000);
    // input: 100k * 15 / 1M = 1.5; output: 100k * 75 / 1M = 7.5
    assert.ok(Math.abs(cost - 9.0) < 0.01);
  });
});

// ─── Usage Extraction from Response Body ─────────────────────────────

describe("extractUsageFromBody", () => {
  it("extracts input_tokens and output_tokens from valid response", () => {
    const body = {
      id: "msg_123",
      type: "message",
      usage: { input_tokens: 5000, output_tokens: 2000 },
    };
    const usage = extractUsageFromBody(body);
    assert.deepStrictEqual(usage, { input_tokens: 5000, output_tokens: 2000 });
  });

  it("returns null for body without usage", () => {
    const body = { id: "msg_123", type: "message" };
    const usage = extractUsageFromBody(body);
    assert.strictEqual(usage, null);
  });

  it("returns null for non-object body", () => {
    const usage = extractUsageFromBody(null);
    assert.strictEqual(usage, null);
  });

  it("returns null when usage fields are not numbers", () => {
    const body = { usage: { input_tokens: "five", output_tokens: "two" } };
    const usage = extractUsageFromBody(body);
    assert.strictEqual(usage, null);
  });
});

// ─── readRateLimit ───────────────────────────────────────────────────

describe("readRateLimit", () => {
  it("reads existing rate-limit.json", async () => {
    const data: RateLimitInfo = {
      tokens_remaining: 80000,
      tokens_limit: 100000,
      requests_remaining: 500,
      requests_limit: 1000,
      utilization_5h: 0.2,
      throttled: false,
      updated_at: new Date().toISOString(),
    };
    writeFileSync(".apex-manager/rate-limit.json", JSON.stringify(data));

    const result = await readRateLimit();
    assert.deepStrictEqual(result, data);
  });

  it("returns null when file does not exist", async () => {
    const result = await readRateLimit();
    assert.strictEqual(result, null);
  });
});

// ─── readCostSummary ─────────────────────────────────────────────────

describe("readCostSummary", () => {
  it("aggregates cost entries by task_id", async () => {
    const entries: CostEntry[] = [
      { task_id: "T1", model: "claude-sonnet-4", input_tokens: 5000, output_tokens: 2000, cost_usd: 0.045, ts: "2025-01-01T00:00:00Z" },
      { task_id: "T1", model: "claude-sonnet-4", input_tokens: 3000, output_tokens: 1000, cost_usd: 0.024, ts: "2025-01-01T00:01:00Z" },
      { task_id: "T2", model: "claude-opus-4", input_tokens: 1000, output_tokens: 500, cost_usd: 0.0525, ts: "2025-01-01T00:02:00Z" },
    ];
    const lines = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    writeFileSync(".apex-manager/cost-log.jsonl", lines);

    const summary = await readCostSummary();
    assert.ok(Math.abs(summary.by_task["T1"].total_cost_usd - 0.069) < 0.0001);
    assert.strictEqual(summary.by_task["T1"].total_input_tokens, 8000);
    assert.strictEqual(summary.by_task["T1"].total_output_tokens, 3000);
    assert.strictEqual(summary.by_task["T1"].request_count, 2);

    assert.ok(Math.abs(summary.by_task["T2"].total_cost_usd - 0.0525) < 0.0001);
    assert.strictEqual(summary.by_task["T2"].request_count, 1);

    assert.ok(Math.abs(summary.total_cost_usd - 0.1215) < 0.0001);
    assert.strictEqual(summary.total_requests, 3);
  });

  it("returns empty summary when no cost log exists", async () => {
    const summary = await readCostSummary();
    assert.strictEqual(summary.total_cost_usd, 0);
    assert.strictEqual(summary.total_requests, 0);
    assert.strictEqual(Object.keys(summary.by_task).length, 0);
  });

  it("skips malformed JSONL lines gracefully", async () => {
    const lines = [
      JSON.stringify({ task_id: "T1", model: "claude-sonnet-4", input_tokens: 1000, output_tokens: 500, cost_usd: 0.0105, ts: "2025-01-01T00:00:00Z" }),
      "this is not json",
      "",
      JSON.stringify({ task_id: "T1", model: "claude-sonnet-4", input_tokens: 2000, output_tokens: 1000, cost_usd: 0.021, ts: "2025-01-01T00:01:00Z" }),
    ].join("\n") + "\n";
    writeFileSync(".apex-manager/cost-log.jsonl", lines);

    const summary = await readCostSummary();
    assert.strictEqual(summary.total_requests, 2);
    assert.ok(Math.abs(summary.by_task["T1"].total_cost_usd - 0.0315) < 0.0001);
  });
});
