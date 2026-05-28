import { describe, it } from "node:test";
import assert from "node:assert";
import {
  buildWorkerProtocol,
  agentStartCommand,
  sectionCommunicationForCapabilities,
  type ProtocolBuildOptions,
} from "../../src/worker/protocol-builder.js";
import type { Task } from "../../src/types/task.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "T3",
    title: "Implement auth API",
    description:
      "Build JWT-based authentication with /login, /register, /refresh endpoints.\n" +
      "Acceptance Criteria:\n" +
      "- POST /login returns JWT token\n" +
      "- POST /register creates user\n" +
      "- POST /refresh rotates token",
    status: "in_progress",
    depends_on: ["T1", "T2"],
    blocked_by: [],
    evidence: [],
    attempt: 1,
    created_at: "2026-04-14T00:00:00Z",
    updated_at: "2026-04-14T00:00:00Z",
    ...overrides,
  };
}

function makeOpts(overrides: Partial<ProtocolBuildOptions> = {}): ProtocolBuildOptions {
  return {
    task: makeTask(),
    projectRoot: "/home/user/myproject",
    worktreePath: "/home/user/myproject/.apex-manager/worktrees/T3",
    completedDeps: ["T1", "T2"],
    ...overrides,
  };
}

describe("buildWorkerProtocol", () => {
  it("returns a string starting with the correct heading", () => {
    const md = buildWorkerProtocol(makeOpts());
    assert.ok(md.startsWith("# Apex-Forge Worker Agent") || md.startsWith("# Apex-Manager Worker Agent"));
    assert.ok(md.includes("Task T3"));
  });

  it("includes task information section with title, description, and deps", () => {
    const md = buildWorkerProtocol(makeOpts());
    // Task fields
    assert.ok(md.includes("Implement auth API"));
    assert.ok(md.includes("JWT-based authentication"));
    assert.ok(md.includes("T1, T2"));
  });

  it("includes acceptance criteria from description", () => {
    const md = buildWorkerProtocol(makeOpts());
    assert.ok(md.includes("POST /login returns JWT token"));
    assert.ok(md.includes("POST /register creates user"));
    assert.ok(md.includes("POST /refresh rotates token"));
  });

  it("includes anti-recursion guard", () => {
    const md = buildWorkerProtocol(makeOpts());
    assert.ok(md.includes("Worker Agent"));
    assert.ok(md.includes("不会") || md.includes("do NOT"));
    assert.ok(md.includes("blocked"));
  });

  it("bare-run mode: no work protocol section when no --protocol", () => {
    const md = buildWorkerProtocol(makeOpts());
    assert.ok(!md.includes("## 工作协议"));
    assert.ok(!md.includes("## Work Protocol"));
  });

  it("includes communication protocol section with correct paths", () => {
    const md = buildWorkerProtocol(makeOpts());
    // status.json path
    assert.ok(md.includes("/home/user/myproject/.apex-manager/workers/T3/status.json"));
    assert.ok(!md.includes("/home/user/myproject/.apex/workers/T3/status.json"), "Must not contain .apex/ path");
    // apex commands
    assert.ok(md.includes("apex-manager task claim T3 --by T3"));
    assert.ok(md.includes("apex-manager task complete T3 --by T3"));
    assert.ok(md.includes("apex-manager artifact submit T3 --by T3"));
  });

  it("includes Plan Agent directive check section", () => {
    const md = buildWorkerProtocol(makeOpts());
    assert.ok(md.includes("[PLAN-AGENT]"));
    assert.ok(md.includes("[PLAN-AGENT:INTERRUPT]"));
    assert.ok(md.includes("directive.json"));
    assert.ok(md.includes("escalation.json"));
  });

  it("includes work boundaries section", () => {
    const md = buildWorkerProtocol(makeOpts());
    assert.ok(md.includes("worktree"));
    // Must mention the branch
    assert.ok(md.includes("apex-mgr/T3") || md.includes("apex/T3"));
  });

  it("does NOT include cross-model section by default", () => {
    const md = buildWorkerProtocol(makeOpts());
    assert.ok(!md.includes("## Cross-Model Independent Review") || !md.includes("## 跨模型独立评审"));
  });

  it("includes cross-model section when crossModel=true", () => {
    const md = buildWorkerProtocol(makeOpts({ crossModel: true }));
    assert.ok(md.includes("跨模型") || md.includes("Cross-Model"));
  });

  it("handles task with no dependencies", () => {
    const md = buildWorkerProtocol(
      makeOpts({
        task: makeTask({ depends_on: [] }),
        completedDeps: [],
      }),
    );
    // Should show none or empty
    assert.ok(/Dependencies completed.*none|无/i.test(md));
  });

  it("uses projectRoot for communication paths, not worktreePath", () => {
    const md = buildWorkerProtocol(makeOpts());
    // status.json must point to projectRoot, not worktreePath
    assert.ok(md.includes("/home/user/myproject/.apex-manager/workers/T3/status.json"));
    assert.ok(!md.includes("/home/user/myproject/.apex-manager/worktrees/T3/.apex-manager/workers"));
  });

  it("shell-quotes generated bash paths with spaces and single quotes", () => {
    const projectRoot = "/tmp/apex manager/user's repo";
    const md = buildWorkerProtocol(makeOpts({ projectRoot }));

    assert.ok(md.includes("cd '/tmp/apex manager/user'\\''s repo' && apex-manager task claim T3 --by T3"));
    assert.ok(md.includes("cat > '/tmp/apex manager/user'\\''s repo/.apex-manager/workers/T3/status.json'"));
    assert.ok(md.includes("test -f '/tmp/apex manager/user'\\''s repo/.apex-manager/workers/T3/directive.json'"));
    assert.ok(!md.includes(`cd ${projectRoot} &&`));
  });
});

