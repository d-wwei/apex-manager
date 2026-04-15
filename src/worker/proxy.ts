/**
 * Local API proxy — transparently forwards requests to api.anthropic.com
 * while extracting rate-limit headers and tracking token usage/costs.
 */
import http from "http";
import { existsSync, mkdirSync, readFileSync, unlinkSync } from "fs";
import { appendJSONL } from "../utils/logger.js";
import { readJSON, writeJSON } from "../utils/json.js";

// ─── Types ───────────────────────────────────────────────────────────

export interface RateLimitInfo {
  tokens_remaining: number;
  tokens_limit: number;
  requests_remaining: number;
  requests_limit: number;
  utilization_5h: number;
  throttled: boolean;
  updated_at: string;
}

export interface CostEntry {
  task_id: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  ts: string;
}

interface TaskCostSummary {
  total_cost_usd: number;
  total_input_tokens: number;
  total_output_tokens: number;
  request_count: number;
}

export interface CostSummary {
  total_cost_usd: number;
  total_requests: number;
  by_task: Record<string, TaskCostSummary>;
}

// ─── Model Pricing (per token) ───────────────────────────────────────

interface ModelPricing {
  input: number;   // USD per token
  output: number;  // USD per token
}

const PRICING: Record<string, ModelPricing> = {
  "opus-4":   { input: 15  / 1_000_000, output: 75 / 1_000_000 },
  "sonnet-4": { input: 3   / 1_000_000, output: 15 / 1_000_000 },
  "haiku-4":  { input: 0.8 / 1_000_000, output: 4  / 1_000_000 },
};

const DEFAULT_PRICING = PRICING["sonnet-4"];

const THROTTLE_THRESHOLD = 0.90;
const UPSTREAM = "https://api.anthropic.com";
const AM_DIR = ".apex-manager";
const RATE_LIMIT_FILE = `${AM_DIR}/rate-limit.json`;
const COST_LOG_FILE = `${AM_DIR}/cost-log.jsonl`;
const PORT_FILE = `${AM_DIR}/proxy-port`;

// ─── Pure Functions (exported for testing) ───────────────────────────

function resolvePricing(model: string): ModelPricing {
  for (const [key, pricing] of Object.entries(PRICING)) {
    if (model.includes(key)) return pricing;
  }
  return DEFAULT_PRICING;
}

export function parseRateLimitHeaders(headers: Headers): RateLimitInfo | null {
  const limitTokens = parseInt(headers.get("x-ratelimit-limit-tokens") ?? "", 10);
  const remainingTokens = parseInt(headers.get("x-ratelimit-remaining-tokens") ?? "", 10);
  const limitRequests = parseInt(headers.get("x-ratelimit-limit-requests") ?? "", 10);
  const remainingRequests = parseInt(headers.get("x-ratelimit-remaining-requests") ?? "", 10);

  if ([limitTokens, remainingTokens, limitRequests, remainingRequests].some(isNaN)) {
    return null;
  }
  if (limitTokens === 0 || limitRequests === 0) {
    return null;
  }

  const tokenUtil = 1 - remainingTokens / limitTokens;
  const requestUtil = 1 - remainingRequests / limitRequests;
  const utilization_5h = Math.max(tokenUtil, requestUtil);

  return {
    tokens_remaining: remainingTokens,
    tokens_limit: limitTokens,
    requests_remaining: remainingRequests,
    requests_limit: limitRequests,
    utilization_5h: Math.round(utilization_5h * 1000) / 1000, // 3 decimal places
    throttled: utilization_5h >= THROTTLE_THRESHOLD,
    updated_at: new Date().toISOString(),
  };
}

export function calculateCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = resolvePricing(model);
  return inputTokens * pricing.input + outputTokens * pricing.output;
}

export function extractUsageFromBody(body: unknown): { input_tokens: number; output_tokens: number } | null {
  if (body === null || typeof body !== "object") return null;
  const usage = (body as Record<string, unknown>).usage;
  if (!usage || typeof usage !== "object") return null;
  const { input_tokens, output_tokens } = usage as Record<string, unknown>;
  if (typeof input_tokens !== "number" || typeof output_tokens !== "number") return null;
  return { input_tokens, output_tokens };
}

// ─── File I/O ────────────────────────────────────────────────────────

export async function readRateLimit(): Promise<RateLimitInfo | null> {
  return readJSON<RateLimitInfo | null>(RATE_LIMIT_FILE, null);
}

