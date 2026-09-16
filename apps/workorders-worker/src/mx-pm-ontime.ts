// Preventative on-time percentage for the current Monday-Sunday week.
//
// THIS DELIBERATELY MATCHES THE MAINTAINX "On Time vs. Overdue" REPORT,
// INCLUDING WHERE THAT DEFINITION IS ODD.
//
//   MaintainX is not measuring "was it done by its due date". It is measuring
//   "is anything late right now". Work that is not due YET counts as on time,
//   even when nothing has been done to it.
//
//   VERIFIED against the MaintainX UI for Binghamton, week of 2026-09-14,
//   which reported 5 on time / 2 overdue / 71.4%. Of the seven repeating work
//   orders due that week: three were completed on or before their due date,
//   two were past due and untouched, and TWO WERE OPEN WITH NOTHING DONE but
//   due Thursday and Sunday -- and MaintainX scored those last two as on time.
//   The rule that reproduces 5/2 exactly is:
//
//       overdue = past its due day AND not done
//       on time = everything else
//
//   Which is why the whole Mon-Sun week is the denominator here: under this
//   definition future work belongs in it, because being not-yet-due is the
//   thing that makes it count as on time.
//
// WHAT THAT COSTS, AND WHY IT IS STILL THE RIGHT CALL
//
//   This figure starts each Monday at or near 100% and can only fall, because
//   at the start of a week almost nothing is due yet. It is a live "anything
//   late?" gauge, not a weekly performance score, and it is NOT comparable
//   week to week until Sunday night.
//
//   A stricter completed-by-due-date rate is genuinely more honest -- the same
//   Binghamton week reads 50% that way. But operators cross-check this page
//   against the MaintainX report, and a number that disagrees with the
//   reference they already use gets treated as broken no matter which one is
//   more defensible. So the headline matches MaintainX and the strict figure
//   is carried alongside it, in `completedOnTime`, for the tooltip.
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
  /** Every preventive work order due this Mon-Sun week. */
  due: number;
  /** MaintainX's sense: not currently overdue. Includes work that is not due
   *  yet and has had nothing done to it. This is the headline number. */
  onTime: number;
  /** Past its due day and not done. `onTime + overdue === due`. */
  overdue: number;
  /** The stricter reading: actually finished on or before its due day. Always
   *  <= onTime. Carried so the tooltip can tell the truth the headline
   *  cannot. */
  completedOnTime: number;
  /** Finished at all, on time or late. */
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
 * MaintainX's red bucket: past its due day AND not done.
 *
 * Note what is NOT here. A work order finished LATE is not counted overdue,
 * because it is no longer "not done" -- MaintainX labels the red segment "Not
 * Done Overdue" and its counts only add up to the total if late completions
 * sit on the green side. That is strange, and it is what the reference report
 * does; `completedOnTime` is what to read if the strange part matters.
 */
function currentlyOverdue(row: PmRow, todayYmd: string): boolean {
  if (row.status === "DONE") return false;
  if (!row.due_date) return false;
  const due = new Date(row.due_date);
  if (Number.isNaN(due.getTime())) return false;
  return easternYmd(due) < todayYmd;
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
    const late = currentlyOverdue(row, todayYmd);
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
