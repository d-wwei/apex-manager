import { ensureProjectLayout } from "../utils/project-state.js";

function printHelp(): void {
  console.log(`
apex-manager init — initialize .apex-manager state for the current repo

Usage:
  apex-manager init

Creates the default local-first project layout if it does not already exist.
The command is idempotent and preserves existing state files.
`);
}

export async function cmdInit(args: string[]): Promise<void> {
  const verb = args[0];
  if (verb === "--help" || verb === "help") {
    printHelp();
    return;
  }

  ensureProjectLayout();
  console.log("Initialized .apex-manager project state");
}
