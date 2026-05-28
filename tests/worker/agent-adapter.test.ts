import { describe, it } from "node:test";
import assert from "node:assert";
import {
  BUILTIN_ADAPTERS,
  resolveAdapter,
  resolveAdapterWithConfig,
  type AgentAdapter,
  type AgentCapabilities,
  type ProtocolInjectionMethod,
  type StartOpts,
} from "../../src/worker/agent-adapter.js";
import type { AdaptersMap } from "../../src/types/config.js";

// ── BUILTIN_ADAPTERS registry ────────────────────────────────────────

describe("BUILTIN_ADAPTERS", () => {
  it("has exactly 5 entries: claude, codex, ft-claude, gemini, opencode", () => {
    const keys = Object.keys(BUILTIN_ADAPTERS).sort();
    assert.deepStrictEqual(keys, ["claude", "codex", "ft-claude", "gemini", "opencode"]);
  });

  it("every adapter has all required fields", () => {
    for (const [name, adapter] of Object.entries(BUILTIN_ADAPTERS)) {
      assert.strictEqual(adapter.name, name);
      assert.strictEqual(typeof adapter.binary, "string");
      assert.strictEqual(typeof adapter.buildStartCommand, "function");
      assert.ok(adapter.protocolInjection !== undefined);
      assert.ok(adapter.capabilities !== undefined);
      assert.ok(Array.isArray(adapter.interruptKeys));
      assert.ok(adapter.interruptKeys.length > 0);
      assert.strictEqual(typeof adapter.skipProxyEnv, "boolean");
    }
  });
});

// ── buildStartCommand per agent ──────────────────────────────────────

describe("buildStartCommand", () => {
  const baseOpts: StartOpts = {
    worktreePath: "/tmp/wt",
    protocolPath: "/tmp/wt/.apex-manager/worker-protocol.md",
  };

  it("claude: uses --append-system-prompt-file", () => {
    const cmd = BUILTIN_ADAPTERS.claude.buildStartCommand(baseOpts);
    assert.ok(cmd.includes("claude"));
    assert.ok(cmd.includes("--append-system-prompt-file"));
    assert.ok(cmd.includes(baseOpts.protocolPath));
  });

  it("codex: starts interactive mode without auto-approval by default", () => {
    const cmd = BUILTIN_ADAPTERS.codex.buildStartCommand(baseOpts);
    assert.ok(cmd.includes("codex"));
    assert.ok(!cmd.includes("--full-auto"));
    assert.ok(cmd.includes("'-a' 'never'"));
    assert.ok(cmd.includes("'-s' 'danger-full-access'"));
    // Interactive mode: no exec subcommand, no cat pipe
    assert.ok(!cmd.includes("exec"));
  });

  it("gemini: starts interactive mode without auto-approval by default", () => {
    const cmd = BUILTIN_ADAPTERS.gemini.buildStartCommand(baseOpts);
    assert.ok(cmd.includes("gemini"));
    assert.ok(!cmd.includes("--yolo"));
    // Interactive mode: no -p flag
    assert.ok(!cmd.includes("-p"));
  });

  it("opencode: starts interactive mode", () => {
    const cmd = BUILTIN_ADAPTERS.opencode.buildStartCommand(baseOpts);
    assert.ok(cmd.includes("opencode"));
    // Interactive mode: no run subcommand, no -p
    assert.ok(!cmd.includes("run"));
    assert.ok(!cmd.includes("-p"));
  });

  it("all commands include cd to worktreePath", () => {
    for (const adapter of Object.values(BUILTIN_ADAPTERS)) {
      const cmd = adapter.buildStartCommand(baseOpts);
      assert.ok(cmd.includes(`cd '${baseOpts.worktreePath}'`));
    }
  });

  it("model override is passed when provided", () => {
    const opts: StartOpts = { ...baseOpts, model: "o3" };
    const cmd = BUILTIN_ADAPTERS.codex.buildStartCommand(opts);
    assert.ok(cmd.includes("o3"));
  });

  it("auto-approval flags require explicit env opt-in", () => {
    const prev = process.env.APEX_MANAGER_ALLOW_AUTO_APPROVAL;
    process.env.APEX_MANAGER_ALLOW_AUTO_APPROVAL = "1";
    try {
      const cmd = BUILTIN_ADAPTERS.codex.buildStartCommand(baseOpts);
      assert.ok(cmd.includes("--full-auto"));
    } finally {
      if (prev === undefined) delete process.env.APEX_MANAGER_ALLOW_AUTO_APPROVAL;
      else process.env.APEX_MANAGER_ALLOW_AUTO_APPROVAL = prev;
    }
  });
});