describe("buildWorkerProtocol — English (lang=en)", () => {
  const enOpts = makeOpts({ agent: "codex" });

  it("generates English task section", () => {
    const md = buildWorkerProtocol(enOpts);
    assert.ok(md.includes("## Your Task"));
    assert.ok(!md.includes("## 你的任务"));
  });

  it("generates English anti-recursion section", () => {
    const md = buildWorkerProtocol(enOpts);
    assert.ok(md.includes("## Worker Boundaries"));
    assert.ok(md.includes("**NOT**"));
    assert.ok(!md.includes("## Worker 边界"));
  });

  it("generates English boundaries section", () => {
    const md = buildWorkerProtocol(enOpts);
    assert.ok(md.includes("## Git Boundaries"));
    assert.ok(!md.includes("## Git 边界"));
  });

  it("generates English communication section with JSON fields", () => {
    const md = buildWorkerProtocol(enOpts);
    assert.ok(md.includes("## Communication Protocol"));
    assert.ok(md.includes('"task_id"'));
    assert.ok(md.includes('"verdict"'));
    assert.ok(md.includes("status.json"));
    assert.ok(md.includes("result.json"));
  });

  it("generates English directive section", () => {
    const md = buildWorkerProtocol(enOpts);
    assert.ok(md.includes("## Plan Agent Communication Protocol"));
    assert.ok(md.includes("[PLAN-AGENT]"));
    assert.ok(md.includes("directive.json"));
  });

  it("generates English cross-model section when enabled", () => {
    const md = buildWorkerProtocol(makeOpts({ agent: "codex", crossModel: true }));
    assert.ok(md.includes("## Cross-Model Independent Review"));
    assert.ok(!md.includes("## 跨模型独立评审"));
  });

  it("still generates Chinese for claude agent", () => {
    const md = buildWorkerProtocol(makeOpts({ agent: "claude" }));
    assert.ok(md.includes("## 你的任务"));
    assert.ok(md.includes("## Worker 边界"));
    assert.ok(md.includes("## 通信协议"));
  });

  it("defaults to Chinese when no agent specified", () => {
    const md = buildWorkerProtocol(makeOpts());
    assert.ok(md.includes("## 你的任务"));
  });
});

