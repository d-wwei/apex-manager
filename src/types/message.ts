export interface MessageRecord {
  id: string;
  from: string;
  to: string;
  task_id?: string;
  kind: string;
  priority: "normal" | "urgent";
  ack_required: boolean;
  body: string;
  directive_action?: "amend" | "pause" | "abort" | "info";
  delivery_status: "pending" | "delivered" | "acked" | "ack_timeout" | "failed";
  ack_timeout_ms?: number;
  delivery_attempts?: number;
  created_at: string;
  delivered_at?: string;
  acknowledged_at?: string;
  acknowledged_by?: string;
  last_delivery_attempt_at?: string;
  last_error?: string;
}

export interface MessageStore {
  messages: MessageRecord[];
  next_id: number;
}
