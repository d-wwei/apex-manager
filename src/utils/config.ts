/**
 * Apex Manager — Config Resolution
 *
 * Reads .apex-manager/config.yaml (flat key: value format) and merges with DEFAULT_CONFIG.
 * No external YAML library — the config format is intentionally flat.
 */

import { existsSync, readFileSync } from "fs";
import { DEFAULT_CONFIG, type ManagerConfig } from "../types/config.js";

const CONFIG_PATH = ".apex-manager/config.yaml";

/**
 * Parse a flat YAML file (key: value per line).
 */
export function parseSimpleYaml(content: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;

    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    const inlineComment = value.search(/\s+#/);
    if (inlineComment !== -1) {
      value = value.slice(0, inlineComment).trim();
    }

    if (key) {
      result[key] = value;
    }
  }

  return result;
}

function coerceValue(value: string): string | number | boolean {
  if (value === "true" || value === "yes") return true;
  if (value === "false" || value === "no") return false;
  if (/^-?\d+$/.test(value)) return parseInt(value, 10);
  if (/^-?\d+\.\d+$/.test(value)) return parseFloat(value);
  return value;
}

export async function loadConfig(): Promise<ManagerConfig> {
  if (!existsSync(CONFIG_PATH)) {
    return { ...DEFAULT_CONFIG };
  }

  const content = readFileSync(CONFIG_PATH, "utf-8");
  const raw = parseSimpleYaml(content);

  const config = { ...DEFAULT_CONFIG } as Record<string, unknown>;

  for (const [key, value] of Object.entries(raw)) {
    if (key in DEFAULT_CONFIG) {
      config[key] = coerceValue(value);
    }
  }

  return config as unknown as ManagerConfig;
}
