/**
 * Orchestration Daemon — Integration and Merge
 *
 * autoIntegrate: validates Worker branch merges cleanly + tests pass (in tmp worktree)
 * autoMerge: performs actual merge on main branch after integration passes
 */

import { spawnSync, execSync } from "child_process";
import { recordKernelEvent } from "../utils/events.js";

export interface IntegrateResult {
  ok: boolean;
  reason?: "merge_conflict" | "test_failure" | "merge_race_retry";
  output?: string;
}

/**
 * Validate that a Worker branch can merge cleanly and tests pass.
 * Runs in a temporary worktree to avoid polluting the main branch.
 */
export async function autoIntegrate(taskId: string): Promise<IntegrateResult> {
  const workerBranch = `apex-mgr/${taskId}`;
  const tmpWorktree = `.apex-manager/tmp-integrate-${taskId}`;

  try {
    // 1. Create temporary worktree (detached HEAD based on current main)
    const addResult = spawnSync("git", ["worktree", "add", tmpWorktree, "HEAD", "--detach"], {
      encoding: "utf-8",
    });
    if (addResult.status !== 0) {
      return { ok: false, reason: "merge_conflict", output: `worktree add failed: ${addResult.stderr}` };
    }

    // 2. Merge Worker branch in temporary worktree
    const mergeResult = spawnSync("git", ["merge", "--no-ff", workerBranch], {
      encoding: "utf-8",
      cwd: tmpWorktree,
    });
    if (mergeResult.status !== 0) {
      await recordKernelEvent({
        type: "orchestration.event",
        action: "integrate_conflict",
        task_id: taskId,
        timestamp: new Date().toISOString(),
      });
      return { ok: false, reason: "merge_conflict", output: mergeResult.stderr };
    }

    // 3. Run tests in merged worktree
    const testResult = spawnSync("npm", ["test"], {
      encoding: "utf-8",
      cwd: tmpWorktree,
      timeout: 120_000, // 2 minute timeout for tests
    });
    if (testResult.status !== 0) {
      await recordKernelEvent({
        type: "orchestration.event",
        action: "integrate_failed",
        task_id: taskId,
        timestamp: new Date().toISOString(),
      });
      return { ok: false, reason: "test_failure", output: testResult.stdout };
    }

    return { ok: true };
  } finally {
    // 4. Clean up temporary worktree (always, even on failure)
    spawnSync("git", ["worktree", "remove", tmpWorktree, "--force"], { encoding: "utf-8" });
  }
}

/**
 * Merge Worker branch into main branch. Called only after autoIntegrate passes.
 * Returns false if main branch moved between integrate and merge (race condition).
 */
export async function autoMerge(taskId: string): Promise<boolean> {
  const workerBranch = `apex-mgr/${taskId}`;

  const mergeResult = spawnSync("git", ["merge", "--ff", workerBranch], { encoding: "utf-8" });

  if (mergeResult.status !== 0) {
    // Main branch moved between integrate and merge — caller should re-integrate
    await recordKernelEvent({
      type: "orchestration.event",
      action: "merge_race_retry",
      task_id: taskId,
      timestamp: new Date().toISOString(),
    });
    return false;
  }

  const commitHash = execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim();
  await recordKernelEvent({
    type: "orchestration.event",
    action: "merge_completed",
    task_id: taskId,
    commit: commitHash,
    timestamp: new Date().toISOString(),
  });
  return true;
}
