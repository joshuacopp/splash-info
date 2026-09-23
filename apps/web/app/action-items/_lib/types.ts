// Wire shape of apps/forms-worker/src/action-items/handlers.ts.

export type ActionItemStatus = "open" | "in_progress" | "done";
export type ActionItemPriority = "High" | "Medium" | "Low";

export interface ActionItem {
  id: string;
  submission_id: string;
  location_code: string;
  field_key: string;
  question_label: string;
  answer_snapshot: string | null;
  description: string;
  priority: ActionItemPriority;
  due_date: string | null;
  status: ActionItemStatus;
  completed_at: string | null;
  completed_by: string | null;
  rm_verified_at: string | null;
  rm_verified_by: string | null;
  created_at: string;
  /** Per-row, computed by the worker from the SAME functions its writes gate
   *  on. Never re-derive these client-side: a second implementation of "who
   *  may act" drifts from the first, and the drift is silent. */
  can_edit: boolean;
  can_verify: boolean;
}

export interface ActionItemsResponse {
  items: ActionItem[];
  scope: "all" | "scoped";
  locations: string[];
  limit_hit: boolean;
}

export const STATUS_LABEL: Record<ActionItemStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  done: "Done"
};

export const STATUS_ORDER: ActionItemStatus[] = ["open", "in_progress", "done"];
export const PRIORITIES: ActionItemPriority[] = ["High", "Medium", "Low"];
