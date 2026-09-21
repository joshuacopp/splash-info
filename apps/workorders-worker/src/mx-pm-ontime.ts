// Preventative figures for the current Monday-Sunday week.
//
// THE HEADLINE IS COMPLETION, NOT ON TIME (changed 2026-09-21)
//
//       preventative % = completed / due
//
//   Operator, relaying the maintenance department: "preventative percentage
//   isn't actually related to on time at all - it's just percentage of them
//   due in that week (monday-sunday) that have been completed". Due dates set
//   the DENOMINATOR -- which work belongs to this week -- and play no part in
//   the numerator. A work order due Tuesday and closed Friday counts fully.
//
//   Everything below about on-time still runs and is still shipped, because
//   it costs nothing on the same rows and answers a real second question. It
//   is SECONDARY now and appears only in tooltips. The module, the exported
//   types and the wire field keep their `OnTime` names deliberately: renaming
//   them would break across a deploy seam, since this worker and splash-web
//   ship separately and whichever went first would leave the other reading
//   undefined. The name is wrong; the seam is worse.
//
//   apps/web/app/workorders/_lib/pm-week.ts is where the headline is rendered
//   and is the other half of this note.
//
// THE ON-TIME RULE (secondary)
//
//       on time = completed on or before its due day, OR not due yet
//       overdue = past its due day and undone, OR completed late
//
//   VERIFIED against the MaintainX "On Time vs. Overdue" report for
//   Binghamton, week of 2026-09-14, which read 5 on time / 2 overdue / 71.4%.
//   Of those seven: three completed by their due date, two past due and
//   untouched, and two open with nothing done but due Thursday and Sunday --
//   which MaintainX scored as ON TIME. That last part is MaintainX's
//   convention and is kept deliberately, so the two screens agree.
//
//   Not-yet-due work counting as on time is also why the denominator is the
//   whole Mon-Sun week rather than the week so far: under this rule future
//   work belongs in it.
//
// WHAT THIS COSTS
//
//   The figure starts each Monday high and falls as work comes due, so it is a
//   live gauge rather than a weekly score and is not comparable week to week
//   until Sunday night. `completedOnTime` is the strict
//   completed-by-due-date count and is what to read for performance; it is
//   shown in plain text under the headline, not buried in a tooltip, because a
//   reader who does not know that not-yet-due work counts as on time will
//   over-read a high number early in the week.
//
// A RULE THAT MATCHED THE SCREENSHOT AND WAS STILL WRONG
//
//   The first version scored late completions as on time, reading MaintainX's
//   red label "Not Done Overdue" as covering only work still undone. It
//   reproduced the verified screenshot exactly and was useless in production:
//   closing a work order late moved it OUT of the red bucket, so finishing
//   late improved the score. The next morning all six trial sites read exactly
//   100% while Binghamton had completed 4 of 9 by their due dates.
//
//   The screenshot could not tell the two rules apart because that snapshot
//   contained no late completions -- both produce 5/2 for it. One verified
//   example is not enough evidence when the cases that discriminate are
//   absent from it.
//
// WHY THIS IS A SEPARATE QUERY
//
//   The list read path deliberately fetches only ACTIVE work orders. An
//   on-time rate is mostly a question about COMPLETED ones, so the rows it
//   needs are exactly the rows that path excludes.

import {
  easternDayStartOf,
  easternWeekStartOf,
  easternYmd
} from "./eastern-time.js";

export interface PmOnTimeEnv {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
}

export interface PmOnTimeBucket {
  /** Every preventive work order due this Mon-Sun week. The denominator. */
  due: number;
  /** Completed by its due day, or not due yet. Was the headline until
   *  2026-09-21; now secondary. See the file header. */
  onTime: number;
  /** Past its due day and undone, or completed late. `onTime + overdue ===
   *  due`. */
  overdue: number;
  /** Actually finished on or before its due day -- excludes the not-yet-due
   *  work that `onTime` counts, so it is always <= onTime. This is the
   *  performance figure. */
  completedOnTime: number;
  /** Finished at all, on time or late. `completed / due` IS THE HEADLINE
   *  preventative percentage the page shows. */
  completed: number;
}

export interface PmOnTimeResult {
  /** Keyed by MaintainX location id. Locations with nothing due this week are
   *  absent rather than present-with-zero: "no PM was due" and "PM was due and
   *  none was on time" are opposite facts and must not render alike. */
  byLocation: Record<number, PmOnTimeBucket>;
  overall: PmOnTimeBucket;
  weekStartIso: string;
  /** Exclusive upper bound -- start of tomorrow, Eastern. */
  throughIso: string;
}

/** One page is 1000 rows (PostgREST's db-max-rows). The whole account runs
 *  about 500 preventive work orders due per week, so this is headroom rather
 *  than a working limit; the cap exists so a bad filter cannot spin. */
const PAGE_SIZE = 1000;
const MAX_PAGES = 6;

interface PmRow {
  mx_location_id: number | null;
  due_date: string | null;
  completed_at: string | null;
  status: string | null;
}

/**
 * Finished on or before the due DAY, both read in Eastern.
 *
 * Day resolution rather than timestamp: a work order due 9 PM and closed out
 * at 10 PM the same evening is on time as anyone at a site would describe it,
 * and the due-date pills next to this figure already treat due dates as days.
 * Comparing instants instead would make the header disagree with the rows.
 */
