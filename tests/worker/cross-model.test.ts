import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { spawnSync } from "child_process";
import {
  generateCrossModelIds,
  mergeVerdicts,
  deduplicateFindings,
  spawnCrossModel,
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

describe("spawnCrossModel", () => {
  let tmpDir: string;
  let origCwd: string;
  let origPath: string | undefined;
  let origCmuxSurface: string | undefined;
  let origCmuxLog: string | undefined;
  let origApexTestRoot: string | undefined;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `am-cross-model-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
    origCwd = process.cwd();
    origPath = process.env.PATH;
    origCmuxSurface = process.env.CMUX_SURFACE;
    origCmuxLog = process.env.CMUX_LOG;
    origApexTestRoot = process.env.APEX_TEST_ROOT;
    process.chdir(tmpDir);

    spawnSync("git", ["init"], { cwd: tmpDir });
    spawnSync("git", ["-C", tmpDir, "config", "user.name", "test"]);
    spawnSync("git", ["-C", tmpDir, "config", "user.email", "test@test.com"]);
    spawnSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: tmpDir });

    mkdirSync(join(tmpDir, ".apex-manager"), { recursive: true });
    writeFileSync(join(tmpDir, ".apex-manager", "tasks.json"), JSON.stringify({
      tasks: [{
        id: "T1",
        title: "Cross model launch",
        description: "Verify cross-model workers really start.",
        status: "assigned",
        depends_on: [],
        blocked_by: [],
        evidence: [],
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      }],
      next_id: 2,
    }, null, 2));
  });

  afterEach(() => {
    process.chdir(origCwd);
    process.env.PATH = origPath;
    if (origCmuxSurface === undefined) delete process.env.CMUX_SURFACE;
    else process.env.CMUX_SURFACE = origCmuxSurface;
    if (origCmuxLog === undefined) delete process.env.CMUX_LOG;
    else process.env.CMUX_LOG = origCmuxLog;
    if (origApexTestRoot === undefined) delete process.env.APEX_TEST_ROOT;
    else process.env.APEX_TEST_ROOT = origApexTestRoot;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("kicks off interactive workers and verifies launch activity", async () => {
    const binDir = join(tmpDir, "bin");
    const logPath = join(tmpDir, "cmux.log");
    mkdirSync(binDir, { recursive: true });

    writeFileSync(join(binDir, "cmux"), `#!/bin/sh
echo "$@" >> "$CMUX_LOG"
case "$1" in
  new-split)
    echo "surface-1"
    exit 0
    ;;
  send)
    if printf '%s\n' "$@" | grep -q "Read the file .apex-manager/workers/T1-codex/worker-protocol.md"; then
      mkdir -p "$APEX_TEST_ROOT/.apex-manager/workers/T1-codex"
      printf '{\n  "stage": "executing",\n  "progress": "kickoff",\n  "last_activity": "2026-01-01T00:00:00Z"\n}\n' > "$APEX_TEST_ROOT/.apex-manager/workers/T1-codex/status.json"
    fi
    exit 0
    ;;
  send-key|rename-tab|validate-surface)
    exit 0
    ;;
  read-screen)
    echo '$ ready'
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`);
    chmodSync(join(binDir, "cmux"), 0o755);

    process.env.PATH = `${binDir}:${origPath ?? ""}`;
    process.env.CMUX_SURFACE = "surface-plan";
    process.env.CMUX_LOG = logPath;
    process.env.APEX_TEST_ROOT = tmpDir;

    await spawnCrossModel("T1", ["codex"], []);

    const meta = JSON.parse(readFileSync(join(tmpDir, ".apex-manager", "workers", "T1-codex", "meta.json"), "utf-8"));
    assert.strictEqual(meta.launch_verification.state, "verified");
    assert.strictEqual(meta.launch_verification.action_signal, "status_updated");

    const protocolPath = join(tmpDir, ".apex-manager", "workers", "T1-codex", "worker-protocol.md");
    assert.ok(readFileSync(protocolPath, "utf-8").includes("Cross model launch"));

    const cmuxLog = readFileSync(logPath, "utf-8");
    assert.ok(cmuxLog.includes("send surface-1 cd"));
    assert.ok(cmuxLog.includes("send surface-1 Read the file .apex-manager/workers/T1-codex/worker-protocol.md"));
  });
});
