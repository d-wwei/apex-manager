#!/usr/bin/env node

const VERSION = "0.1.1";

function printUsage(): void {
  console.log(`
apex-manager v${VERSION} — Multi-agent orchestrator

Usage:
  apex-manager <command> [options]

Commands:
  worker   Manage parallel worker agents (spawn, kill, list, status, merge, ...)
  orch     Orchestration daemon (start, stop, status)
  task     Task management (coming soon)

Options:
  --help   Show this help message
  --version  Show version

Run 'apex-manager <command> --help' for command-specific help.
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === "--help" || command === "-h") {
    printUsage();
    process.exit(0);
  }

  if (command === "--version" || command === "-v") {
    console.log(`apex-manager v${VERSION}`);
    process.exit(0);
  }

  const subArgs = args.slice(1);

  switch (command) {
    case "worker": {
      const { cmdWorker } = await import("./commands/worker.js");
      await cmdWorker(subArgs);
      break;
    }
    case "orch": {
      const { cmdOrch } = await import("./commands/orch.js");
      await cmdOrch(subArgs);
      break;
    }
    case "task": {
      console.log("task management coming soon");
      break;
    }
    default: {
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
