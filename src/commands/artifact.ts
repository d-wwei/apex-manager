import { existsSync } from "fs";
import { isAbsolute, relative, resolve } from "path";
import { readJSON, writeJSON } from "../utils/json.js";
import { recordKernelEvent } from "../utils/events.js";
import { apexPath, ensureProjectLayout, DEFAULT_ARTIFACT_STORE, DEFAULT_TASK_STORE } from "../utils/project-state.js";
import type { ArtifactRecord, ArtifactStore } from "../types/artifact.js";
import type { TaskStore } from "../types/task.js";

function artifactStorePath(): string {
  return apexPath("artifacts", "index.json");
}

function taskStorePath(): string {
  return apexPath("tasks.json");
}

async function loadArtifactStore(): Promise<ArtifactStore> {
  return readJSON<ArtifactStore>(artifactStorePath(), DEFAULT_ARTIFACT_STORE);
}

async function saveArtifactStore(store: ArtifactStore): Promise<void> {
  await writeJSON(artifactStorePath(), store);
}

async function loadTaskStore(): Promise<TaskStore> {
  return readJSON<TaskStore>(taskStorePath(), DEFAULT_TASK_STORE);
}

async function saveTaskStore(store: TaskStore): Promise<void> {
  await writeJSON(taskStorePath(), store);
}

function flagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : undefined;
}

function formatArtifact(artifact: ArtifactRecord): string {
  return [
    `${artifact.id}  ${artifact.type}  task=${artifact.task_id}  by=${artifact.by}`,
    `  summary: ${artifact.summary}`,
    `  path: ${artifact.path}`,
  ].join("\n");
}

