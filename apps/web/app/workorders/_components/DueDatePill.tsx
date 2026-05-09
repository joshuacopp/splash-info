"use client";

// Brief 73 — Preventative-tab due-date indicator. Three render tiers plus a
// null/em-dash fallback:
//   • dueDate < today          → red pill "Overdue Nd"
//   • dueDate falls within today → amber pill "Due today"
//   • dueDate >= tomorrow      → muted plain text "Due MMM D"
//   • dueDate == null / NaN    → em-dash
//
// Comparison is at calendar-day resolution (UTC), not millisecond — operators
// think in "is it overdue today" not "was it overdue 6 hours ago." MaintainX
// returns dueDate as UTC ISO 8601 so UTC day-floor keeps everyone aligned
// regardless of browser locale.

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

function dayFloor(ts: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export function DueDatePill({ dueDate, now = Date.now() }: Props): ReactElement {
  if (!dueDate) return <span className="text-xs text-gray-400">—</span>;

  const due = new Date(dueDate).getTime();
  if (Number.isNaN(due)) return <span className="text-xs text-gray-400">—</span>;

  const dueDay = dayFloor(due);
  const nowDay = dayFloor(now);
  const diffDays = Math.floor((nowDay - dueDay) / 86_400_000);

  if (diffDays > 0) {
    return <span className={PILL_OVERDUE}>Overdue {diffDays}d</span>;
  }
  if (diffDays === 0) {
    return <span className={PILL_DUE_TODAY}>Due today</span>;
  }
  // diffDays < 0 → future
  const dueDateObj = new Date(due);
  const monthName = MONTHS[dueDateObj.getUTCMonth()];
  const dayNum = dueDateObj.getUTCDate();
  return (
    <span className={PLAIN_FUTURE}>
      Due {monthName} {dayNum}
    </span>
  );
}
