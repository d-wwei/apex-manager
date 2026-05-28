import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { chmodSync, existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { spawnSync } from "child_process";

// --- Test helpers ---

function makeTmpDir(): string {
  const dir = join(tmpdir(), `am-worker-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeTasksJson(dir: string, tasks: any[]) {
  const amDir = join(dir, ".apex-manager");
  mkdirSync(amDir, { recursive: true });
  writeFileSync(
    join(amDir, "tasks.json"),
    JSON.stringify({ tasks, next_id: tasks.length + 1 }, null, 2),
  );
}

function writeWorkerMeta(dir: string, taskId: string, meta: any) {
  const metaDir = join(dir, ".apex-manager", "workers", taskId);
  mkdirSync(metaDir, { recursive: true });
  writeFileSync(join(metaDir, "meta.json"), JSON.stringify(meta, null, 2));
}

// --- Tests ---

describe("cmdWorker", () => {
  let tmpDir: string;
  let origCwd: string;
  let origLog: typeof console.log;
  let origError: typeof console.error;
  let origWarn: typeof console.warn;
  let origExit: typeof process.exit;
  let logOutput: string[];
  let errorOutput: string[];
  let warnOutput: string[];
  let exitCodes: number[];
  let origPath: string | undefined;
  let origCmuxSurface: string | undefined;
  let origCmuxLog: string | undefined;
  let origApexTestRoot: string | undefined;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    origCwd = process.cwd();
    origPath = process.env.PATH;
    origCmuxSurface = process.env.CMUX_SURFACE;
    origCmuxLog = process.env.CMUX_LOG;
    origApexTestRoot = process.env.APEX_TEST_ROOT;
    process.chdir(tmpDir);

    // Initialize as git repo (with config for CI where no global gitconfig exists)
    spawnSync("git", ["init"], { cwd: tmpDir });
    spawnSync("git", ["-C", tmpDir, "config", "user.name", "test"]);
    spawnSync("git", ["-C", tmpDir, "config", "user.email", "test@test.com"]);
    spawnSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: tmpDir });

    logOutput = [];
    errorOutput = [];
    warnOutput = [];
    exitCodes = [];
    origLog = console.log;
    origError = console.error;
    origWarn = console.warn;
    origExit = process.exit;
    console.log = (...args: any[]) => { logOutput.push(args.map(String).join(" ")); };
    console.error = (...args: any[]) => { errorOutput.push(args.map(String).join(" ")); };
    console.warn = (...args: any[]) => { warnOutput.push(args.map(String).join(" ")); };
    process.exit = ((code?: number) => {
      exitCodes.push(code ?? 0);
      throw new Error(`process.exit(${code})`);
    }) as any;
  });

  afterEach(() => {
    process.chdir(origCwd);
    process.env.PATH = origPath;
    if (origCmuxSurface === undefined) {
      delete process.env.CMUX_SURFACE;
    } else {
      process.env.CMUX_SURFACE = origCmuxSurface;
    }
    if (origCmuxLog === undefined) {
      delete process.env.CMUX_LOG;
    } else {
      process.env.CMUX_LOG = origCmuxLog;
    }
    if (origApexTestRoot === undefined) {
      delete process.env.APEX_TEST_ROOT;
    } else {
      process.env.APEX_TEST_ROOT = origApexTestRoot;
    }
    console.log = origLog;
    console.error = origError;
    console.warn = origWarn;
    process.exit = origExit;
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  // --- Help text ---

  describe("help", () => {
    it("prints usage when no subcommand given", async () => {
      const { cmdWorker } = await import("../../src/commands/worker.js");
      try {
        await cmdWorker([]);
      } catch {}
      const output = logOutput.join("\n");
      assert.ok(output.includes("worker") || output.includes("Worker"));
      assert.ok(output.includes("spawn"));
      assert.ok(output.includes("kill"));
    });

    it("prints usage for 'help' subcommand", async () => {
      const { cmdWorker } = await import("../../src/commands/worker.js");
      try {
        await cmdWorker(["help"]);
      } catch {}
      const output = logOutput.join("\n");
      assert.ok(output.includes("spawn"));
      assert.ok(output.includes("kill"));
    });
  });

  // --- Agent resolution priority ---

  describe("resolveAgent", () => {
    it("CLI --agent flag takes highest priority", async () => {
      const { resolveAgent } = await import("../../src/commands/worker.js");
      const task = { adapter: "gemini" } as any;
      assert.strictEqual(await resolveAgent(["--agent", "codex"], task), "codex");
    });

    it("falls back to task.adapter when no CLI flag", async () => {
      const { resolveAgent } = await import("../../src/commands/worker.js");
      const task = { adapter: "gemini" } as any;
      assert.strictEqual(await resolveAgent([], task), "gemini");
    });

    it("defaults to 'claude' when neither CLI nor task specifies", async () => {
      const { resolveAgent } = await import("../../src/commands/worker.js");
      const task = {} as any;
      assert.strictEqual(await resolveAgent([], task), "claude");
    });

    it("uses task.agent when set (priority 2)", async () => {
      const { resolveAgent } = await import("../../src/commands/worker.js");
      const task = { agent: "gemini", adapter: "codex" } as any;
      assert.strictEqual(await resolveAgent([], task), "gemini");
    });
  });

  describe("buildWorkerKickoffMessage", () => {
    it("asks post-create-send agents to read the protocol file", async () => {
      const { buildWorkerKickoffMessage } = await import("../../src/commands/worker.js");
      const { BUILTIN_ADAPTERS } = await import("../../src/worker/agent-adapter.js");

      const message = buildWorkerKickoffMessage(
        BUILTIN_ADAPTERS.codex,
        ".apex-manager/workers/T1/worker-protocol.md",
      );

      assert.ok(message?.includes("Read the file .apex-manager/workers/T1/worker-protocol.md"));
    });

    it("kicks off system-prompt-file agents so they start immediately", async () => {
      const { buildWorkerKickoffMessage } = await import("../../src/commands/worker.js");
      const { BUILTIN_ADAPTERS } = await import("../../src/worker/agent-adapter.js");

      const message = buildWorkerKickoffMessage(
        BUILTIN_ADAPTERS.claude,
        ".apex-manager/workers/T1/worker-protocol.md",
      );

      assert.ok(message?.includes("already loaded"));
      assert.ok(message?.includes("Execute it immediately"));
    });
  });

  // --- spawn --dry-run ---

  describe("spawn --dry-run", () => {
    it("generates protocol file and prints without creating terminal window", async () => {
      const task = {
        id: "T1",
        title: "Build auth API",
        description: "Implement JWT authentication.\n\nAcceptance Criteria:\n- Login endpoint works",
        status: "assigned",
        depends_on: [],
        blocked_by: [],
        evidence: [],
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      };
      writeTasksJson(tmpDir, [task]);

      const { cmdWorker } = await import("../../src/commands/worker.js");
      try {
        await cmdWorker(["spawn", "T1", "--dry-run"]);
      } catch {}

      // Should NOT have called process.exit(1)
      const exitOnes = exitCodes.filter(c => c === 1);
      assert.strictEqual(exitOnes.length, 0);

      // Protocol file should exist in the worktree
      const protocolPath = join(tmpDir, ".apex-manager", "worktrees", "T1", ".apex-manager", "workers", "T1", "worker-protocol.md");
      if (existsSync(protocolPath)) {
        const content = readFileSync(protocolPath, "utf-8");
        assert.ok(content.includes("T1"));
        assert.ok(content.includes("Build auth API"));
      }

      const controlProtocolPath = join(tmpDir, ".apex-manager", "workers", "T1", "worker-protocol.md");
      assert.ok(existsSync(controlProtocolPath));

      // Console output should include the protocol or dry-run indication
      const output = logOutput.join("\n");
      assert.ok(output.includes("dry-run"));
    });

    it("passes task.protocol through to the protocol builder", async () => {
      const task = {
        id: "T1",
        title: "Build auth API",
        description: "Implement JWT authentication.\n\nAcceptance Criteria:\n- Login endpoint works",
        status: "assigned",
        depends_on: [],
        blocked_by: [],
        evidence: [],
        protocol: "definitely-missing-skill",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      };
      writeTasksJson(tmpDir, [task]);

      const { cmdWorker } = await import("../../src/commands/worker.js");
      try {
        await cmdWorker(["spawn", "T1", "--dry-run"]);
      } catch {}

      const protocolPath = join(tmpDir, ".apex-manager", "worktrees", "T1", ".apex-manager", "workers", "T1", "worker-protocol.md");
      const content = readFileSync(protocolPath, "utf-8");
      assert.ok(content.includes("definitely-missing-skill"));
    });

    it("warns and falls back to shared project-root execution outside git repositories", async () => {
      const nonGitDir = makeTmpDir();
      writeTasksJson(nonGitDir, [{
        id: "T1",
        title: "Loose repo task",
        description: "Run without git isolation.",
        status: "assigned",
        depends_on: [],
        blocked_by: [],
        evidence: [],
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      }]);

      process.chdir(nonGitDir);

      const { cmdWorker } = await import("../../src/commands/worker.js");
      try {
        await cmdWorker(["spawn", "T1", "--dry-run"]);
      } catch {}

      const warnText = warnOutput.concat(errorOutput, logOutput).join("\n");
      assert.ok(warnText.includes("current directory is not a git repository"));
      assert.ok(warnText.includes("Isolation: project-root"));

      const controlProtocolPath = join(nonGitDir, ".apex-manager", "workers", "T1", "worker-protocol.md");
      assert.ok(existsSync(controlProtocolPath));

      rmSync(nonGitDir, { recursive: true, force: true });
    });

    it("rejects unmet dependencies unless forced", async () => {
      writeTasksJson(tmpDir, [
        {
          id: "T1",
          title: "Dependency",
          description: "dep",
          status: "open",
          depends_on: [],
          blocked_by: [],
          evidence: [],
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        },
        {
          id: "T2",
          title: "Dependent",
          description: "depends on T1",
          status: "open",
          depends_on: ["T1"],
          blocked_by: [],
          evidence: [],
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        },
      ]);

      const { cmdWorker } = await import("../../src/commands/worker.js");
      await assert.rejects(() => cmdWorker(["spawn", "T2", "--dry-run"]), /process\.exit\(1\)/);

      assert.ok(errorOutput.join("\n").includes("unmet dependencies T1"));
    });

    it("parses task id after --protocol value", async () => {
      writeTasksJson(tmpDir, [{
        id: "T1",
        title: "Protocol task",
        description: "task",
        status: "open",
        depends_on: [],
        blocked_by: [],
        evidence: [],
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      }]);

      const { cmdWorker } = await import("../../src/commands/worker.js");
      await cmdWorker(["spawn", "--protocol", "missing-skill", "T1", "--dry-run"]);

      assert.ok(logOutput.join("\n").includes("Worker Agent"));
      assert.strictEqual(errorOutput.join("\n"), "");
    });
  });

  describe("spawn launch verification", () => {
    it("requires real worker activity before reporting spawn success", async () => {
      const task = {
        id: "T1",
        title: "Launch verified task",
        description: "Worker should update status before spawn is accepted.",
        status: "assigned",
        depends_on: [],
        blocked_by: [],
        evidence: [],
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      };
      writeTasksJson(tmpDir, [task]);

      const binDir = join(tmpDir, "bin");
      mkdirSync(binDir, { recursive: true });
      const logPath = join(tmpDir, "cmux.log");
      writeFileSync(join(binDir, "codex"), `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "codex test"
  exit 0
fi
exit 0
`);
      writeFileSync(join(binDir, "cmux"), `#!/bin/sh
echo "$@" >> "$CMUX_LOG"
case "$1" in
  new-split)
    echo "surface-1"
    exit 0
    ;;
  send)
    if printf '%s\n' "$@" | grep -q "Read the file .apex-manager/workers/T1/worker-protocol.md"; then
      mkdir -p "$APEX_TEST_ROOT/.apex-manager/workers/T1"
      printf '{\n  "stage": "executing",\n  "progress": "kickoff",\n  "last_activity": "2026-01-01T00:00:00Z"\n}\n' > "$APEX_TEST_ROOT/.apex-manager/workers/T1/status.json"
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
      chmodSync(join(binDir, "codex"), 0o755);
      chmodSync(join(binDir, "cmux"), 0o755);

      process.env.PATH = `${binDir}:${origPath ?? ""}`;
      process.env.CMUX_SURFACE = "surface-plan";
      process.env.CMUX_LOG = logPath;
      process.env.APEX_TEST_ROOT = tmpDir;

      const { cmdWorker } = await import("../../src/commands/worker.js");
      await cmdWorker(["spawn", "T1", "--agent", "codex"]);

      const meta = JSON.parse(readFileSync(join(tmpDir, ".apex-manager", "workers", "T1", "meta.json"), "utf-8"));
      assert.strictEqual(meta.launch_verification.state, "verified");
      assert.strictEqual(meta.launch_verification.action_signal, "status_updated");
      assert.strictEqual(meta.isolation_mode, "git-worktree");

      const statusPath = join(tmpDir, ".apex-manager", "workers", "T1", "status.json");
      assert.ok(existsSync(statusPath));

      const protocolPath = join(tmpDir, ".apex-manager", "workers", "T1", "worker-protocol.md");
      assert.ok(existsSync(protocolPath));

      const output = logOutput.join("\n");
      assert.ok(output.includes("[smoke] T1: status_updated"));

      const cmuxLog = readFileSync(logPath, "utf-8");
      assert.ok(cmuxLog.includes("send surface-1 cd"));
      assert.ok(cmuxLog.includes("send-key surface-1 enter"));
      assert.ok(cmuxLog.includes("send surface-1 Read the file .apex-manager/workers/T1/worker-protocol.md"));
    });

    it("does not overwrite a task claim written during launch verification", async () => {
      const task = {
        id: "T1",
        title: "Claim race task",
        description: "Worker should claim during smoke.",
        status: "assigned",
        depends_on: [],
        blocked_by: [],
        evidence: [],
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      };
      writeTasksJson(tmpDir, [task]);

      const binDir = join(tmpDir, "bin");
      mkdirSync(binDir, { recursive: true });
      writeFileSync(join(binDir, "codex"), `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "codex test"
fi
exit 0
`);
      writeFileSync(join(binDir, "cmux"), `#!/bin/sh
case "$1" in
  new-split)
    echo "surface-1"
    exit 0
    ;;
  send)
    if printf '%s\n' "$@" | grep -q "Read the file .apex-manager/workers/T1/worker-protocol.md"; then
      mkdir -p "$APEX_TEST_ROOT/.apex-manager/workers/T1"
      printf '{ "task_id": "T1", "stage": "executing", "progress": "claimed", "last_activity": "2026-01-01T00:00:00Z", "errors": [] }' > "$APEX_TEST_ROOT/.apex-manager/workers/T1/status.json"
      cat > "$APEX_TEST_ROOT/.apex-manager/tasks.json" <<'JSON'
{
  "tasks": [
    {
      "id": "T1",
      "title": "Claim race task",
      "description": "Worker should claim during smoke.",
      "status": "in_progress",
      "depends_on": [],
      "blocked_by": [],
      "evidence": [],
      "claimed_by": "T1",
      "claimed_at": "2026-01-01T00:00:01Z",
      "created_at": "2026-01-01T00:00:00Z",
      "updated_at": "2026-01-01T00:00:01Z"
    }
  ],
  "next_id": 2
}
JSON
    fi
    exit 0
    ;;
  send-key|rename-tab|validate-surface|read-screen)
    [ "$1" = "read-screen" ] && echo '$ ready'
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`);
      chmodSync(join(binDir, "codex"), 0o755);
      chmodSync(join(binDir, "cmux"), 0o755);
      process.env.PATH = `${binDir}:${origPath ?? ""}`;
      process.env.CMUX_SURFACE = "surface-plan";
      process.env.APEX_TEST_ROOT = tmpDir;

      const { cmdWorker } = await import("../../src/commands/worker.js");
      await cmdWorker(["spawn", "T1", "--agent", "codex"]);

      const store = JSON.parse(readFileSync(join(tmpDir, ".apex-manager", "tasks.json"), "utf-8"));
      assert.strictEqual(store.tasks[0].status, "in_progress");
      assert.strictEqual(store.tasks[0].claimed_by, "T1");
    });
  });

  // --- kill with missing meta.json ---

  describe("kill", () => {
    it("handles missing meta.json gracefully", async () => {
      const { cmdWorker } = await import("../../src/commands/worker.js");
      try {
        await cmdWorker(["kill", "T99"]);
      } catch (e: any) {
        // Should exit with error about missing worker
        assert.ok(e.message.includes("process.exit(1)"));
      }
      const output = errorOutput.join("\n");
      assert.ok(output.includes("T99"));
    });

    it("cleans up worker directory when meta.json exists", async () => {
      const meta = {
        task_id: "T2",
        window_handle: null,
        worktree_path: ".apex-manager/worktrees/T2",
        branch: "apex-mgr/T2",
        started_at: "2026-01-01T00:00:00Z",
        agent: "claude",
      };
      writeWorkerMeta(tmpDir, "T2", meta);

      const { cmdWorker } = await import("../../src/commands/worker.js");
      try {
        await cmdWorker(["kill", "T2"]);
      } catch {}

      // Worker directory should be removed
      assert.strictEqual(existsSync(join(tmpDir, ".apex-manager", "workers", "T2")), false);
    });

    it("refuses to discard a dirty worktree without --force", async () => {
      const branch = "apex-mgr/T3";
      spawnSync("git", ["worktree", "add", ".apex-manager/worktrees/T3", "-b", branch], { cwd: tmpDir });
      writeFileSync(join(tmpDir, ".apex-manager", "worktrees", "T3", "dirty.txt"), "dirty\n");
      writeWorkerMeta(tmpDir, "T3", {
        task_id: "T3",
        window_handle: null,
        worktree_path: ".apex-manager/worktrees/T3",
        branch,
        started_at: "2026-01-01T00:00:00Z",
        agent: "claude",
      });

      const { cmdWorker } = await import("../../src/commands/worker.js");
      await assert.rejects(() => cmdWorker(["kill", "T3"]), /process\.exit\(1\)/);

      assert.ok(errorOutput.join("\n").includes("uncommitted changes"));
      assert.strictEqual(existsSync(join(tmpDir, ".apex-manager", "workers", "T3")), true);
    });
  });

  it("unknown worker subcommands exit non-zero", async () => {
    const { cmdWorker } = await import("../../src/commands/worker.js");
    await assert.rejects(() => cmdWorker(["typo"]), /process\.exit\(1\)/);
    assert.ok(errorOutput.join("\n").includes("Unknown worker subcommand"));
  });

  // --- check ---

  describe("check", () => {
    it("prints status for all known agents", { timeout: 30_000 }, async () => {
      const { cmdWorker } = await import("../../src/commands/worker.js");
      try {
        await cmdWorker(["check"]);
      } catch {}
      const output = logOutput.join("\n");
      assert.ok(output.includes("claude"));
      assert.ok(output.includes("codex"));
      assert.ok(output.includes("gemini"));
      assert.ok(output.includes("opencode"));
    });
  });

  // --- interrupt ---

  describe("interrupt", () => {
    it("errors with usage when no task-id given", async () => {
      const { cmdWorker } = await import("../../src/commands/worker.js");
      try {
        await cmdWorker(["interrupt"]);
      } catch (e: any) {
        assert.ok(e.message.includes("process.exit(1)"));
      }
      const output = errorOutput.join("\n");
      assert.ok(output.includes("Usage"));
    });

    it("errors when worker meta not found", async () => {
      const { cmdWorker } = await import("../../src/commands/worker.js");
      try {
        await cmdWorker(["interrupt", "T99"]);
      } catch (e: any) {
        assert.ok(e.message.includes("process.exit(1)"));
      }
      const output = errorOutput.join("\n");
      assert.ok(output.includes("T99"));
    });

    it("errors when worker has no terminal handle", async () => {
      writeWorkerMeta(tmpDir, "T5", {
        task_id: "T5",
        window_handle: null,
        worktree_path: ".apex-manager/worktrees/T5",
        branch: "apex-mgr/T5",
        started_at: "2026-01-01T00:00:00Z",
        agent: "claude",
      });

      const { cmdWorker } = await import("../../src/commands/worker.js");
      try {
        await cmdWorker(["interrupt", "T5"]);
      } catch (e: any) {
        assert.ok(e.message.includes("process.exit(1)"));
      }
      const output = errorOutput.join("\n");
      assert.ok(output.includes("T5"));
    });
  });

  // --- slugify ---

  describe("toSlug", () => {
    it("converts title to kebab-case slug", async () => {
      const { toSlug } = await import("../../src/commands/worker.js");
      assert.strictEqual(toSlug("Build Auth API"), "build-auth-api");
    });

    it("truncates to 20 characters", async () => {
      const { toSlug } = await import("../../src/commands/worker.js");
      const result = toSlug("This is a very long task title that exceeds the limit");
      assert.ok(result.length <= 20);
    });

    it("removes non-alphanumeric characters", async () => {
      const { toSlug } = await import("../../src/commands/worker.js");
      assert.strictEqual(toSlug("Fix: bug #123 (urgent)"), "fix-bug-123-urgent");
    });
  });
});
