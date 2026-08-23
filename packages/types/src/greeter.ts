// Greeter scorecard types — daily per-greeter and per-location sales numbers.
// Schema: supabase/greeter-scorecard-tables.sql (read the header there for the
// metric vocabulary before changing anything numeric).
//
// Vocabulary reminder, because these names are easy to get subtly wrong:
//   total_cars    — every car through the tunnel, unlimited members included.
//                   SITE-LEVEL ONLY. Not a greeter's number: everyone on shift
//                   would report the same figure and summing across a crew
//                   would multiply the site's day.
//   wash_sales    — "ALC" / a-la-carte: NON-unlimited saleable cars. The whole
//                   denominator for dob, and part of capture_pct's (which adds
//                   sign_ups to it). NOT the same as total_cars.
//   total_members — active members as of that day. A LEVEL, not a delta. Never
//                   sum it across days; read it at the latest date in a window.
//   net_members   — sign_ups + reactivations - cancellations. THAT is the delta.
//   reactivations — lapsed members coming back. NOT sign_ups: a sign-up is a new
//                   member, the register counts them separately, and capture %
//                   deliberately excludes reactivations (the customer already
//                   knew the product, so they were never an opportunity).
//   dob           — dollars over base = (package $ + extras $) / wash_sales.
//   capture_pct   — sign_ups / (wash_sales + sign_ups) as a percentage (0-100),
//                   NOT a 0-1 fraction. A sign-up and a wash sale are the two
//                   possible outcomes for the same car, so both are in the
//                   denominator and the value cannot exceed 100. NULL only when
//                   both are zero. Changed 2026-08-22 — it used to divide by
//                   wash_sales alone, which let a good day read 400%. See
//                   supabase/greeter-capture-13.sql.
//   churn_pct     — the site's self-reported daily churn, as a percentage.
//                   SITE-LEVEL ONLY, and the one number here that must NEVER be
//                   aggregated: it arrives already divided, with the site
//                   keeping the members-lost count and the member base to
//                   itself, so there is nothing to re-sum. Any period figure
//                   would be a flat average of daily percentages, which is the
//                   exact error the rest of this schema is built to avoid.
//                   Day-level display only.
//   google_reviews— a COUNT of reviews collected that day, not a star rating.
//                   On both tables, informational, summed and nothing more.

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
  /**
   * Shared as a FIELD, not as a metric. Both forms collect it, but only the
   * site's copy is consumed by anything — it is one of the three inputs to
   * location_daily.net_members. The greeter's copy is optional and purely
   * informational (Josh, 2026-08-16: "make it optional for greeter and don't
   * calculate anything off of it"), so it feeds no rate, no goal and no
   * generated column, and in particular is NOT part of capture_pct on either
   * table.
   *
   * Null means "not reported"; 0 means "reported, and there were none". Do not
   * collapse the two — a blank box on the greeter form is not a confirmed zero.
   */
  reactivations: number | null;
  /**
   * Reviews collected that day. A COUNT, not a rating — if this ever needs to
   * hold a 1-5 star average it needs a different column, not a reinterpretation
   * of this one.
   *
   * Informational on BOTH tables. Summed for a period total and nothing else:
   * it is not in capture_pct, not in dob, has no goal, and grades nothing. Same
   * null-versus-zero rule as reactivations.
   */
  google_reviews: number | null;
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
  /**
   * Cars washed on a house account. Deliberately NOT on GreeterSharedMetrics:
   * nobody hands a greeter a house account to log under their own name, so it
   * is a site fact in the same way total_cars and cancellations are.
   *
   * A house-account car IS a wash sale and CANNOT be scanned, so it comes out
   * of the scan-rate denominator alongside rewashes. It does NOT come out of
   * capture_pct or dob — company policy keeps those gross. See
   * supabase/greeter-house-accounts-10.sql.
   */
  house_accounts: number | null;
  /**
   * Self-reported daily churn, percent (0-100), site only. Deliberately NOT on
   * GreeterSharedMetrics: a greeter has no member base to churn.
   *
   * Informational — no goal column, nothing grades on it, and it is never
   * aggregated across days. See the vocabulary note at the top of this file for
   * why a period churn number can't be derived from this column.
   */
  churn_pct: number | null;
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
 * Their null rules differ. `dob` is null whenever wash_sales is 0/null — it is
 * a per-wash average and there is nothing to average. `capture_pct` is null
 * only when wash_sales AND sign_ups are both 0/null: no wash sales but three
 * sign-ups is three opportunities, all three converted, a real 100%.
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

