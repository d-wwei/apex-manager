import { describe, it } from "node:test";
import assert from "node:assert";
import {
  generateCrossModelIds,
  mergeVerdicts,
  deduplicateFindings,
} from "../../src/worker/cross-model.js";

describe("generateCrossModelIds", () => {
  it("generates task IDs for each agent", () => {
    const ids = generateCrossModelIds("T5", ["claude", "codex", "gemini"]);
    assert.deepStrictEqual(ids, ["T5-claude", "T5-codex", "T5-gemini"]);
  });

  it("handles single agent", () => {
    const ids = generateCrossModelIds("T1", ["claude"]);
    assert.deepStrictEqual(ids, ["T1-claude"]);
  });

  it("preserves task ID with hyphens", () => {
    const ids = generateCrossModelIds("T10-sub", ["codex", "gemini"]);
    assert.deepStrictEqual(ids, ["T10-sub-codex", "T10-sub-gemini"]);
  });
});

describe("mergeVerdicts", () => {
  it("returns pass when all pass", () => {
    assert.strictEqual(mergeVerdicts({ claude: "pass", codex: "pass", gemini: "pass" }), "pass");
  });

  it("returns fail when any fail (pessimistic)", () => {
    assert.strictEqual(mergeVerdicts({ claude: "pass", codex: "pass", gemini: "fail" }), "fail");
  });

  it("returns fail when all fail", () => {
    assert.strictEqual(mergeVerdicts({ claude: "fail", codex: "fail" }), "fail");
  });

  it("returns mixed when verdicts are mixed without fail", () => {
    assert.strictEqual(mergeVerdicts({ claude: "pass", codex: "mixed" }), "mixed");
  });

  it("returns fail when mix includes fail", () => {
    assert.strictEqual(mergeVerdicts({ claude: "pass", codex: "mixed", gemini: "fail" }), "fail");
  });

  it("handles single agent pass", () => {
    assert.strictEqual(mergeVerdicts({ claude: "pass" }), "pass");
  });

  it("handles single agent fail", () => {
    assert.strictEqual(mergeVerdicts({ claude: "fail" }), "fail");
  });
});

describe("deduplicateFindings", () => {
  it("removes exact duplicate findings", () => {
    const findings = [
      { description: "Missing null check in auth.ts", severity: "blocker" as const },
      { description: "Missing null check in auth.ts", severity: "blocker" as const },
      { description: "Unused import in utils.ts", severity: "note" as const },
    ];
    const result = deduplicateFindings(findings);
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].description, "Missing null check in auth.ts");
    assert.strictEqual(result[1].description, "Unused import in utils.ts");
  });

  it("treats case-insensitive matches as duplicates", () => {
    const findings = [
      { description: "SQL injection risk", severity: "blocker" as const },
      { description: "sql injection risk", severity: "concern" as const },
    ];
    const result = deduplicateFindings(findings);
    assert.strictEqual(result.length, 1);
  });

  it("preserves first occurrence on dedup", () => {
    const findings = [
      { description: "Issue A", severity: "blocker" as const, source: "claude" },
      { description: "Issue A", severity: "note" as const, source: "codex" },
    ];
    const result = deduplicateFindings(findings);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].severity, "blocker");
    assert.strictEqual(result[0].source, "claude");
  });

  it("returns empty for empty input", () => {
    assert.deepStrictEqual(deduplicateFindings([]), []);
  });

  it("keeps all findings when none are duplicates", () => {
    const findings = [
      { description: "Issue A", severity: "blocker" as const },
      { description: "Issue B", severity: "concern" as const },
      { description: "Issue C", severity: "note" as const },
    ];
    const result = deduplicateFindings(findings);
    assert.strictEqual(result.length, 3);
  });
});
