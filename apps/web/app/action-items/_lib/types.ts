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

/** High first. NOT alphabetical -- "High" < "Low" < "Medium" as text, which is
 *  why this cannot be a PostgREST `order=` and lives here instead. */
const PRIORITY_RANK: Record<ActionItemPriority, number> = {
  High: 0,
  Medium: 1,
  Low: 2
};

/**
 * Worklist order for OPEN items: soonest due first, priority breaking ties.
 *
 * Due date leads because it is the only field that says something is LATE, and
 * overdue work rises to the top for free. Priority separates items landing on
 * the same day, which is the case where a date cannot choose for you.
 *
 * Undated items sort LAST rather than first: a missing due date means nobody
 * committed to a day, and that should not outrank work somebody did commit to.
 * created_at is the final tiebreak so the order is stable across renders
 * rather than shuffling on every refresh.
 */
export function compareOpenItems(a: ActionItem, b: ActionItem): number {
  if (a.due_date !== b.due_date) {
    if (!a.due_date) return 1;
    if (!b.due_date) return -1;
    return a.due_date < b.due_date ? -1 : 1;
  }
  const pr = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  if (pr !== 0) return pr;
  return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0;
}

/** Completed work is history: most recently finished first, because "what did
 *  we just close" is the question asked of it, not "what closed longest ago". */
export function compareDoneItems(a: ActionItem, b: ActionItem): number {
  const at = a.completed_at ?? a.created_at;
  const bt = b.completed_at ?? b.created_at;
  return at < bt ? 1 : at > bt ? -1 : 0;
}

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
