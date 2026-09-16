// Preventative on-time percentage for the current Monday-Sunday week.
//
// WHAT THE NUMBER MEANS
//
//   Of the preventive work orders that have come DUE so far this week, the
//   share that were completed on or before the day they were due.
//
// WHY THE DENOMINATOR STOPS AT TODAY
//
//   The obvious denominator is the whole Mon-Sun week, and it is unusable
//   mid-week: work due on Friday is not late on Wednesday, but a whole-week
//   denominator counts it as not-yet-done and reports it as failure. MEASURED
//   on a Wednesday, the same data reads 61.5% whole-week against 77.3% due-so-
//   far, where the settled historical rate is 77-84%. The whole-week figure is
//   not a worse estimate of the same thing, it is a different and misleading
//   thing: every site would look terrible on Monday and recover by Sunday
//   regardless of whether anyone did anything.
//
//   So the window is Monday 00:00 Eastern to the END of today Eastern, and the
//   figure settles into the final weekly number on Sunday night.
//
// WHY THIS IS A SEPARATE QUERY
//
//   The list read path deliberately fetches only ACTIVE work orders. An
//   on-time rate is mostly a question about COMPLETED ones, so the rows it
//   needs are exactly the rows that path excludes.

import {
  easternDayStartOf,
  easternNextDayStartOf,
  easternWeekStartOf,
  easternYmd
} from "./eastern-time.js";

export interface PmOnTimeEnv {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
}

export interface PmOnTimeBucket {
  /** Preventive work orders whose due date has passed this week. */
  due: number;
  /** Of those, completed on or before their due DAY. */
  onTime: number;
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
 * On time = completed on or before the due DAY, both read in Eastern.
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
  // Through the end of TODAY, but never past the end of the week -- a stale
  // `now` or a clock skew should not pull next week's work into this week's
  // denominator.
  const endOfWeek = easternDayStartOf(
    new Date(Date.parse(weekStartIso) + 7 * 86_400_000 + 43_200_000)
  );
  const endOfToday = easternNextDayStartOf(now);
  const throughIso = endOfToday < endOfWeek ? endOfToday : endOfWeek;

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

  const byLocation: Record<number, PmOnTimeBucket> = {};
  const overall: PmOnTimeBucket = { due: 0, onTime: 0 };

  for (const row of rows) {
    if (row.mx_location_id === null) continue;
    const bucket = byLocation[row.mx_location_id] ?? { due: 0, onTime: 0 };
    bucket.due += 1;
    overall.due += 1;
    if (completedOnTime(row)) {
      bucket.onTime += 1;
      overall.onTime += 1;
    }
    byLocation[row.mx_location_id] = bucket;
  }

  return { byLocation, overall, weekStartIso, throughIso };
}
