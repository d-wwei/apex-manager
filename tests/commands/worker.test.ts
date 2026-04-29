import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "fs";
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
  let origExit: typeof process.exit;
  let logOutput: string[];
  let errorOutput: string[];
  let exitCodes: number[];

  beforeEach(() => {
    tmpDir = makeTmpDir();
    origCwd = process.cwd();
    process.chdir(tmpDir);

    // Initialize as git repo (with config for CI where no global gitconfig exists)
    spawnSync("git", ["init"], { cwd: tmpDir });
    spawnSync("git", ["-C", tmpDir, "config", "user.name", "test"]);
    spawnSync("git", ["-C", tmpDir, "config", "user.email", "test@test.com"]);
    spawnSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: tmpDir });

    logOutput = [];
    errorOutput = [];
    exitCodes = [];
    origLog = console.log;
    origError = console.error;
    origExit = process.exit;
    console.log = (...args: any[]) => { logOutput.push(args.map(String).join(" ")); };
    console.error = (...args: any[]) => { errorOutput.push(args.map(String).join(" ")); };
    process.exit = ((code?: number) => {
      exitCodes.push(code ?? 0);
      throw new Error(`process.exit(${code})`);
    }) as any;
  });

  afterEach(() => {
    process.chdir(origCwd);
    console.log = origLog;
    console.error = origError;
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
      const protocolPath = join(tmpDir, ".apex-manager", "worktrees", "T1", ".apex-manager", "worker-protocol.md");
      if (existsSync(protocolPath)) {
        const content = readFileSync(protocolPath, "utf-8");
        assert.ok(content.includes("T1"));
        assert.ok(content.includes("Build auth API"));
      }

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

      const protocolPath = join(tmpDir, ".apex-manager", "worktrees", "T1", ".apex-manager", "worker-protocol.md");
      const content = readFileSync(protocolPath, "utf-8");
      assert.ok(content.includes("definitely-missing-skill"));
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