describe("agentStartCommand", () => {
  const worktree = "/home/user/myproject/.apex-manager/worktrees/T3";

  it("returns claude command with --append-system-prompt-file", async () => {
    const cmd = await agentStartCommand("claude", worktree);
    assert.ok(cmd.includes("claude"));
    assert.ok(cmd.includes("--append-system-prompt-file"));
    assert.ok(cmd.includes(".apex-manager/workers/T3/worker-protocol.md"));
    assert.ok(cmd.includes(worktree));
  });

  it("returns codex command without default --full-auto", async () => {
    const cmd = await agentStartCommand("codex", worktree);
    assert.ok(cmd.includes("codex"));
    assert.ok(!cmd.includes("--full-auto"));
    assert.ok(cmd.includes("'-a' 'never'"));
    assert.ok(cmd.includes("'-s' 'danger-full-access'"));
    assert.ok(!cmd.includes("exec"), "should not use one-shot exec mode");
    assert.ok(cmd.includes(worktree));
  });

  it("returns gemini command without default --yolo", async () => {
    const cmd = await agentStartCommand("gemini", worktree);
    assert.ok(cmd.includes("gemini"));
    assert.ok(!cmd.includes("--yolo"));
    assert.ok(!cmd.includes("-p"), "should not use one-shot -p flag");
    assert.ok(cmd.includes(worktree));
  });

  it("returns opencode command in interactive mode", async () => {
    const cmd = await agentStartCommand("opencode", worktree);
    assert.ok(cmd.includes("opencode"));
    assert.ok(!cmd.includes("run"), "should not use run subcommand");
    assert.ok(cmd.includes(worktree));
  });

  it("throws for unknown agent instead of falling back", async () => {
    await assert.rejects(
      () => agentStartCommand("unknown-agent", worktree),
      /unknown agent/i,
    );
  });
});

describe("sectionCommunication — capability degradation", () => {
  const fullCaps = {
    canExecuteBash: true,
    canWriteFiles: true,
    canReadFiles: true,
    canRunApexCLI: true,
    preferredLanguage: "en" as const,
    maxPromptBytes: 200_000,
  };
  const fileWriteCaps = { ...fullCaps, canExecuteBash: false, canRunApexCLI: false };
  const minimalCaps = { ...fileWriteCaps, canWriteFiles: false };
  const commOpts = { task: makeTask(), projectRoot: "/proj" };

  it("full bash mode includes heredoc and apex commands", () => {
    const result = sectionCommunicationForCapabilities(commOpts, "en", fullCaps);
    assert.ok(result.includes("cat >"));
    assert.ok(result.includes("APEX_EOF"));
    assert.ok(result.includes("apex-manager task claim"));
    assert.ok(result.includes("apex-manager task complete"));
    assert.ok(result.includes("apex-manager artifact submit"));
  });

  it("file-write mode uses Write instructions, no heredoc", () => {
    const result = sectionCommunicationForCapabilities(commOpts, "en", fileWriteCaps);
    assert.ok(result.includes("Write the following JSON"));
    assert.ok(!result.includes("cat >"));
    assert.ok(result.includes("status.json"));
    assert.ok(result.includes("result.json"));
  });

  it("minimal mode uses Create file, no heredoc, no apex CLI", () => {
    const result = sectionCommunicationForCapabilities(commOpts, "en", minimalCaps);
    assert.ok(result.includes("Create file"));
    assert.ok(!result.includes("cat >"));
    assert.ok(!result.includes("Write the following JSON"));
    assert.ok(!result.includes("apex task submit"));
  });

  it("file-write mode works in Chinese", () => {
    const result = sectionCommunicationForCapabilities(commOpts, "zh", fileWriteCaps);
    assert.ok(result.includes("将以下 JSON 写入"));
    assert.ok(!result.includes("cat >"));
  });

  it("minimal mode works in Chinese", () => {
    const result = sectionCommunicationForCapabilities(commOpts, "zh", minimalCaps);
    assert.ok(result.includes("创建文件"));
    assert.ok(!result.includes("cat >"));
  });

  it("all tiers include task_id and verdict JSON fields", () => {
    for (const caps of [fullCaps, fileWriteCaps, minimalCaps]) {
      const result = sectionCommunicationForCapabilities(commOpts, "en", caps);
      assert.ok(result.includes('"task_id"'));
      assert.ok(result.includes('"verdict"'));
    }
  });

  it("file-write mode includes apex CLI as Run instructions", () => {
    const result = sectionCommunicationForCapabilities(commOpts, "en", fileWriteCaps);
    assert.ok(result.includes("apex-manager task claim"));
    assert.ok(result.includes("apex-manager task complete"));
    assert.ok(result.includes("apex-manager task block"));
    assert.ok(result.includes("apex-manager artifact submit"));
  });

  it("minimal mode excludes all apex CLI commands", () => {
    const result = sectionCommunicationForCapabilities(commOpts, "en", minimalCaps);
    assert.ok(!result.includes("apex-manager task claim"));
    assert.ok(!result.includes("apex-manager task complete"));
    assert.ok(!result.includes("apex-manager task block"));
    assert.ok(!result.includes("apex-manager artifact submit"));
  });
});
