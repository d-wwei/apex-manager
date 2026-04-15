import { describe, it } from "node:test";
import assert from "node:assert";
import { checkAgent, checkAllAgents } from "../../src/worker/capability-check.js";

describe("checkAgent", () => {
  it("returns available=true for binary in PATH (using 'ls')", async () => {
    const result = await checkAgent("ls");
    assert.strictEqual(result.available, true);
  });

  it("returns available=false for nonexistent binary", async () => {
    const result = await checkAgent("nonexistent-binary-xyz-12345");
    assert.strictEqual(result.available, false);
    assert.strictEqual(result.functional, false);
    assert.ok(result.issues.length > 0);
    assert.ok(result.issues[0].includes("not found"));
  });

  it("captures version when --version succeeds (using 'git')", async () => {
    const result = await checkAgent("git");
    assert.strictEqual(result.available, true);
    assert.ok(result.version);
    assert.ok(result.version!.includes("git"));
  });

  it("sets functional=true when binary exists", async () => {
    const result = await checkAgent("git");
    assert.strictEqual(result.functional, true);
  });

  it("issues array is empty when no problems", async () => {
    const result = await checkAgent("git");
    assert.deepStrictEqual(result.issues, []);
  });
});

describe("checkAllAgents", () => {
  // checkAllAgents runs 4 agents sequentially; some CLIs (e.g. claude) take
  // ~5 s to respond to --version, so allow enough wall time for the full pass.

  it("returns entries for all 4 builtin agents", { timeout: 30_000 }, async () => {
    const results = await checkAllAgents();
    const keys = Object.keys(results);
    assert.ok(keys.includes("claude"));
    assert.ok(keys.includes("codex"));
    assert.ok(keys.includes("gemini"));
    assert.ok(keys.includes("opencode"));
    assert.strictEqual(keys.length, 4);
  });

  it("each result has correct shape", { timeout: 30_000 }, async () => {
    const results = await checkAllAgents();
    for (const result of Object.values(results)) {
      assert.strictEqual(typeof result.available, "boolean");
      assert.strictEqual(typeof result.functional, "boolean");
      assert.ok(Array.isArray(result.issues));
    }
  });
});
