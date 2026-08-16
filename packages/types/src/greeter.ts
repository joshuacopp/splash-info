// Greeter scorecard types — daily per-greeter and per-location sales numbers.
// Schema: supabase/greeter-scorecard-tables.sql (read the header there for the
// metric vocabulary before changing anything numeric).
//
// Vocabulary reminder, because these names are easy to get subtly wrong:
//   total_cars    — every car through the tunnel, unlimited members included.
//                   SITE-LEVEL ONLY. Not a greeter's number: everyone on shift
//                   would report the same figure and summing across a crew
//                   would multiply the site's day.
//   wash_sales    — "ALC" / a-la-carte: NON-unlimited saleable cars. Denominator
//                   for both derived metrics. NOT the same as total_cars.
//   total_members — active members as of that day. A LEVEL, not a delta. Never
//                   sum it across days; read it at the latest date in a window.
//   net_members   — sign_ups - cancellations. THAT is the delta.
//   dob           — dollars over base = (package $ + extras $) / wash_sales.
//   capture_pct   — sign_ups / wash_sales as a percentage (0-100), NOT a 0-1
//                   fraction, matching performance_tracking.capture_rate.

/**
 * Metrics both forms collect. Split out from the two form-specific interfaces
 * below rather than being one flat shared type, because the greeter and site
 * metric sets genuinely differ now: a greeter can't own tunnel volume or the
 * member roll, and a site doesn't have a shift.
 */
export interface GreeterSharedMetrics {
  wash_sales: number | null;
  rewashes: number | null;
  package_dollars: number | null;
  extras_dollars: number | null;
  sign_ups: number | null;
}

/**
 * What a greeter's day form sends. Shift times are `HH:MM` or `HH:MM:SS`
 * 24-hour strings (Postgres `time`), and are BOTH-OR-NEITHER — a DB check
 * constraint rejects a half-filled window, because a lone start would produce
 * a null hours_worked indistinguishable from "no shift recorded".
 */
export interface GreeterMetricInputs extends GreeterSharedMetrics {
  shift_start: string | null;
  shift_end: string | null;
}

/** What the site's day form sends. */
export interface LocationMetricInputs extends GreeterSharedMetrics {
  total_cars: number | null;
  cancellations: number | null;
  total_members: number | null;
}

/**
 * Goal values snapshotted onto a submission at submit time. Copied from the
 * `greeter_goals` window covering `business_date` — deliberately frozen, so
 * editing a goal later can't rewrite whether a past day hit target. Null when
 * no goal window covered the date.
 *
 * Both are expressed in the SAME units as the actuals they grade
 * (capture_goal_pct vs capture_pct, dob_goal vs dob) so a comparison never has
 * to convert.
 */
export interface GreeterGoalSnapshot {
  capture_goal_pct: number | null;
  dob_goal: number | null;
}

/**
 * The site's day carries one extra goal: a monthly member LEVEL to reach, so it
 * only makes sense next to total_members and only on location_daily.
 */
export interface LocationGoalSnapshot extends GreeterGoalSnapshot {
  member_goal_month_end: number | null;
}

/**
 * Columns Postgres computes. Present on read, never sent on write — they are
 * GENERATED ALWAYS ... STORED and PostgREST rejects an insert that names them.
 * Null whenever wash_sales is 0/null (no opportunities is unknown, not zero).
 */
export interface GreeterDerivedMetrics {
  capture_pct: number | null;
  dob: number | null;
}

/**
 * Also generated, also read-only. Null when no shift window was recorded —
 * unrecorded throughput is unknown, not zero.
 */
export interface GreeterShiftDerived {
  hours_worked: number | null;
  wash_sales_per_hour: number | null;
}

/**
 * Location keying carried on every row. Resolved server-side at submit from
 * the picked location; never trusted from the client.
 *
 * - `site_number` is the stable cross-app join key.
 * - `location_code` exists for the caller-scoping filter only (session.locations
 *   is an array of location_codes). It has been observed to diverge between
 *   tables for the same site, so don't JOIN on it.
 */
export interface GreeterLocationKey {
  location_id: number;
  site_number: number;
  location_code: string;
}

/* ============================================================
 * Roster (Beekeeper people picker)
 * ============================================================ */

