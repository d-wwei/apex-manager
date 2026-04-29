import type { WorkerMeta } from "../worker/monitor.js";
import type { ArtifactRecord } from "./artifact.js";
import type { MessageRecord } from "./message.js";
import type { Task } from "./task.js";

export interface KernelEvent {
  type: string;
  timestamp: string;
  task?: Task;
  artifact?: ArtifactRecord;
  message?: MessageRecord;
  worker?: WorkerMeta;
  worker_id?: string;
  reason?: string;
  [key: string]: unknown;
}

export interface ProjectSnapshot {
  generated_at: string;
  tasks: Task[];
  artifacts: ArtifactRecord[];
  messages: MessageRecord[];
  workers: WorkerMeta[];
  counters: {
    next_task_id: number;
    next_artifact_id: number;
    next_message_id: number;
  };
  stats: {
    open_tasks: number;
    blocked_tasks: number;
    pending_messages: number;
    active_workers: number;
    artifacts: number;
  };
}
