// Wire shape of apps/forms-worker/src/action-items/handlers.ts.

export type ActionItemStatus = "open" | "in_progress" | "done";
export type ActionItemPriority = "High" | "Medium" | "Low";

export interface ActionItem {
  id: string;
  /** Null on an item added by hand from this page; field_key and
   *  question_label are null with it. */
  submission_id: string | null;
  location_code: string;
  field_key: string | null;
  question_label: string | null;
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
  /** Who added a manual item. Null on form-generated rows, where the
   *  submission is the provenance. */
  created_by_email?: string | null;
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

/** Append-only running record on an item: what was done, by whom, when.
 *  Distinct from `description`, which is the RM's observation at the visit and
 *  does not change. */
export interface ActionItemNote {
  id: string;
  action_item_id: string;
  author_email: string;
  author_user_id: string | null;
  body: string;
  created_at: string;
}
