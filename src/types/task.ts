export type TaskStatus = "open" | "assigned" | "in_progress" | "to_verify" | "done" | "blocked";

export const ALLOWED_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  open: ["assigned", "blocked"],
  assigned: ["in_progress", "open", "blocked"],
  in_progress: ["to_verify", "blocked"],
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
  previous_status?: TaskStatus;
  block_reason?: string;
  adapter?: string;
  agent?: string;
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