// ── Capabilities ─────────────────────────────────────────────────────

describe("capabilities", () => {
  it("claude preferredLanguage is zh", () => {
    assert.strictEqual(BUILTIN_ADAPTERS.claude.capabilities.preferredLanguage, "zh");
  });

  it("codex, gemini, opencode preferredLanguage is en", () => {
    assert.strictEqual(BUILTIN_ADAPTERS.codex.capabilities.preferredLanguage, "en");
    assert.strictEqual(BUILTIN_ADAPTERS.gemini.capabilities.preferredLanguage, "en");
    assert.strictEqual(BUILTIN_ADAPTERS.opencode.capabilities.preferredLanguage, "en");
  });

  it("all adapters canExecuteBash", () => {
    for (const adapter of Object.values(BUILTIN_ADAPTERS)) {
      assert.strictEqual(adapter.capabilities.canExecuteBash, true);
    }
  });

  it("all adapters canWriteFiles and canReadFiles", () => {
    for (const adapter of Object.values(BUILTIN_ADAPTERS)) {
      assert.strictEqual(adapter.capabilities.canWriteFiles, true);
      assert.strictEqual(adapter.capabilities.canReadFiles, true);
    }
  });

  it("claude maxPromptBytes is 1MB", () => {
    assert.strictEqual(BUILTIN_ADAPTERS.claude.capabilities.maxPromptBytes, 1_000_000);
  });

  it("codex, gemini, opencode maxPromptBytes is 200KB", () => {
    assert.strictEqual(BUILTIN_ADAPTERS.codex.capabilities.maxPromptBytes, 200_000);
    assert.strictEqual(BUILTIN_ADAPTERS.gemini.capabilities.maxPromptBytes, 200_000);
    assert.strictEqual(BUILTIN_ADAPTERS.opencode.capabilities.maxPromptBytes, 200_000);
  });
});

// ── interruptKeys ────────────────────────────────────────────────────

describe("interruptKeys", () => {
  it("claude uses Escape", () => {
    assert.deepStrictEqual(BUILTIN_ADAPTERS.claude.interruptKeys, ["Escape"]);
  });

  it("codex uses C-c", () => {
    assert.deepStrictEqual(BUILTIN_ADAPTERS.codex.interruptKeys, ["C-c"]);
  });

  it("gemini uses C-c", () => {
    assert.deepStrictEqual(BUILTIN_ADAPTERS.gemini.interruptKeys, ["C-c"]);
  });

  it("opencode uses C-c", () => {
    assert.deepStrictEqual(BUILTIN_ADAPTERS.opencode.interruptKeys, ["C-c"]);
  });
});

// ── protocolInjection ────────────────────────────────────────────────

describe("protocolInjection", () => {
  it("claude uses system-prompt-file with flag", () => {
    assert.deepStrictEqual(BUILTIN_ADAPTERS.claude.protocolInjection, {
      type: "system-prompt-file",
      flag: "--append-system-prompt-file",
    });
  });

  it("codex uses stdin", () => {
    assert.deepStrictEqual(BUILTIN_ADAPTERS.codex.protocolInjection, { type: "stdin" });
  });

  it("gemini uses stdin (post-create send)", () => {
    assert.deepStrictEqual(BUILTIN_ADAPTERS.gemini.protocolInjection, { type: "stdin" });
  });

  it("opencode uses stdin (post-create send)", () => {
    assert.deepStrictEqual(BUILTIN_ADAPTERS.opencode.protocolInjection, { type: "stdin" });
  });
});

// ── resolveAdapter (convenience, builtin-only) ───────────────────────

