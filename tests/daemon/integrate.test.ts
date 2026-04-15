import { describe, it } from "node:test";
import assert from "node:assert";
import { autoIntegrate, autoMerge } from "../../src/daemon/integrate.js";

describe("autoIntegrate", () => {
  it("returns IntegrateResult with ok field", async () => {
    const result = await autoIntegrate("nonexistent-task");
    assert.ok("ok" in result);
    assert.strictEqual(typeof result.ok, "boolean");
    assert.strictEqual(result.ok, false);
    assert.ok(result.reason !== undefined);
  });

  it("IntegrateResult reason is one of expected values", async () => {
    const result = await autoIntegrate("nonexistent-task");
    if (!result.ok && result.reason) {
      assert.ok(["merge_conflict", "test_failure", "merge_race_retry"].includes(result.reason));
    }
  });
});

describe("autoMerge", () => {
  it("returns boolean", async () => {
    // autoMerge on a nonexistent branch should return false
    const result = await autoMerge("nonexistent-task");
    assert.strictEqual(typeof result, "boolean");
    assert.strictEqual(result, false);
  });
});
