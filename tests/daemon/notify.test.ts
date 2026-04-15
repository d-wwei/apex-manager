import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, rmSync, readdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { appendNotification, readPendingNotifications } from "../../src/daemon/notify.js";

describe("notification queue", () => {
  let origCwd: string;
  let tmpDir: string;

  beforeEach(() => {
    origCwd = process.cwd();
    tmpDir = join(tmpdir(), `am-notify-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(origCwd);
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it("appendNotification creates file in .apex-manager/notifications/", () => {
    appendNotification("Worker T1 completed");
    const dir = join(tmpDir, ".apex-manager", "notifications");
    assert.ok(existsSync(dir));
    const files = readdirSync(dir);
    assert.strictEqual(files.length, 1);
    assert.ok(files[0].endsWith(".json"));
  });

  it("readPendingNotifications returns empty when no notifications", () => {
    const result = readPendingNotifications();
    assert.deepStrictEqual(result, []);
  });

  it("readPendingNotifications returns notifications in order", () => {
    appendNotification("first");
    appendNotification("second");
    appendNotification("third");

    const result = readPendingNotifications();
    assert.strictEqual(result.length, 3);
    assert.strictEqual(result[0].message, "first");
    assert.strictEqual(result[1].message, "second");
    assert.strictEqual(result[2].message, "third");
  });

  it("readPendingNotifications marks files as processed", () => {
    appendNotification("test message");

    const before = readdirSync(join(tmpDir, ".apex-manager", "notifications"));
    assert.ok(before.some(f => f.endsWith(".json")));

    readPendingNotifications();

    const after = readdirSync(join(tmpDir, ".apex-manager", "notifications"));
    assert.ok(after.every(f => f.includes(".processed.")));
  });

  it("readPendingNotifications does not return already-processed files", () => {
    appendNotification("once only");
    readPendingNotifications(); // Marks as processed
    const second = readPendingNotifications(); // Should find nothing new
    assert.deepStrictEqual(second, []);
  });
});