function isInside(path: string, base: string): boolean {
  const rel = relative(resolve(base), resolve(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function artifactAllowedRoots(taskId: string, by: string): Promise<string[]> {
  const projectRoot = process.cwd();
  const roots = [projectRoot];
  const workerMeta = await readJSON<{ worktree_path?: string } | null>(apexPath("workers", by, "meta.json"), null);
  if (workerMeta?.worktree_path) {
    roots.push(resolve(projectRoot, workerMeta.worktree_path));
  }
  if (by !== taskId) {
    const taskWorkerMeta = await readJSON<{ worktree_path?: string } | null>(apexPath("workers", taskId, "meta.json"), null);
    if (taskWorkerMeta?.worktree_path) {
      roots.push(resolve(projectRoot, taskWorkerMeta.worktree_path));
    }
  }
  return [...new Set(roots)];
}

async function resolveArtifactPath(taskId: string, by: string, path: string): Promise<{ absolutePath: string; tried: string[] }> {
  const cwdCandidate = resolve(process.cwd(), path);
  const projectRoot = process.cwd();
  const candidates: string[] = [];

  const workerMeta = await readJSON<{ worktree_path?: string } | null>(
    apexPath("workers", by, "meta.json"),
    null,
  );
  if (workerMeta?.worktree_path) {
    candidates.push(resolve(projectRoot, workerMeta.worktree_path, path));
  }

  const taskWorkerMeta = by === taskId
    ? workerMeta
    : await readJSON<{ worktree_path?: string } | null>(apexPath("workers", taskId, "meta.json"), null);
  if (taskWorkerMeta?.worktree_path) {
    candidates.push(resolve(projectRoot, taskWorkerMeta.worktree_path, path));
  }

  candidates.push(cwdCandidate);
  candidates.push(resolve(projectRoot, path));

  const uniqueCandidates = [...new Set(candidates)];
  const existing = uniqueCandidates.find((candidate) => existsSync(candidate));
  return { absolutePath: existing ?? cwdCandidate, tried: uniqueCandidates };
}

async function cmdSubmit(args: string[]): Promise<void> {
  ensureProjectLayout();

  const taskId = args[0];
  const by = flagValue(args, "--by");
  const type = flagValue(args, "--type");
  const path = flagValue(args, "--path");
  const summary = flagValue(args, "--summary");

  if (!taskId || !by || !type || !path || !summary) {
    console.error("Usage: apex-manager artifact submit <task-id> --by <worker-id> --type <type> --path <path> --summary <summary>");
    process.exit(1);
  }

  const taskStore = await loadTaskStore();
  const task = taskStore.tasks.find((entry) => entry.id === taskId);
  if (!task) {
    console.error(`Task ${taskId} not found`);
    process.exit(1);
  }

  const { absolutePath, tried } = await resolveArtifactPath(taskId, by, path);
  if (!existsSync(absolutePath)) {
    console.error(`Artifact path does not exist: ${path}`);
    console.error("Tried:");
    for (const candidate of tried) {
      console.error(`  ${candidate}`);
    }
    console.error("Use an absolute path or run artifact submit from the directory containing the artifact.");
    process.exit(1);
  }
  const allowedRoots = await artifactAllowedRoots(taskId, by);
  if (!allowedRoots.some((root) => isInside(absolutePath, root))) {
    console.error(`Artifact path is outside the project/worktree boundary: ${path}`);
    console.error("Allowed roots:");
    for (const root of allowedRoots) {
      console.error(`  ${root}`);
    }
    process.exit(1);
  }

  const store = await loadArtifactStore();
  const artifact: ArtifactRecord = {
    id: `ART-${store.next_id}`,
    task_id: taskId,
    by,
    type,
    path,
    absolute_path: absolutePath,
    summary,
    created_at: new Date().toISOString(),
  };

  store.artifacts.push(artifact);
  store.next_id += 1;
  await saveArtifactStore(store);

  task.artifacts = task.artifacts ?? [];
  task.artifacts.push(artifact.id);
  task.updated_at = new Date().toISOString();
  await saveTaskStore(taskStore);
  await recordKernelEvent({
    type: "artifact.submitted",
    timestamp: artifact.created_at,
    artifact: { ...artifact },
    task: { ...task },
  });

  console.log(`${artifact.id}: ${artifact.summary}`);
}

async function cmdList(args: string[]): Promise<void> {
  ensureProjectLayout();
  const filterTaskId = args[0];
  const store = await loadArtifactStore();
  const artifacts = filterTaskId
    ? store.artifacts.filter((artifact) => artifact.task_id === filterTaskId)
    : store.artifacts;

  if (artifacts.length === 0) {
    console.log("No artifacts.");
    return;
  }

  for (const artifact of artifacts) {
    console.log(formatArtifact(artifact));
  }
}

async function cmdShow(args: string[]): Promise<void> {
  ensureProjectLayout();
  const artifactId = args[0];
  if (!artifactId) {
    console.error("Usage: apex-manager artifact show <artifact-id>");
    process.exit(1);
  }

  const store = await loadArtifactStore();
  const artifact = store.artifacts.find((entry) => entry.id === artifactId);
  if (!artifact) {
    console.error(`Artifact ${artifactId} not found`);
    process.exit(1);
  }

  console.log(formatArtifact(artifact));
  console.log(`  absolute_path: ${artifact.absolute_path}`);
  console.log(`  created_at: ${artifact.created_at}`);
}

function printHelp(): void {
  console.log(`
apex-manager artifact — manage generic task artifacts

Usage:
  apex-manager artifact submit <task-id> --by <worker-id> --type <type> --path <path> --summary <summary>
  apex-manager artifact list [task-id]
  apex-manager artifact show <artifact-id>
`);
}

export async function cmdArtifact(args: string[]): Promise<void> {
  const verb = args[0];

  switch (verb) {
    case "submit":
      await cmdSubmit(args.slice(1));
      break;
    case "list":
      await cmdList(args.slice(1));
      break;
    case "show":
      await cmdShow(args.slice(1));
      break;
    case "--help":
    case "help":
      printHelp();
      break;
    default:
      if (!verb) {
        printHelp();
      } else {
        console.error(`Unknown artifact subcommand: ${verb}`);
        printHelp();
        process.exit(1);
      }
      break;
  }
}