export async function readCostSummary(): Promise<CostSummary> {
  const empty: CostSummary = { total_cost_usd: 0, total_requests: 0, by_task: {} };

  if (!existsSync(COST_LOG_FILE)) return empty;

  const raw = readFileSync(COST_LOG_FILE, "utf-8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);

  const summary: CostSummary = { total_cost_usd: 0, total_requests: 0, by_task: {} };

  for (const line of lines) {
    let entry: CostEntry;
    try {
      entry = JSON.parse(line) as CostEntry;
    } catch {
      continue; // skip malformed lines
    }

    summary.total_cost_usd += entry.cost_usd;
    summary.total_requests += 1;

    const tid = entry.task_id ?? "unknown";
    if (!summary.by_task[tid]) {
      summary.by_task[tid] = { total_cost_usd: 0, total_input_tokens: 0, total_output_tokens: 0, request_count: 0 };
    }
    const bucket = summary.by_task[tid];
    bucket.total_cost_usd += entry.cost_usd;
    bucket.total_input_tokens += entry.input_tokens;
    bucket.total_output_tokens += entry.output_tokens;
    bucket.request_count += 1;
  }

  return summary;
}

// ─── Proxy Server ────────────────────────────────────────────────────

let proxyServer: http.Server | null = null;

async function findAvailablePort(start: number, end: number): Promise<number> {
  for (let port = start; port <= end; port++) {
    const available = await new Promise<boolean>((resolve) => {
      const test = http.createServer();
      test.once("error", () => resolve(false));
      test.listen(port, () => {
        test.close(() => resolve(true));
      });
    });
    if (available) return port;
  }
  throw new Error(`No available port in range ${start}-${end}`);
}

export async function startProxy(port?: number): Promise<number> {
  if (proxyServer) throw new Error("Proxy already running");

  if (!existsSync(AM_DIR)) mkdirSync(AM_DIR, { recursive: true });

  const resolvedPort = port ?? await findAvailablePort(9100, 9199);

  proxyServer = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://localhost:${resolvedPort}`);
      const upstreamUrl = `${UPSTREAM}${url.pathname}${url.search}`;

      // Read incoming request body
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      }
      const reqBody = chunks.length > 0 ? Buffer.concat(chunks).toString("utf-8") : null;

      let reqJson: Record<string, unknown> | null = null;
      try {
        if (reqBody) reqJson = JSON.parse(reqBody) as Record<string, unknown>;
      } catch { /* non-JSON body, ignore */ }

      const taskId = req.headers["x-apex-task-id"] as string ?? "unknown";

      // Build upstream headers — clone incoming, strip internal header
      const fwdHeaders: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (key.toLowerCase() === "x-apex-task-id") continue;
        if (key.toLowerCase() === "host") continue;
        if (value !== undefined) {
          fwdHeaders[key] = Array.isArray(value) ? value.join(", ") : value;
        }
      }

      // Forward to upstream
      const upstreamRes = await fetch(upstreamUrl, {
        method: req.method ?? "GET",
        headers: fwdHeaders,
        body: reqBody,
      });

      // Read response body for usage extraction
      const resBody = await upstreamRes.text();

      // Extract rate limits from response headers
      const rateLimit = parseRateLimitHeaders(upstreamRes.headers);
      if (rateLimit) {
        await writeJSON(RATE_LIMIT_FILE, rateLimit);
      }

      // Extract usage and log cost
      let resJson: unknown = null;
      try {
        resJson = JSON.parse(resBody);
      } catch { /* non-JSON response */ }

      if (resJson) {
        const usage = extractUsageFromBody(resJson);
        if (usage) {
          const model = (reqJson?.model as string) ?? "unknown";
          const cost = calculateCost(model, usage.input_tokens, usage.output_tokens);
          const entry: CostEntry = {
            task_id: taskId,
            model,
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            cost_usd: Math.round(cost * 1_000_000) / 1_000_000, // 6 decimal places
            ts: new Date().toISOString(),
          };
          appendJSONL(COST_LOG_FILE, entry as unknown as Record<string, unknown>);
        }
      }

      // Return response to caller with original headers
      const resHeaders: Record<string, string> = {};
      upstreamRes.headers.forEach((value, key) => {
        resHeaders[key] = value;
      });

      res.writeHead(upstreamRes.status, resHeaders);
      res.end(resBody);
    } catch (err) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "proxy_error", message: String(err) }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    proxyServer!.once("error", reject);
    proxyServer!.listen(resolvedPort, () => resolve());
  });

  await writeJSON(PORT_FILE, { port: resolvedPort, pid: process.pid });
  return resolvedPort;
}

export async function stopProxy(): Promise<void> {
  if (proxyServer) {
    await new Promise<void>((resolve) => {
      proxyServer!.close(() => resolve());
    });
    proxyServer = null;
  }
  if (existsSync(PORT_FILE)) {
    unlinkSync(PORT_FILE);
  }
}
