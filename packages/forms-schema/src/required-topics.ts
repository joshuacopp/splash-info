// Required topics field (2026-11-18, Monthly Safety Meeting).
//
// A committee sets, per month, a list of topics every site must cover
// (table `form_required_topics`, edited at /admin/safety-topics). The field
// shows the list for the month of the form's date field and every topic must
// be ticked as covered. A month with no row (or an empty list) has no
// mandatory topics.

/** Stored on the submission. `topics` is the list the SERVER read for that
 *  month at submit time -- every one of them was ticked, or the submit was
 *  refused -- so a later edit to the month's list does not rewrite history. */
export interface RequiredTopicsValue {
  /** "2026-12" */
  month: string;
  topics: string[];
}

/** List keys a required_topics field may name. One today; the table is keyed
 *  so another committee could get its own list without a schema change. */
export const REQUIRED_TOPIC_LISTS = {
  safety_meeting: {
    label: "Monthly safety meeting",
    /** form_access_grants tag that may edit this list (admins always can). */
    accessTag: "safety_committee"
  }
} as const;

export type RequiredTopicListKey = keyof typeof REQUIRED_TOPIC_LISTS;

export function isRequiredTopicListKey(s: string): s is RequiredTopicListKey {
  return Object.prototype.hasOwnProperty.call(REQUIRED_TOPIC_LISTS, s);
}

export const REQUIRED_TOPIC_MAX = 20;
export const REQUIRED_TOPIC_MAX_LEN = 200;

export function isRequiredTopicsValue(v: unknown): v is RequiredTopicsValue {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.month === "string" &&
    Array.isArray(o.topics) &&
    o.topics.every((t) => typeof t === "string")
  );
}

/** "December 2026" from "2026-12". */
export function formatMonth(month: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return month;
  const names = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
  ];
  return `${names[Number(m[2]) - 1] ?? m[2]} ${m[1]}`;
}

/** "December 2026: Salt logs; PPE for power tools" or "... no required topics". */
export function formatRequiredTopicsValue(v: RequiredTopicsValue): string {
  if (v.topics.length === 0) return `${formatMonth(v.month)}: no required topics`;
  return `${formatMonth(v.month)}: ${v.topics.join("; ")} (all covered)`;
}
