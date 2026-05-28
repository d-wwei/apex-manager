export type TaskStatus = "open" | "assigned" | "in_progress" | "to_verify" | "done" | "blocked";

export const ALLOWED_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  open: ["assigned", "in_progress", "blocked"],
  assigned: ["in_progress", "open", "blocked"],
  in_progress: ["to_verify", "done", "blocked"],
  to_verify: ["done", "in_progress", "blocked"],
  done: [],
  blocked: ["open"],
};

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  depends_on: string[];
  blocked_by: string[];
  evidence: string[];
  artifacts?: string[];
  previous_status?: TaskStatus;
  block_reason?: string;
  claimed_by?: string;
  claimed_at?: string;
  completed_by?: string;
  completion_summary?: string;
  adapter?: string;
  agent?: string;
  requested_agent?: string;
  actual_agent?: string;
  attempts?: {
    attempt: number;
    agent: string;
    worker_id: string;
    status: "starting" | "unverified" | "verified" | "completed" | "failed" | "crashed" | "blocked";
    started_at: string;
    completed_at?: string;
    note?: string;
  }[];
  protocol?: string;
  branch?: string;
  category?: string;
  attempt?: number;
  workspace_path?: string;
  session_id?: string;
  created_at: string;
  updated_at: string;
  completed_at?: string;
}

export interface TaskStore {
  tasks: Task[];
  next_id: number;
}
