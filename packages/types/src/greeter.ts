// Greeter scorecard types — daily per-greeter and per-location sales numbers.
// Schema: supabase/greeter-scorecard-tables.sql (read the header there for the
// metric vocabulary before changing anything numeric).
//
// Vocabulary reminder, because these names are easy to get subtly wrong:
//   total_cars  — every car through the tunnel, unlimited members included.
//   wash_sales  — "ALC" / a-la-carte: NON-unlimited saleable cars. Denominator
//                 for both derived metrics. NOT the same as total_cars.
//   dob         — dollars over base = (package $ + extras $) / wash_sales.
//   capture_pct — sign_ups / wash_sales as a percentage (0-100), NOT a 0-1
//                 fraction, matching performance_tracking.capture_rate.

/** The five typed-in metrics, shared by the greeter and location day forms. */
export interface GreeterMetricInputs {
  total_cars: number | null;
  wash_sales: number | null;
  package_dollars: number | null;
  extras_dollars: number | null;
  sign_ups: number | null;
}

/**
 * Goal values snapshotted onto a submission at submit time. Copied from the
 * `greeter_goals` window covering `business_date` — deliberately frozen, so
 * editing a goal later can't rewrite whether a past day hit target. Both null
 * when no goal window covered the date.
 */
export interface GreeterGoalSnapshot {
  sign_up_goal: number | null;
  extras_goal: number | null;
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
    GreeterDerivedMetrics {
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
  extends GreeterMetricInputs,
    GreeterGoalSnapshot,
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
  sign_up_goal: number;
  extras_goal: number;
  note: string | null;
  created_by: string;
}

export interface GreeterGoalRow extends GreeterGoalInsert {
  id: string;
  created_at: string;
  updated_at: string;
}

/* ============================================================
 * Rollup (greeter_daily_rollup view)
 * ============================================================ */

/**
 * Per-greeter aggregate over a filtered range. Capture and DOB here are
 * recomputed from summed numerators/denominators, NOT averaged from the daily
 * columns — averaging would weight a 3-car day the same as a 300-car day.
 */
export interface GreeterRollupRow extends GreeterDerivedMetrics {
  beekeeper_user_id: string;
  greeter_name: string;
  site_number: number;
  location_code: string;
  first_date: string;
  last_date: string;
  days_logged: number;
  total_cars: number | null;
  wash_sales: number | null;
  package_dollars: number | null;
  extras_dollars: number | null;
  sign_ups: number | null;
  sign_up_goal: number | null;
  extras_goal: number | null;
}
