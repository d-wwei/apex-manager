import { describe, it } from "node:test";
import assert from "node:assert";
import { interruptKeys } from "../../src/worker/interrupt.js";

describe("interruptKeys", () => {
  it("claude returns Escape (tmux default)", () => {
    assert.deepStrictEqual(interruptKeys("claude"), ["Escape"]);
  });

  it("codex returns C-c (tmux default)", () => {
    assert.deepStrictEqual(interruptKeys("codex"), ["C-c"]);
  });

  it("gemini returns C-c (tmux default)", () => {
    assert.deepStrictEqual(interruptKeys("gemini"), ["C-c"]);
  });

  it("unknown agent returns both Escape and C-c (tmux)", () => {
    assert.deepStrictEqual(interruptKeys("some-agent"), ["Escape", "C-c"]);
  });

  it("claude returns escape for cmux adapter", () => {
    assert.deepStrictEqual(interruptKeys("claude", "cmux"), ["escape"]);
  });

  it("codex returns ctrl-c for cmux adapter", () => {
    assert.deepStrictEqual(interruptKeys("codex", "cmux"), ["ctrl-c"]);
  });

  it("unknown agent returns both for cmux adapter", () => {
    assert.deepStrictEqual(interruptKeys("some-agent", "cmux"), ["escape", "ctrl-c"]);
  });
});
