import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { spawnSync } from "child_process";

const itDarwinOnly = process.platform === "darwin" ? it : it.skip;

describe("Money-Come-To-Eli war room", () => {
  let tmpDir: string;
  let origCwd: string;
  let repoRoot: string;
  const origEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = join(tmpdir(), `am-war-room-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    origCwd = process.cwd();
    repoRoot = origCwd;
    mkdirSync(tmpDir, { recursive: true });
    process.chdir(tmpDir);

    mkdirSync(join(tmpDir, ".apex-manager", "artifacts"), { recursive: true });
    mkdirSync(join(tmpDir, ".apex-manager", "messages"), { recursive: true });
    mkdirSync(join(tmpDir, ".apex-manager", "notifications"), { recursive: true });
    mkdirSync(join(tmpDir, ".apex-manager", "workers", "T1"), { recursive: true });

    writeFileSync(join(tmpDir, ".apex-manager", "tasks.json"), JSON.stringify({
      tasks: [
        {
          id: "T1",
          title: "Build war room",
          description: "Hidden dashboard",
          status: "in_progress",
          depends_on: [],
          blocked_by: [],
          evidence: [],
          created_at: "2026-04-29T00:00:00.000Z",
          updated_at: "2026-04-29T00:00:00.000Z",
        },
        {
          id: "T2",
          title: "Review docs",
          description: "Polish readme",
          status: "blocked",
          depends_on: [],
          blocked_by: [],
          evidence: [],
          created_at: "2026-04-29T00:00:00.000Z",
          updated_at: "2026-04-29T00:00:00.000Z",
        },
      ],
      next_id: 3,
    }, null, 2));

    writeFileSync(join(tmpDir, ".apex-manager", "artifacts", "index.json"), JSON.stringify({
      artifacts: [{ id: "ART-1", task_id: "T1" }],
      next_id: 2,
    }, null, 2));

    writeFileSync(join(tmpDir, ".apex-manager", "messages", "index.json"), JSON.stringify({
      messages: [
        {
          id: "MSG-1",
          from: "manager",
          to: "T1",
          kind: "directive",
          priority: "normal",
          ack_required: false,
          body: "Keep going",
          delivery_status: "pending",
          created_at: "2026-04-29T00:00:00.000Z",
        },
      ],
      next_id: 2,
    }, null, 2));

    writeFileSync(join(tmpDir, ".apex-manager", "events.jsonl"), [
      JSON.stringify({ type: "task.created", timestamp: "2026-04-29T00:00:00.000Z" }),
      JSON.stringify({ type: "worker.registered", timestamp: "2026-04-29T00:05:00.000Z" }),
    ].join("\n") + "\n");

    writeFileSync(join(tmpDir, ".apex-manager", "notifications", "001-test.json"), JSON.stringify({
      message: "Worker T1 needs judgment",
      created_at: "2026-04-29T00:06:00.000Z",
      read: false,
    }, null, 2));

    writeFileSync(join(tmpDir, ".apex-manager", "workers", "T1", "meta.json"), JSON.stringify({
      task_id: "T1",
      window_handle: null,
      worktree_path: ".apex-manager/worktrees/T1",
      branch: "apex-mgr/T1",
      started_at: new Date().toISOString(),
      agent: "codex",
      isolation_mode: "git-worktree",
      launch_verification: { state: "verified" },
    }, null, 2));
  });

  afterEach(() => {
    process.chdir(origCwd);
    process.env = { ...origEnv };
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it("formats the easter egg banner in both languages", async () => {
    const { formatMoneyComeToEliBanner } = await import("../../src/orch/war-room.js");
    const banner = formatMoneyComeToEliBanner();

    assert.ok(banner.includes("Money has accepted the assignment: come to Eli."));
    assert.ok(banner.includes("Fortune Buff +1 activated."));
    assert.ok(banner.includes("隐藏彩蛋已触发：Eli 财运 +1"));
    assert.ok(banner.includes("今日好运 Buff 已生效"));
  });

  it("builds the foreground command with the repo-local launcher", async () => {
    const { moneyComeToEliForegroundCommand } = await import("../../src/orch/war-room.js");
    const command = moneyComeToEliForegroundCommand(tmpDir);

    assert.ok(command.includes("bin/apex-manager.sh"));
    assert.ok(command.includes("orch Money-Come-To-Eli --foreground"));
    assert.ok(command.includes(tmpDir));
  });

  it("describes watch targets including worker directories", async () => {
    const { describeWarRoomWatchLayout } = await import("../../src/orch/war-room.js");
    const layout = describeWarRoomWatchLayout(tmpDir);

    assert.ok(layout.baseTargets.some((target: string) => target.endsWith(".apex-manager/tasks.json")));
    assert.ok(layout.baseTargets.some((target: string) => target.endsWith(".apex-manager/workers")));
    assert.ok(layout.workerTargets.some((target: string) => target.endsWith(".apex-manager/workers/T1")));
  });

  it("runs the skill launcher script against the repo-local CLI", () => {
    const scriptPath = join(repoRoot, "skills", "money-come-to-eli", "scripts", "launch.sh");
    const result = spawnSync("bash", [scriptPath, "--once"], {
      cwd: tmpDir,
      encoding: "utf-8",
    });

    assert.strictEqual(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes("MONEY-COME-TO-ELI // WAR ROOM"));
  });

  itDarwinOnly("launches detached by default and keeps the current terminal free", () => {
    const binDir = join(tmpDir, "fake-bin");
    const logPath = join(tmpDir, "osascript.log");
    mkdirSync(binDir, { recursive: true });

    const osascriptStub = `#!/bin/sh
echo "$@" >> "$MCTE_OSASCRIPT_LOG"
exit 0
`;
    const osascriptPath = join(binDir, "osascript");
    writeFileSync(osascriptPath, osascriptStub);
    chmodSync(osascriptPath, 0o755);

    const cliPath = join(repoRoot, "src", "cli.ts");
    const tsxLoaderPath = join(repoRoot, "node_modules", "tsx", "dist", "loader.mjs");
    const result = spawnSync("node", ["--import", tsxLoaderPath, cliPath, "orch", "Money-Come-To-Eli"], {
      cwd: tmpDir,
      encoding: "utf-8",
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        TERM_PROGRAM: "Apple_Terminal",
        MCTE_OSASCRIPT_LOG: logPath,
      },
    });

    assert.strictEqual(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes("launched in a separate"));
    assert.ok(result.stdout.includes("Your current terminal stays free."));

    const log = readFileSync(logPath, "utf-8");
    assert.ok(log.includes('tell application "Terminal" to do script'));
    assert.ok(log.includes("bin/apex-manager.sh"));
  });

  it("renders a one-shot war room screen through the orch command", async () => {
    const cliPath = join(repoRoot, "src", "cli.ts");
    const tsxLoaderPath = join(repoRoot, "node_modules", "tsx", "dist", "loader.mjs");
    const result = spawnSync("node", ["--import", tsxLoaderPath, cliPath, "orch", "Money-Come-To-Eli", "--once"], {
      cwd: tmpDir,
      encoding: "utf-8",
    });

    assert.strictEqual(result.status, 0, result.stderr);
    const combined = `${result.stdout}\n${result.stderr}`;
    assert.ok(combined.includes("Money has accepted the assignment: come to Eli."));
    assert.ok(combined.includes("MONEY-COME-TO-ELI // WAR ROOM"));
    assert.ok(combined.includes("Fortune Buff +1 active"));
    assert.ok(combined.includes("Build war room"));
    assert.ok(combined.includes("Worker T1 needs judgment"));
    assert.ok(combined.includes("pending_messages=1"));
  });
});