describe("resolveAdapter", () => {
  it("returns builtin for known agent", () => {
    const adapter = resolveAdapter("claude");
    assert.strictEqual(adapter.name, "claude");
    assert.strictEqual(adapter.binary, "claude");
  });

  it("returns builtin for each known agent", () => {
    for (const name of ["claude", "codex", "gemini", "opencode"]) {
      const adapter = resolveAdapter(name);
      assert.strictEqual(adapter.name, name);
    }
  });

  it("throws for unknown agent", () => {
    assert.throws(() => resolveAdapter("unknown-agent"));
  });
});

// ── resolveAdapterWithConfig ─────────────────────────────────────────

describe("resolveAdapterWithConfig", () => {
  it("config override wins over builtin", () => {
    const configAdapters: AdaptersMap = {
      claude: { command: "my-claude", args: ["--custom-flag"] },
    };
    const adapter = resolveAdapterWithConfig("claude", configAdapters);
    // Config override merges with builtin, so capabilities stay from builtin
    assert.strictEqual(adapter.capabilities.preferredLanguage, "zh");
    // But the start command uses config's command
    const cmd = adapter.buildStartCommand({
      worktreePath: "/tmp/wt",
      protocolPath: "/tmp/wt/.apex-manager/worker-protocol.md",
    });
    assert.ok(cmd.includes("my-claude"));
    assert.ok(cmd.includes("--custom-flag"));
  });

  it("shell-quotes config command tokens instead of executing shell metacharacters", () => {
    const configAdapters: AdaptersMap = {
      evil: {
        command: "codex; touch /tmp/pwned",
        args: ["--flag", "value with spaces"],
        auto_approval_flag: "--danger; rm -rf /",
      },
    };
    const prev = process.env.APEX_MANAGER_ALLOW_AUTO_APPROVAL;
    process.env.APEX_MANAGER_ALLOW_AUTO_APPROVAL = "1";
    const adapter = resolveAdapterWithConfig("evil", configAdapters);
    let cmd: string;
    try {
      cmd = adapter.buildStartCommand({
        worktreePath: "/tmp/work tree",
        protocolPath: "/tmp/work tree/.apex-manager/workers/T1/worker-protocol.md",
      });
    } finally {
      if (prev === undefined) delete process.env.APEX_MANAGER_ALLOW_AUTO_APPROVAL;
      else process.env.APEX_MANAGER_ALLOW_AUTO_APPROVAL = prev;
    }

    assert.ok(cmd.includes("'codex; touch /tmp/pwned'"));
    assert.ok(cmd.includes("'value with spaces'"));
    assert.ok(cmd.includes("'--danger; rm -rf /'"));
    assert.ok(!cmd.includes("codex; touch /tmp/pwned --flag"));
  });

  it("builtin returned when no config override", () => {
    const configAdapters: AdaptersMap = {};
    const adapter = resolveAdapterWithConfig("claude", configAdapters);
    assert.strictEqual(adapter.name, "claude");
    assert.strictEqual(adapter.capabilities.preferredLanguage, "zh");
  });

  it("builtin returned when configAdapters is undefined", () => {
    const adapter = resolveAdapterWithConfig("claude", undefined);
    assert.strictEqual(adapter.name, "claude");
  });

  it("config enables custom agent with default capabilities", () => {
    const configAdapters: AdaptersMap = {
      "my-custom-agent": { command: "my-agent-bin", args: ["--go"] },
    };
    const adapter = resolveAdapterWithConfig("my-custom-agent", configAdapters);
    assert.strictEqual(adapter.name, "my-custom-agent");
    const cmd = adapter.buildStartCommand({
      worktreePath: "/tmp/wt",
      protocolPath: "/tmp/wt/.apex-manager/worker-protocol.md",
    });
    assert.ok(cmd.includes("my-agent-bin"));
    assert.ok(cmd.includes("--go"));
    // Default capabilities for unknown custom agents
    assert.strictEqual(adapter.capabilities.canExecuteBash, true);
  });

  it("error for unknown agent with no config", () => {
    assert.throws(() => resolveAdapterWithConfig("unknown-agent", undefined));
    assert.throws(() => resolveAdapterWithConfig("unknown-agent", {}));
  });
});