function completedOnTime(row: PmRow): boolean {
  if (row.status !== "DONE" || !row.completed_at || !row.due_date) return false;
  const completed = new Date(row.completed_at);
  const due = new Date(row.due_date);
  if (Number.isNaN(completed.getTime()) || Number.isNaN(due.getTime())) return false;
  return easternYmd(completed) <= easternYmd(due);
}

/**
 * Not on time: past its due day and undone, OR finished after its due day.
 *
 * THE SECOND CLAUSE IS THE WHOLE POINT, AND IT WAS WRONG ONCE ALREADY.
 *
 *   The first version excluded late completions, on the reading that
 *   MaintainX's red segment is labelled "Not Done Overdue" and so covers only
 *   work that is still undone. It reproduced the verified screenshot, and it
 *   was useless in production: closing a work order LATE moved it out of the
 *   red bucket, so finishing late IMPROVED the score. MEASURED the next
 *   morning, all six trial sites read exactly 100% while Binghamton had in
 *   fact completed 4 of 9 by their due dates. A gauge that reads 100%
 *   everywhere is not a gauge.
 *
 *   The screenshot could not discriminate between the two rules because that
 *   particular snapshot contained no late completions. Both produce 5 on time
 *   / 2 overdue / 71.4% for it -- which is why the fixture still passes and
 *   why it alone was never enough evidence.
 *
 * Work that is not due YET is still on time, untouched or not. That part is
 * MaintainX's convention and it is kept, so the two screens agree.
 */
function notOnTime(row: PmRow, todayYmd: string): boolean {
  if (!row.due_date) return false;
  const due = new Date(row.due_date);
  if (Number.isNaN(due.getTime())) return false;
  const dueYmd = easternYmd(due);

  if (row.status !== "DONE") return dueYmd < todayYmd;
  // Done, but after the day it was due.
  return !completedOnTime(row);
}

/**
 * Current-week preventive on-time rate, per location.
 *
 * Never throws and never fails the page: on any error it returns null and the
 * caller omits the figure. A missing percentage is a gap in a nice-to-have; a
 * 500 costs the operator the work-order list itself.
 */
export async function fetchPmOnTime(input: {
  env: PmOnTimeEnv;
  mxLocationIds: readonly number[];
  now?: Date;
}): Promise<PmOnTimeResult | null> {
  const { env, mxLocationIds } = input;
  const now = input.now ?? new Date();
  if (mxLocationIds.length === 0) return null;

  const weekStartIso = easternWeekStartOf(now);
  // The WHOLE Mon-Sun week, including work not yet due. Under MaintainX's
  // definition that future work is the numerator's friend, not an omission:
  // being not-yet-due is exactly what makes a row count as on time.
  //
  // Derived by stepping to midday of the day after next Sunday and re-taking
  // the day start, so a week containing a DST change (167 or 169 hours, not
  // 168) still ends on the right midnight.
  const throughIso = easternDayStartOf(
    new Date(Date.parse(weekStartIso) + 7 * 86_400_000 + 43_200_000)
  );
  const todayYmd = easternYmd(now);

  const ids = mxLocationIds
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n))
    .join(",");

  const rows: PmRow[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url =
      `${env.SUPABASE_URL}/rest/v1/mx_work_order` +
      `?select=mx_location_id,due_date,completed_at,status` +
      `&type=eq.PREVENTIVE` +
      `&deleted_at=is.null` +
      `&mx_location_id=in.(${ids})` +
      `&due_date=gte.${encodeURIComponent(weekStartIso)}` +
      `&due_date=lt.${encodeURIComponent(throughIso)}` +
      // Ordered so paging is stable. due_date is not unique, so id breaks the
      // tie -- without it a partial ordering repeats and skips rows.
      `&order=due_date.asc,id.asc` +
      `&limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`;

    let batch: PmRow[];
    try {
      const res = await fetch(url, {
        headers: {
          apikey: env.SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
          Accept: "application/json"
        }
      });
      if (!res.ok) {
        console.error(`[mx-ontime] read failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
        return null;
      }
      batch = (await res.json()) as PmRow[];
    } catch (err) {
      console.error("[mx-ontime] read threw:", err);
      return null;
    }

    rows.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    if (page === MAX_PAGES - 1) {
      console.warn(`[mx-ontime] hit the ${MAX_PAGES}-page cap; figure is partial`);
    }
  }

  const empty = (): PmOnTimeBucket => ({
    due: 0,
    onTime: 0,
    overdue: 0,
    completedOnTime: 0,
    completed: 0
  });

  const byLocation: Record<number, PmOnTimeBucket> = {};
  const overall = empty();

  for (const row of rows) {
    if (row.mx_location_id === null) continue;
    const bucket = byLocation[row.mx_location_id] ?? empty();
    const late = notOnTime(row, todayYmd);
    const strict = completedOnTime(row);
    const done = row.status === "DONE";

    for (const b of [bucket, overall]) {
      b.due += 1;
      if (late) b.overdue += 1;
      else b.onTime += 1;
      if (strict) b.completedOnTime += 1;
      if (done) b.completed += 1;
    }
    byLocation[row.mx_location_id] = bucket;
  }

  return { byLocation, overall, weekStartIso, throughIso };
}