/** One selectable greeter. `id` is beekeeper_users.id — the value stored on
 *  greeter_daily.beekeeper_user_id. `name` is a display snapshot only. */
export interface GreeterRosterMember {
  id: string;
  name: string;
}

/**
 * Result of a roster lookup for one location.
 *
 * `mapped: false` is a real, expected state, NOT an error: the roster can only
 * be derived from a `beekeeper_schedules` row (that row holds the Beekeeper
 * org-unit id), so a site that hasn't been onboarded to the scheduler has no
 * roster at all. The UI must say so explicitly rather than rendering an empty
 * dropdown that looks like "nobody works here".
 */
export interface GreeterRoster {
  location_code: string;
  mapped: boolean;
  schedule_id: string | null;
  members: GreeterRosterMember[];
}

/* ============================================================
 * greeter_daily
 * ============================================================ */

export interface GreeterDailyInsert
  extends GreeterMetricInputs,
    GreeterGoalSnapshot,
    GreeterLocationKey {
  /** YYYY-MM-DD. The day being reported, not the submission time. */
  business_date: string;
  /** Beekeeper user uuid — matches beekeeper_users.id. Stable identity key. */
  beekeeper_user_id: string;
  /** Display snapshot, so historical rows read correctly after a rename. */
  greeter_name: string;
  comments: string | null;
  created_by: string;
  created_by_email: string;
}

export interface GreeterDailyRow
  extends GreeterDailyInsert,
    GreeterDerivedMetrics,
    GreeterShiftDerived {
  id: string;
  created_at: string;
  updated_at: string;
  updated_by: string | null;
  updated_by_email: string | null;
}

/* ============================================================
 * location_daily
 * ============================================================ */

export interface LocationDailyInsert
  extends LocationMetricInputs,
    LocationGoalSnapshot,
    GreeterLocationKey {
  business_date: string;
  comments: string | null;
  created_by: string;
  created_by_email: string;
}

export interface LocationDailyRow
  extends LocationDailyInsert,
    GreeterDerivedMetrics {
  id: string;
  /** Generated: sign_ups - cancellations. Read-only. */
  net_members: number | null;
  created_at: string;
  updated_at: string;
  updated_by: string | null;
  updated_by_email: string | null;
}

/* ============================================================
 * greeter_goals
 * ============================================================ */

export interface GreeterGoalInsert {
  site_number: number;
  location_code: string;
  /** YYYY-MM-DD. Inclusive. */
  effective_from: string;
  /** YYYY-MM-DD, inclusive. Null = open-ended / current goal. */
  effective_to: string | null;
  /** Percentage 0-100, graded against capture_pct. */
  capture_goal_pct: number;
  /** Dollars per wash sale, graded against dob. */
  dob_goal: number;
  /**
   * Total ACTIVE members the site should reach by month end. A level — not net
   * adds, not gross sign-ups — so it is graded against the most recent
   * location_daily.total_members in the window, never against a sum. Null when
   * the site doesn't set a membership target.
   */
  member_goal_month_end: number | null;
  note: string | null;
  created_by: string;
}

export interface GreeterGoalRow extends GreeterGoalInsert {
  id: string;
  created_at: string;
  updated_at: string;
}

/* ============================================================
 * Rollup (greeter_rollup() function)
 * ============================================================ */

/**
 * Per-greeter aggregate over a filtered range. Capture, DOB and
 * wash_sales_per_hour here are recomputed from summed numerators/denominators,
 * NOT averaged from the daily columns — averaging would weight a 3-car day the
 * same as a 300-car day, and a 2-hour shift the same as a 10-hour one.
 *
 * The two goal fields ARE averaged, because they are a percentage and a rate:
 * summing either across days yields a number that just grows with the range.
 *
 * Field list must stay in sync with greeter_rollup()'s RETURNS TABLE.
 */
export interface GreeterRollupRow extends GreeterDerivedMetrics {
  beekeeper_user_id: string;
  greeter_name: string;
  site_number: number;
  location_code: string;
  first_date: string;
  last_date: string;
  days_logged: number;
  wash_sales: number | null;
  rewashes: number | null;
  package_dollars: number | null;
  extras_dollars: number | null;
  sign_ups: number | null;
  hours_worked: number | null;
  wash_sales_per_hour: number | null;
  capture_goal_pct: number | null;
  dob_goal: number | null;
}
