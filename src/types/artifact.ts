export interface ArtifactRecord {
  id: string;
  task_id: string;
  by: string;
  type: string;
  path: string;
  absolute_path: string;
  summary: string;
  created_at: string;
}

export interface ArtifactStore {
  artifacts: ArtifactRecord[];
  next_id: number;
}
