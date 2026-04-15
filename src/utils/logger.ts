import { appendFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";

export function appendJSONL(path: string, record: Record<string, unknown>): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  appendFileSync(path, JSON.stringify(record) + "\n");
}
