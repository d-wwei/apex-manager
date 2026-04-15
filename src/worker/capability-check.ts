import { spawnSync } from "child_process";
import { BUILTIN_ADAPTERS } from "./agent-adapter.js";

export interface CheckResult {
  available: boolean;     // binary exists in PATH
  functional: boolean;    // basic operation works
  version: string | null; // version string
  issues: string[];       // any problems found
}

export async function checkAgent(binary: string): Promise<CheckResult> {
  const result: CheckResult = { available: false, functional: false, version: null, issues: [] };

  // Level 1: binary in PATH
  const whichResult = spawnSync("which", [binary], { encoding: "utf-8", timeout: 5_000 });
  if (whichResult.status !== 0) {
    result.issues.push(`${binary} not found in PATH`);
    return result;
  }
  result.available = true;

  // Level 2: version query
  const versionResult = spawnSync(binary, ["--version"], { encoding: "utf-8", timeout: 10_000 });
  if (versionResult.status === 0) {
    result.version = versionResult.stdout.trim().split("\n")[0];
  } else {
    result.issues.push(`${binary} --version failed`);
  }

  // Level 3: functional trust — requires successful version query
  result.functional = result.version !== null;
  return result;
}

export async function checkAllAgents(): Promise<Record<string, CheckResult>> {
  const results: Record<string, CheckResult> = {};
  for (const [name, adapter] of Object.entries(BUILTIN_ADAPTERS)) {
    results[name] = await checkAgent(adapter.binary);
  }
  return results;
}
