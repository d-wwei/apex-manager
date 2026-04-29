import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { writeJSON, readJSON } from "../../src/utils/json.js";

describe("writeJSON", () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `am-json-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    originalCwd = process.cwd();
    mkdirSync(tmpDir, { recursive: true });
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it("serializes concurrent writes to the same JSON path", async () => {
    const path = join(tmpDir, ".apex-manager", "messages", "index.json");

    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        writeJSON(path, { value: index, updated_at: new Date().toISOString() })),
    );

    assert.ok(existsSync(path));
    const data = await readJSON<{ value: number } | null>(path, null);
    assert.ok(data !== null);
    assert.strictEqual(typeof data!.value, "number");

    const leftovers = readdirSync(join(tmpDir, ".apex-manager", "messages"))
      .filter((name) => name.includes(".tmp.") || name.endsWith(".lock"));
    assert.deepStrictEqual(leftovers, []);
  });
});
