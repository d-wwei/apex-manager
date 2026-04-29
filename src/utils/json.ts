import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "fs";
import { dirname } from "path";

export async function readJSON<T>(path: string, defaultValue: T): Promise<T> {
  try {
    if (existsSync(path)) {
      const content = readFileSync(path, "utf-8");
      return JSON.parse(content) as T;
    }
    return defaultValue;
  } catch {
    return defaultValue;
  }
}

const JSON_LOCK_STALE_MS = 30_000;
const JSON_LOCK_RETRY_MS = 20;
const JSON_LOCK_TIMEOUT_MS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireFileLock(lockPath: string): Promise<() => void> {
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = Date.now();

  while (true) {
    try {
      writeFileSync(lockPath, token, { flag: "wx" });
      return () => {
        try {
          unlinkSync(lockPath);
        } catch {
          // Lock cleanup is best-effort.
        }
      };
    } catch (error: any) {
      if (error?.code !== "EEXIST") {
        throw error;
      }

      try {
        const stats = statSync(lockPath);
        if (Date.now() - stats.mtimeMs > JSON_LOCK_STALE_MS) {
          unlinkSync(lockPath);
          continue;
        }
      } catch {
        // Another writer may have released the lock between calls.
      }

      if (Date.now() - startedAt >= JSON_LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for JSON lock: ${lockPath}`);
      }

      await sleep(JSON_LOCK_RETRY_MS);
    }
  }
}

function writeJSONUnlocked<T>(path: string, data: T): void {
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  renameSync(tmp, path);
}

export async function writeJSON<T>(path: string, data: T): Promise<void> {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const lockPath = `${path}.lock`;
  const release = await acquireFileLock(lockPath);

  try {
    writeJSONUnlocked(path, data);
  } finally {
    release();
  }
}

export async function updateJSON<T, R>(
  path: string,
  defaultValue: T,
  updater: (current: T) => Promise<{ data: T; result: R }> | { data: T; result: R },
): Promise<R> {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const lockPath = `${path}.lock`;
  const release = await acquireFileLock(lockPath);

  try {
    let current = defaultValue;
    if (existsSync(path)) {
      try {
        current = JSON.parse(readFileSync(path, "utf-8")) as T;
      } catch {
        current = defaultValue;
      }
    }

    const { data, result } = await updater(current);
    writeJSONUnlocked(path, data);
    return result;
  } finally {
    release();
  }
}
