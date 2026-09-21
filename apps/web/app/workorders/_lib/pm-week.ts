// The preventative percentage, in one place.
//
// THE RULE
//
//       preventative % = completed / due, for work orders due Mon-Sun
//
//   Operator, 2026-09-21, relaying the maintenance department: "preventative
//   percentage isn't actually related to on time at all - it's just percentage
//   of them due in that week (monday-sunday) that have been completed".
//
//   So a work order due Tuesday and closed out on Friday counts fully. Due
//   dates set the DENOMINATOR -- which work belongs to this week -- and play
//   no part in the numerator.
//
// WHAT CHANGED, AND WHY THE OLD NUMBER IS STILL ON THE WIRE
//
//   Until now the headline was MaintainX's on-time rate, built to agree with
//   its "On Time vs. Overdue" report. That figure is still computed and still
//   shipped (`onTime`, `completedOnTime`, `overdue`) because it costs nothing
//   and answers a real second question, but it is secondary now and appears
//   only in tooltips. The wire field is still called `pmOnTime`: renaming it
//   would break across a deploy seam, since workorders-worker and splash-web
//   ship separately. The name is wrong; the seam is worse.
//
// WHY THERE IS NO TRAFFIC LIGHT
//
//   A completion rate measured against the WHOLE week necessarily reads near
//   zero on Monday and climbs to its final value by Sunday. Thresholds like
//   the old 90/75 would paint every site red for four days a week and mean
//   nothing, so the pill stays neutral and turns green only at 100%, which is
//   unambiguously good on any day. The count of work still open is shown
//   beside it, because THAT is actionable on a Tuesday in a way the
//   percentage is not.

import type { PmOnTimeBucket } from "./worker-fetch";

/** Completed over due, to one decimal. Callers must check `due > 0` first --
 *  a site with nothing due has no percentage, not a zero. */
export function pmPct(bucket: PmOnTimeBucket): number {
  if (bucket.due === 0) return 0;
  return Math.round((bucket.completed / bucket.due) * 1000) / 10;
}

/** Still to do this week. The actionable number mid-week. */
export function pmRemaining(bucket: PmOnTimeBucket): number {
  return Math.max(0, bucket.due - bucket.completed);
}

/** Green only at a finished week; otherwise neutral. See the file header for
 *  why there is no amber/red tier. */
export function pmTone(bucket: PmOnTimeBucket): string {
  return pmRemaining(bucket) === 0
    ? "bg-emerald-100 text-emerald-800"
    : "bg-gray-light text-splash-navy/80";
}

/** Hover text: the headline spelled out, then the on-time reading as the
 *  secondary fact it now is. */
export function pmTitle(bucket: PmOnTimeBucket): string {
  const remaining = pmRemaining(bucket);
  return (
    `${bucket.completed} of ${bucket.due} preventative work orders due this week (Mon-Sun) are complete.` +
    (remaining > 0 ? ` ${remaining} still open.` : "") +
    ` Of the ${bucket.completed} done, ${bucket.completedOnTime} were finished by their due date.`
  );
}