/**
 * Withdrawal state, carried by both daily tables.
 *
 * A day that was entered wrongly is struck out, not deleted: "submitted and
 * then withdrawn" is a different fact from "never submitted", and the second is
 * what the missing-days panel is for. `voided_at === null` means live.
 *
 * A ROW CARRYING THESE FIELDS IS NOT NECESSARILY SAFE TO COUNT. Every reporting
 * function in the database reads greeter_daily_live / location_daily_live and
 * so never sees a voided row at all; the only reads that return one are the
 * correction screens, which ask for it deliberately so a restore is reachable.
 * If you are summing rows in TypeScript, check this field.
 */
export interface VoidState {
  /** ISO timestamp, or null when the row is live. */
  voided_at: string | null;
  voided_by: string | null;
  voided_by_email: string | null;
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
    GreeterShiftDerived,
    VoidState {
  id: string;
  created_at: string;
  updated_at: string;
  updated_by: string | null;
  updated_by_email: string | null;
}

/**
 * The editable half of a greeter day.
 *
 * Deliberately omits created_by / created_by_email (an edit does not re-author
 * the row) and the location key + identity fields are present because an edit
 * MAY move a day to another site, greeter or date — that is the whole reason
 * updates go by id rather than by re-upserting on the natural key.
 */
export type GreeterDailyUpdate = Omit<
  GreeterDailyInsert,
  "created_by" | "created_by_email"
>;

/**
 * The narrowest shape an edit form needs in order to seed itself.
 *
 * Exists because the pages that render those forms do NOT hold a full
 * `GreeterDailyRow`: the list endpoints select a column subset (no created_by,
 * no updated_by), so a form prop typed as the full row would be unsatisfiable
 * from the only data the page has. Picking the fields the form actually renders
 * keeps the prop honest AND keeps it tied to the row type, so renaming a column
 * upstream breaks here rather than silently seeding an empty box.
 *
 * Read-only and derived columns are deliberately absent — capture_pct, dob,
 * hours_worked and the two goal snapshots are all recomputed or re-resolved on
 * save, so a field for any of them would collect a number the server overwrites.
 */
export type GreeterDayEditRow = Pick<
  GreeterDailyRow,
  | "id"
  | "business_date"
  | "location_id"
  | "beekeeper_user_id"
  | "greeter_name"
  | "shift_start"
  | "shift_end"
  | "wash_sales"
  | "rewashes"
  | "package_dollars"
  | "extras_dollars"
  | "sign_ups"
  | "reactivations"
  | "google_reviews"
  | "comments"
>;

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
    GreeterDerivedMetrics,
    VoidState {
  id: string;
  /** Generated: sign_ups + reactivations - cancellations. Read-only. */
  net_members: number | null;
  created_at: string;
  updated_at: string;
  updated_by: string | null;
  updated_by_email: string | null;
}

/** The editable half of a site day. See GreeterDailyUpdate. */
export type LocationDailyUpdate = Omit<
  LocationDailyInsert,
  "created_by" | "created_by_email"
>;

/** What the site day's edit form needs to seed itself. See GreeterDayEditRow. */
export type LocationDayEditRow = Pick<
  LocationDailyRow,
  | "id"
  | "business_date"
  | "location_id"
  | "total_cars"
  | "wash_sales"
  | "house_accounts"
  | "rewashes"
  | "package_dollars"
  | "extras_dollars"
  | "sign_ups"
  | "reactivations"
  | "cancellations"
  | "total_members"
  | "churn_pct"
  | "google_reviews"
  | "comments"
>;

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

/**
 * How many already-submitted days had their goal snapshot rewritten.
 *
 * Goal windows may overlap (shortest span wins — see greeter_goal_for in
 * supabase/greeter-scorecard-tables.sql), and goals are snapshotted onto each
 * submission at submit time. So adding or deleting a goal whose window is even
 * partly in the past has to go back and re-grade the days already entered under
 * the old answer. This is the report of that.
 *
 * THE TWO NUMBERS ARE DIFFERENT GRAINS AND MUST NOT BE ADDED. Four greeter rows
 * and one site row is one DAY at a four-greeter site; a banner reading "5 rows"
 * would be summing people-days with site-days.
 *
 * Both zero is the normal case for a goal set entirely in the future, and means
 * "nothing needed changing", never "the re-stamp failed".
 */
export interface GreeterGoalRestampResult {
  greeter_rows: number;
  location_rows: number;
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
  /** Plain total. Not folded into capture_pct — see GreeterSharedMetrics. */
  reactivations: number | null;
  /** Plain total. Same rule: a review is not a capture. */
  google_reviews: number | null;
  hours_worked: number | null;
  wash_sales_per_hour: number | null;
  capture_goal_pct: number | null;
  dob_goal: number | null;
}

/* ============================================================
 * Scan rates (greeter_scan_rates() function)
 * ============================================================ */

/**
 * One site day, with the share of it that greeters actually attributed to
 * themselves.
 *
 * `site_wash_sales` is every a-la-carte car the location sold;
 * `scanned_wash_sales` is the sum of what its greeters scanned for. The ratio
 * is a DATA-QUALITY signal, not a sales one — a low number means cars went
 * unattributed, so every per-greeter figure for that day is understated.
 *
 * THE RATIO'S DENOMINATOR IS `scannable_wash_sales`, NOT `site_wash_sales`.
 * House-account cars and rewashes are both wash sales that no customer can
 * scan a card for, so counting them would mark a site down for business it did
 * correctly. `site_wash_sales` is still returned because it is the number the
 * site recognises off its own report; the two deductions are returned
 * individually so the gap is explainable without opening the database.
 *
 * Two nullables that mean different things and must not be collapsed:
 *   scanned_pct === null      The site sold no SCANNABLE cars that day — it
 *                             sold nothing, or everything it sold was a house
 *                             account or a rewash. No denominator, so no rate;
 *                             not the same as having scanned nothing.
 *   ever_submitted === false  The location has never logged a single greeter
 *                             day: not onboarded, rather than slipping. Render
 *                             blank instead of flagging it at 0%.
 *
 * Field list must stay in sync with greeter_scan_rates()'s RETURNS TABLE.
 */
export interface GreeterScanRateRow {
  business_date: string;
  location_id: number;
  site_number: number;
  location_code: string;
  site_wash_sales: number | null;
  house_accounts: number | null;
  rewashes: number | null;
  /** site_wash_sales - house_accounts - rewashes, floored at 0. The denominator. */
  scannable_wash_sales: number;
  scanned_wash_sales: number;
  greeters_logged: number;
  scanned_pct: number | null;
  ever_submitted: boolean;
}

/* ============================================================
 * Missing days (greeter_missing_days() function)
 * ============================================================ */

/**
 * One location-day inside a requested window where a submission is MISSING.
 * Only gaps are returned — a complete day produces no row.
 *
 * Kept apart from the scan rate on purpose: "nobody reported" and "reported but
 * scanned badly" are different failures with different owners, and a day with
 * no submission has no scan rate to speak of. greeter_scan_rates() is driven
 * from location_daily, so a skipped day is invisible there rather than 0%.
 *
 * A full day is two submissions, and either can be absent independently:
 *   has_site_row === false      no location_daily row (usually the manager's).
 *   greeters_logged === 0       no greeter_daily rows (the crew's).
 *
 * The universe is locations that have EVER submitted either kind of row, so a
 * site never onboarded to the scorecard is silent here by design.
 *
 * Field list must stay in sync with greeter_missing_days()'s RETURNS TABLE.
 */
export interface GreeterMissingDayRow {
  business_date: string;
  location_id: number;
  site_number: number;
  location_code: string;
  has_site_row: boolean;
  greeters_logged: number;
}

/* ============================================================
 * Period report (greeter_period_report() function)
 * ============================================================ */

/**
 * One greeter at one site, aggregated over a date window, with their days
 * counted against the capture goal.
 *
 * WHY THIS EXISTS ALONGSIDE GreeterRollupRow: the day counts. `days_over_goal`
 * is tallied at the day grain before aggregation, which a rollup that has
 * already grouped cannot reconstruct — "18 of her 24 days beat goal" is not
 * derivable from a 24-day average capture %. Everything else here overlaps
 * with the rollup on purpose so one query can drive a whole report view.
 *
 * THE THREE DAY BUCKETS are mutually exclusive and sum to `days_logged`:
 *   days_over_goal    capture_pct >= capture_goal_pct (a tie is a hit)
 *   days_under_goal   capture_pct <  capture_goal_pct
 *   ungraded_days     no capture_pct (no wash sales AND no sign-ups, so
 *                     nothing happened and there is no rate) or no
 *                     capture_goal_pct (no goal covered the day). Surfaced
 *                     rather than dropped so the reader can see the real
 *                     denominator instead of trusting a percentage computed off
 *                     a subset they can't see.
 *
 * `pct_days_over` / `pct_days_under` are shares of `gradeable_days`, NOT of
 * `days_logged`. Both are null when nothing was gradeable — which is not the
 * same as 0 and must render differently.
 *
 * `low_sample` is true under 5 gradeable days. Two days, both missed, reads as
 * "100% under goal" and would otherwise top the underperformer list; these rows
 * sort to the BOTTOM of the performer lists with a note rather than being
 * hidden. The threshold lives in SQL so every view agrees on it.
 *
 * `capture_pct` and `dob` are weighted (summed numerator over summed
 * denominator), never averages of the daily columns. The two goal fields ARE
 * averages, because they are already rates.
 *
 * Field list must stay in sync with greeter_period_report()'s RETURNS TABLE.
 */
export interface GreeterPeriodReportRow {
  beekeeper_user_id: string;
  greeter_name: string;
  location_id: number;
  site_number: number;
  location_code: string;
  first_date: string;
  last_date: string;
  days_logged: number;
  gradeable_days: number;
  ungraded_days: number;
  days_over_goal: number;
  days_under_goal: number;
  pct_days_over: number | null;
  pct_days_under: number | null;
  low_sample: boolean;
  wash_sales: number | null;
  sign_ups: number | null;
  /** Plain total. Enters neither side of the goal comparison above. */
  reactivations: number | null;
  /** Plain total. Also enters neither side. */
  google_reviews: number | null;
  package_dollars: number | null;
  extras_dollars: number | null;
  hours_worked: number | null;
  wash_sales_per_hour: number | null;
  capture_goal_pct: number | null;
  dob_goal: number | null;
  capture_pct: number | null;
  dob: number | null;
}

/* ============================================================
 * Site day rows (location_period_rows() function)
 * ============================================================ */

/**
 * One site's one day, raw, plus how much of it greeters attributed.
 *
 * DELIBERATELY NOT AGGREGATED. The morning-call table groups these by site and
 * the trend chart groups them by date — two different groupings of the same
 * facts. Fetching the days once and grouping twice means the table and the
 * chart cannot disagree, which two separate aggregate endpoints could not
 * guarantee. Callers group by summing raw numerators and denominators, which
 * preserves the weighting rule.
 *
 * `total_members` IS A LEVEL, NOT A DELTA. Summing it across a window gives
 * roughly (days x members) and is always wrong. Read it at the latest
 * business_date present. Use `net_members` (sign_ups + reactivations -
 * cancellations) for the period's actual change.
 *
 * `churn_pct` IS ALREADY DIVIDED and has no companion numerator or denominator
 * on this row, so unlike every other rate here it cannot be re-derived from
 * sums. That makes it the one field a caller must NOT roll up — display it per
 * day and leave the period cell blank. See the vocabulary note at the top.
 *
 * Only submitted days appear — a day the site skipped produces no row, so
 * "reported 5 of 7" comes from counting rows against the window. Which specific
 * days are missing is GreeterMissingDayRow's job.
 *
 * Field list must stay in sync with location_period_rows()'s RETURNS TABLE.
 */
export interface LocationPeriodRow {
  /**
   * The location_daily row this came from, so the report's drill-through can
   * void a bad day where it's noticed instead of sending the reader to
   * /admin/greeters to find it again.
   *
   * Safe to treat as an identity because this function does not aggregate the
   * site side — one row per (location, business_date), straight off
   * location_daily_live. If a future caller ever rolls these up, the id must be
   * dropped from that shape rather than carried as the first row's.
   */
  id: string;
  business_date: string;
  location_id: number;
  site_number: number;
  location_code: string;
  total_cars: number | null;
  wash_sales: number | null;
  /**
   * Subtracted from wash_sales together with rewashes to get the scannable
   * denominator. The division happens in the report aggregator, not here — a
   * period scan rate is summed numerator over summed denominator, never an
   * average of daily percentages.
   */
  house_accounts: number | null;
  rewashes: number | null;
  package_dollars: number | null;
  extras_dollars: number | null;
  sign_ups: number | null;
  reactivations: number | null;
  cancellations: number | null;
  total_members: number | null;
  net_members: number | null;
  capture_pct: number | null;
  dob: number | null;
  capture_goal_pct: number | null;
  dob_goal: number | null;
  /** Day-level only. Never sum or average this — see the note above. */
  churn_pct: number | null;
  google_reviews: number | null;
  scanned_wash_sales: number;
  greeters_logged: number;
}
