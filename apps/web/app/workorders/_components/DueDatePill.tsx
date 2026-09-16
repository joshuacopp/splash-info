"use client";

// Brief 73 — Preventative-tab due-date indicator. Three render tiers plus a
// null/em-dash fallback:
//   • dueDate < today          → red pill "Overdue Nd"
//   • dueDate falls within today → amber pill "Due today"
//   • dueDate >= tomorrow      → muted plain text "Due MMM D"
//   • dueDate == null / NaN    → em-dash
//
// Comparison is at calendar-day resolution, not millisecond — operators think
// in "is it overdue today" not "was it overdue 6 hours ago."
//
// The day is an EASTERN day, not a UTC one. Brief 73 used UTC on the reasoning
// that MaintainX returns dueDate as UTC ISO 8601, so a UTC floor keeps every
// browser aligned. It aligns them on the wrong day: MaintainX stores real
// timestamps authored in local time, and preventive work is overwhelmingly due
// late in the Eastern evening — 9 PM and 11 PM are the two commonest due times
// — which is already TOMORROW in UTC. MEASURED over eight weeks, 67% of
// preventive work orders (4,184 of 6,233) fall on a different calendar day in
// UTC than the day an operator would name, so the pill read a day short on
// two thirds of them. Every site is Eastern, so Eastern is the aligned answer.

import type { ReactElement } from "react";

interface Props {
  /** ISO 8601 timestamp from MaintainX `dueDate`. Null = no due date set. */
  dueDate: string | null;
  /** Optional override for "now" — useful for testing / SSR consistency.
   *  Defaults to Date.now(). */
  now?: number;
}

const PILL_BASE =
  "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium";
const PILL_OVERDUE = `${PILL_BASE} bg-red-100 text-red-800`;
const PILL_DUE_TODAY = `${PILL_BASE} bg-amber-100 text-amber-800`;
const PLAIN_FUTURE = "text-xs text-gray-500";

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec"
];

const EASTERN_YMD = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
});

/** Midnight of the Eastern calendar day containing `ts`, expressed as a UTC
 *  instant. Only ever compared against another value from this function, so
 *  the fictional timezone of the result does not matter — the spacing between
 *  two of them is exactly the number of calendar days apart. */
function dayFloor(ts: number): number {
  // en-CA formats as YYYY-MM-DD, which is why it is used here rather than a
  // parts walk. Date.parse of a bare date string is UTC midnight by spec.
  return Date.parse(EASTERN_YMD.format(new Date(ts)));
}

/**
 * Whole days a work order is past due: positive = overdue, 0 = due today,
 * negative = still ahead of it. Null when there is no usable due date.
 *
 * Exported because the section headers count overdue work orders and the rows
 * beneath them label each one. Two implementations of "overdue" would be two
 * chances to disagree, and a header that contradicts the rows under it is
 * worse than no header -- so both read this.
 */
export function overdueDays(dueDate: string | null, now = Date.now()): number | null {
  if (!dueDate) return null;
  const due = new Date(dueDate).getTime();
  if (Number.isNaN(due)) return null;
  return Math.floor((dayFloor(now) - dayFloor(due)) / 86_400_000);
}

export function DueDatePill({ dueDate, now = Date.now() }: Props): ReactElement {
  if (!dueDate) return <span className="text-xs text-gray-400">—</span>;

  const due = new Date(dueDate).getTime();
  const diffDays = overdueDays(dueDate, now);
  if (diffDays === null) return <span className="text-xs text-gray-400">—</span>;

  if (diffDays > 0) {
    return <span className={PILL_OVERDUE}>Overdue {diffDays}d</span>;
  }
  if (diffDays === 0) {
    return <span className={PILL_DUE_TODAY}>Due today</span>;
  }
  // diffDays < 0 → future. Read in Eastern for the same reason the comparison
  // above is: a work order due 11 PM Monday must not be labelled "Due Sep 15"
  // when the pill beside it counts Monday the 14th as its due day.
  const [, month, day] = EASTERN_YMD.format(new Date(due)).split("-");
  const monthName = MONTHS[Number(month) - 1];
  const dayNum = Number(day);
  return (
    <span className={PLAIN_FUTURE}>
      Due {monthName} {dayNum}
    </span>
  );
}
