// Greeter scorecard queries — greeter_daily / location_daily / greeter_goals.
// Schema + metric definitions: supabase/greeter-scorecard-tables.sql.
//
// Read that header before touching arithmetic here. Short version: `wash_sales`
// (a-la-carte, non-unlimited cars) is the denominator for both derived metrics,
// NOT `total_cars` (which is site-level only and absent from greeter_daily).
// `capture_pct`, `dob`, `hours_worked`, `wash_sales_per_hour` and `net_members`
// are Postgres GENERATED columns — this module never writes them, and PostgREST
// will reject an insert that names one.

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  GreeterDailyInsert,
  GreeterDailyRow,
  GreeterGoalInsert,
  GreeterGoalRow,
  GreeterLocationKey,
  GreeterMissingDayRow,
  GreeterPeriodReportRow,
  GreeterRollupRow,
  GreeterRoster,
  GreeterRosterMember,
  GreeterScanRateRow,
  LocationDailyInsert,
  LocationDailyRow,
  LocationGoalSnapshot,
  LocationPeriodRow
} from "@splash/types/greeter";

/* ============================================================
 * Location resolution
 * ============================================================ */

/**
 * Resolve the full location key from the id the LocationPicker submits.
 *
 * Two hops, because `locations` has no location_code column — its business key
 * is site_number, and pricing_simple is where the code lives:
 *
 *     locations.id -> locations.site_number -> pricing_simple.site -> location_code
 *
 * `pricing_simple.site` is site_number denormalized as TEXT by the
 * trg_sync_pricing_simple trigger, and its zero-padding has been observed to
 * diverge from the integer in `locations` (see the Brief 71 note in
 * locations.ts, where an unpadded/padded mismatch silently returned null for
 * every slug). We therefore probe the plain form first and fall back to
 * zero-padded variants rather than assuming one shape.
 *
 * Returns null when the location doesn't exist or has no pricing_simple row.
 * Callers MUST treat null as a hard reject and refuse the write: a row with a
 * null/garbage location_code would be invisible to its own location admin and
 * could leak into another site's scoped view.
 */
export async function resolveGreeterLocationKey(
  client: SupabaseClient,
  locationId: number
): Promise<GreeterLocationKey | null> {
  const { data: locRows, error: locErr } = await client
    .from("locations")
    .select("id,site_number")
    .eq("id", locationId)
    .limit(1);
  if (locErr) throw locErr;

  const loc = (locRows ?? [])[0] as { id: number; site_number: number | null } | undefined;
  const siteNumber = loc?.site_number;
  if (loc == null || siteNumber == null) return null;

  // Probe unpadded, then 3- and 4-digit zero-padded. Deduped so a site number
  // that's already 4 digits doesn't issue three identical queries.
  const raw = String(siteNumber);
  const candidates = [...new Set([raw, raw.padStart(3, "0"), raw.padStart(4, "0")])];

  const { data: psRows, error: psErr } = await client
    .from("pricing_simple")
    .select("location_code,site")
    .in("site", candidates)
    .limit(1);
  if (psErr) throw psErr;

  const code = ((psRows ?? [])[0] as { location_code?: string } | undefined)?.location_code;
  if (!code || !code.trim()) return null;

  return {
    location_id: loc.id,
    site_number: siteNumber,
    location_code: code.trim()
  };
}

/* ============================================================
 * Roster (Beekeeper people picker)
 * ============================================================ */

interface BeekeeperUserRow {
  id: string;
  display_name: string | null;
  firstname: string | null;
  lastname: string | null;
}

/** display_name -> "first last" -> "User xxxxxxxx". Mirrors nameFromRow() in
 *  beekeeper-worker/src/db.ts so the same person is labelled identically in
 *  the scheduler and the greeter picker. */
function rosterName(row: BeekeeperUserRow): string {
  if (row.display_name?.trim()) return row.display_name.trim();
  const joined = [row.firstname, row.lastname].filter(Boolean).join(" ").trim();
  return joined || `User ${row.id.slice(0, 8)}`;
}

/**
 * The assignable people at a location, for the greeter dropdown.
 *
 * Deliberately duplicated here rather than called across to beekeeper-worker:
 *
 *  1. beekeeper-worker gates every route on `scheduleGate` (the "schedule" /
 *     "pricing" tool grant). A user granted only "pertrack" would be 403'd by
 *     it, so reusing that worker would couple the greeter page to an unrelated
 *     permission.
 *  2. Its handlers 404 when no schedule is mapped, which is the wrong shape for
 *     a picker — we want to render an explanatory empty state instead.
 *
 * The Beekeeper org-unit id is only obtainable from `beekeeper_schedules`, so a
 * site with no mapped schedule genuinely has no roster; that returns
 * `mapped: false` with an empty list, which the caller must distinguish from a
 * mapped-but-empty schedule.
 */
export async function getGreeterRoster(
  client: SupabaseClient,
  locationCode: string
): Promise<GreeterRoster> {
  const code = locationCode.trim().toLowerCase();
  const empty: GreeterRoster = {
    location_code: code,
    mapped: false,
    schedule_id: null,
    members: []
  };
  if (!code) return empty;

  const { data: schedRows, error: schedErr } = await client
    .from("beekeeper_schedules")
    .select("schedule_id,location_ids,user_ids")
    .eq("location_code", code)
    .limit(1);
  if (schedErr) throw schedErr;

  const schedule = (schedRows ?? [])[0] as
    | { schedule_id: string; location_ids: string[] | null; user_ids: string[] | null }
    | undefined;
  if (!schedule) return empty;

  const byId = new Map<string, BeekeeperUserRow>();
  const orgUnitId = schedule.location_ids?.[0];

  if (orgUnitId) {
    // org_unit_ids is JSONB. postgrest-js turns a JS array into a Postgres
    // array literal (cs.{uuid}), which Postgres then fails to parse as JSON.
    // Passing a JSON string emits the containment form cs.["uuid"] instead.
    // (Same workaround as getRoster() in beekeeper-worker/src/db.ts.)
    const { data, error } = await client
      .from("beekeeper_users")
      .select("id,display_name,firstname,lastname")
      .contains("org_unit_ids", JSON.stringify([orgUnitId]));
    if (error) throw error;
    for (const r of (data ?? []) as BeekeeperUserRow[]) byId.set(r.id, r);
  }

  // Union in anyone the schedule names directly but whose org units don't list
  // this site — they're still assignable there.
  const missing = (schedule.user_ids ?? []).filter((id) => id && !byId.has(id));
  if (missing.length > 0) {
    const { data, error } = await client
      .from("beekeeper_users")
      .select("id,display_name,firstname,lastname")
      .in("id", [...new Set(missing)]);
    if (error) throw error;
    for (const r of (data ?? []) as BeekeeperUserRow[]) byId.set(r.id, r);
  }

  const members: GreeterRosterMember[] = [...byId.values()]
    .map((r) => ({ id: r.id, name: rosterName(r) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    location_code: code,
    mapped: true,
    schedule_id: schedule.schedule_id,
    members
  };
}

/* ============================================================
 * Goals
 * ============================================================ */

/**
 * The goal window covering `businessDate` for a site, or nulls when none does.
 *
 * The `greeter_goals_no_overlap` exclusion constraint guarantees at most one
 * matching window per site, so `limit(1)` is exact rather than arbitrary.
 * Callers snapshot the result onto the submission row — see the schema header
 * for why goals are frozen per-submission rather than joined at read time.
 *
 * Returns the LOCATION-shaped snapshot (the superset). The greeter path takes
 * only capture_goal_pct/dob_goal from it and drops member_goal_month_end, which
 * is a site-level membership target a single greeter can't be graded on.
 */
export async function getGoalSnapshot(
  client: SupabaseClient,
  siteNumber: number,
  businessDate: string
): Promise<LocationGoalSnapshot> {
  const { data, error } = await client
    .from("greeter_goals")
    .select("capture_goal_pct,dob_goal,member_goal_month_end")
    .eq("site_number", siteNumber)
    .lte("effective_from", businessDate)
    .or(`effective_to.gte.${businessDate},effective_to.is.null`)
    .limit(1);
  if (error) throw error;

  const row = (data ?? [])[0] as
    | {
        capture_goal_pct: number | null;
        dob_goal: number | null;
        member_goal_month_end: number | null;
      }
    | undefined;
  return {
    capture_goal_pct: row?.capture_goal_pct ?? null,
    dob_goal: row?.dob_goal ?? null,
    member_goal_month_end: row?.member_goal_month_end ?? null
  };
}

export async function listGreeterGoals(
  client: SupabaseClient,
  opts: { site_number?: number | null; location_scope?: string[] | null } = {}
): Promise<GreeterGoalRow[]> {
  let q = client
    .from("greeter_goals")
    .select("*")
    .order("site_number", { ascending: true })
    .order("effective_from", { ascending: false });

  if (opts.site_number != null) q = q.eq("site_number", opts.site_number);
  const goalScope = scopeCodes(opts.location_scope);
  if (goalScope) q = q.in("location_code", goalScope);

  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as unknown as GreeterGoalRow[];
}

export async function insertGreeterGoal(
  client: SupabaseClient,
  row: GreeterGoalInsert
): Promise<GreeterGoalRow> {
  const { data, error } = await client
    .from("greeter_goals")
    .insert(row)
    .select()
    .single();
  if (error) throw error;
  return data as unknown as GreeterGoalRow;
}

/* ============================================================
 * Scoping
 * ============================================================ */

/**
 * The location_codes a caller may see, or null for "no restriction".
 *
 * `undefined`/`null` scope means "all" (super_admin / dc-admin) and applies no
 * filter. An array restricts to those location_codes. An EMPTY array is
 * defended against with a sentinel that matches no real code — a scoping bug
 * must fail closed (show nothing) rather than open (show every site).
 *
 * Deliberately returns the codes instead of applying them: the three consumers
 * bind them differently (two supabase-js `.in()` calls and one rpc argument),
 * and a generic "apply to a query builder" helper can't be typed across a
 * PostgREST builder passed through another generic function. Keeping the rule
 * in one place and the binding at the call site is the part that matters.
 *
 * Mirrors applyLocationScope in forms-worker/src/db/admin-submissions.ts:35 —
 * that one builds a PostgREST URL directly, but the semantics are identical.
 */
function scopeCodes(scope: string[] | null | undefined): string[] | null {
  if (scope == null) return null;
  return scope.length > 0 ? scope : ["__no_location__"];
}

/* ============================================================
 * Writes
 * ============================================================ */

export interface DaySubmitActor {
  user_id: string;
  email: string;
}

/**
 * Insert a greeter's day, or correct the existing row for the same
 * (location, greeter, date).
 *
 * Implemented as insert-then-update-on-conflict rather than a single
 * `.upsert()` on purpose. An upsert writes every column in the payload, which
 * would stamp the *correcting* user over `created_by` and destroy the record of
 * who first logged the day. The second path instead leaves the creator columns
 * alone and sets `updated_by` / `updated_by_email`. The extra round trip only
 * happens on the correction path, which is the rare case.
 *
 * 23505 is Postgres' unique_violation — here it can only be
 * `greeter_daily_unique_day`, since every other unique column is a generated
 * uuid PK.
 */
export async function submitGreeterDay(
  client: SupabaseClient,
  row: GreeterDailyInsert,
  actor: DaySubmitActor
): Promise<{ row: GreeterDailyRow; corrected: boolean }> {
  const { data, error } = await client
    .from("greeter_daily")
    .insert(row)
    .select()
    .single();

  if (!error) {
    return { row: data as unknown as GreeterDailyRow, corrected: false };
  }
  if (error.code !== "23505") throw error;

  const { created_by: _c, created_by_email: _e, ...mutable } = row;
  const { data: updated, error: updErr } = await client
    .from("greeter_daily")
    .update({
      ...mutable,
      updated_by: actor.user_id,
      updated_by_email: actor.email
    })
    .eq("location_id", row.location_id)
    .eq("beekeeper_user_id", row.beekeeper_user_id)
    .eq("business_date", row.business_date)
    .select()
    .single();
  if (updErr) throw updErr;

  return { row: updated as unknown as GreeterDailyRow, corrected: true };
}

/** Site-wide day totals. Same insert-then-correct semantics as above. */
export async function submitLocationDay(
  client: SupabaseClient,
  row: LocationDailyInsert,
  actor: DaySubmitActor
): Promise<{ row: LocationDailyRow; corrected: boolean }> {
  const { data, error } = await client
    .from("location_daily")
    .insert(row)
    .select()
    .single();

  if (!error) {
    return { row: data as unknown as LocationDailyRow, corrected: false };
  }
  if (error.code !== "23505") throw error;

  const { created_by: _c, created_by_email: _e, ...mutable } = row;
  const { data: updated, error: updErr } = await client
    .from("location_daily")
    .update({
      ...mutable,
      updated_by: actor.user_id,
      updated_by_email: actor.email
    })
    .eq("location_id", row.location_id)
    .eq("business_date", row.business_date)
    .select()
    .single();
  if (updErr) throw updErr;

  return { row: updated as unknown as LocationDailyRow, corrected: true };
}

/* ============================================================
 * Reads
 * ============================================================ */

export interface GreeterDayFilters {
  date_from?: string | null;
  date_to?: string | null;
  location_id?: number | null;
  site_number?: number | null;
  beekeeper_user_id?: string | null;
  /** Substring match on the display-name snapshot. */
  greeter?: string | null;
  /** undefined = caller sees all sites; array = restrict to these codes. */
  location_scope?: string[] | null;
  limit?: number;
}

// No total_cars: it's site-level only. hours_worked / wash_sales_per_hour are
// generated from the shift window and read-only.
const DAY_COLS =
  "id,business_date,location_id,site_number,location_code," +
  "beekeeper_user_id,greeter_name," +
  "wash_sales,rewashes,package_dollars,extras_dollars,sign_ups,reactivations," +
  "google_reviews," +
  "shift_start,shift_end,hours_worked,wash_sales_per_hour," +
  "capture_goal_pct,dob_goal,capture_pct,dob," +
  "comments,created_at,created_by_email,updated_at,updated_by_email";

export async function listGreeterDays(
  client: SupabaseClient,
  filters: GreeterDayFilters = {}
): Promise<GreeterDailyRow[]> {
  let q = client
    .from("greeter_daily")
    .select(DAY_COLS)
    .order("business_date", { ascending: false })
    .order("greeter_name", { ascending: true })
    .limit(filters.limit ?? 500);

  q = applyDayFilters(q, filters);

  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as unknown as GreeterDailyRow[];
}

// house_accounts is here and deliberately absent from DAY_COLS above: it is a
// site fact, like total_cars and cancellations, and greeter_daily has no such
// column to select.
const LOCATION_DAY_COLS =
  "id,business_date,location_id,site_number,location_code," +
  "total_cars,wash_sales,house_accounts,rewashes,package_dollars,extras_dollars," +
  "sign_ups,reactivations,cancellations,total_members,net_members," +
  "churn_pct,google_reviews," +
  "capture_goal_pct,dob_goal,member_goal_month_end,capture_pct,dob," +
  "comments,created_at,created_by_email,updated_at,updated_by_email";

export async function listLocationDays(
  client: SupabaseClient,
  filters: GreeterDayFilters = {}
): Promise<LocationDailyRow[]> {
  let q = client
    .from("location_daily")
    .select(LOCATION_DAY_COLS)
    .order("business_date", { ascending: false })
    .limit(filters.limit ?? 500);

  if (filters.date_from) q = q.gte("business_date", filters.date_from);
  if (filters.date_to) q = q.lte("business_date", filters.date_to);
  if (filters.location_id != null) q = q.eq("location_id", filters.location_id);
  if (filters.site_number != null) q = q.eq("site_number", filters.site_number);
  const locScope = scopeCodes(filters.location_scope);
  if (locScope) q = q.in("location_code", locScope);

  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as unknown as LocationDailyRow[];
}

/**
 * Per-greeter totals for the same filter set the day list uses.
 *
 * Calls the `greeter_rollup()` SQL function rather than selecting from a view.
 * A view would aggregate before the date filter could bind (the grouped result
 * has first_date/last_date, not business_date), so every caller would silently
 * get an all-time rollup. The function takes the filters as arguments and
 * applies them to the base rows first.
 *
 * Capture and DOB come back recomputed from summed numerators/denominators. Do
 * NOT reimplement this by averaging the per-day `capture_pct` values — that
 * weights a 3-car day equally with a 300-car day.
 *
 * No `limit` here on purpose: this is the aggregate the summary row reads, and
 * truncating it would produce a total that silently disagrees with the day
 * list it summarizes. Cardinality is bounded by (greeters x sites) in range.
 */
export async function listGreeterRollup(
  client: SupabaseClient,
  filters: GreeterDayFilters = {}
): Promise<GreeterRollupRow[]> {
  const needle = filters.greeter?.replace(/[(),*]/g, "").trim();
  const { data, error } = await client.rpc("greeter_rollup", {
    p_date_from: filters.date_from ?? null,
    p_date_to: filters.date_to ?? null,
    p_location_id: filters.location_id ?? null,
    p_site_number: filters.site_number ?? null,
    p_beekeeper_user_id: filters.beekeeper_user_id ?? null,
    p_greeter: needle ? needle : null,
    // null = caller sees every site. An empty scope array must fail closed, so
    // scopeCodes() turns it into a sentinel that matches no real code.
    p_location_codes: scopeCodes(filters.location_scope)
  });
  if (error) throw error;
  return (data ?? []) as unknown as GreeterRollupRow[];
}

/**
 * Per site-day scan rates: what share of a location's SCANNABLE a-la-carte cars
 * its greeters actually scanned for.
 *
 * "Scannable" is the site's wash sales less its house accounts and its
 * rewashes, floored at 0. Both deductions are real wash sales that no customer
 * could scan a card against, so counting them would mark a site down for cars
 * that were never in play. The function returns the deduction's inputs
 * (site_wash_sales, house_accounts, rewashes) alongside scannable_wash_sales so
 * the UI can show its work rather than asserting a number.
 *
 * capture_pct and dob are NOT computed here and stay on gross wash sales by
 * company policy — they're generated columns on location_daily.
 *
 * A function again, for the same reason as the rollup — and additionally
 * because the numerator lives in a different table from the denominator, so it
 * can't be a generated column: a stored value would go stale the moment a late
 * greeter row landed.
 *
 * `filters.greeter` and `filters.beekeeper_user_id` are deliberately NOT passed
 * through, and greeter_scan_rates() doesn't accept them. The denominator is the
 * whole site's day, so the numerator has to be every greeter at that site —
 * filtering it by name would make a site look underreported whenever somebody
 * typed a name in the filter bar.
 *
 * No `limit`: one row per site-day in range, and the caller's date window is
 * what bounds it.
 */
export async function listGreeterScanRates(
  client: SupabaseClient,
  filters: GreeterDayFilters = {}
): Promise<GreeterScanRateRow[]> {
  const { data, error } = await client.rpc("greeter_scan_rates", {
    p_date_from: filters.date_from ?? null,
    p_date_to: filters.date_to ?? null,
    p_location_id: filters.location_id ?? null,
    p_site_number: filters.site_number ?? null,
    // Same fail-closed rule as the rollup: an empty scope must show nothing.
    p_location_codes: scopeCodes(filters.location_scope)
  });
  if (error) throw error;
  return (data ?? []) as unknown as GreeterScanRateRow[];
}

/**
 * Location-days inside a window with a submission missing — either the site's
 * own numbers or its greeters', reported independently.
 *
 * A deliberately separate question from the scan rate: a day nobody reported
 * has no scan rate at all (greeter_scan_rates() is driven from location_daily,
 * so a skipped day produces no row there), and "didn't report" and "reported
 * but scanned badly" have different owners and different fixes.
 *
 * BOTH DATES ARE REQUIRED. The underlying function builds an
 * (onboarded locations x days) grid, so an unbounded window would try to
 * materialise every day since the first submission. Callers that don't have a
 * window should not call this.
 *
 * `greeter` / `beekeeper_user_id` are not passed through — a named greeter's
 * absence is not the same as nobody logging the day.
 */
export async function listGreeterMissingDays(
  client: SupabaseClient,
  window: { date_from: string; date_to: string },
  filters: Omit<GreeterDayFilters, "date_from" | "date_to"> = {}
): Promise<GreeterMissingDayRow[]> {
  const { data, error } = await client.rpc("greeter_missing_days", {
    p_date_from: window.date_from,
    p_date_to: window.date_to,
    p_location_id: filters.location_id ?? null,
    p_site_number: filters.site_number ?? null,
    p_location_codes: scopeCodes(filters.location_scope)
  });
  if (error) throw error;
  return (data ?? []) as unknown as GreeterMissingDayRow[];
}

/**
 * Per-greeter aggregation for a window, WITH each greeter's days counted for
 * and against their capture goal.
 *
 * Distinct from listGreeterRollup() only in those day counts, and that is the
 * whole point: they are tallied at the day grain inside the function, before
 * aggregation, so no amount of post-processing on a rollup row could produce
 * them.
 *
 * Window is REQUIRED. Every caller is a report view with a stated period, and
 * an unbounded call would aggregate all of history behind a heading that claims
 * to be about the last 7 days.
 *
 * Returns EVERY greeter in the window — no threshold filtering here. The
 * "underperformers" and "top performers" views are thresholds applied by the
 * page over these rows, so a new preset needs no migration and no new endpoint.
 * Rows with `low_sample` are included and must be sorted to the bottom of those
 * lists, not dropped.
 *
 * The `greeter` needle is sanitised the same way listGreeterRollup() does it,
 * for the same reason.
 */
export async function listGreeterPeriodReport(
  client: SupabaseClient,
  window: { date_from: string; date_to: string },
  filters: Omit<GreeterDayFilters, "date_from" | "date_to"> = {}
): Promise<GreeterPeriodReportRow[]> {
  const needle = filters.greeter?.replace(/[(),*]/g, "").trim();
  const { data, error } = await client.rpc("greeter_period_report", {
    p_date_from: window.date_from,
    p_date_to: window.date_to,
    p_location_id: filters.location_id ?? null,
    p_site_number: filters.site_number ?? null,
    p_beekeeper_user_id: filters.beekeeper_user_id ?? null,
    p_greeter: needle ? needle : null,
    p_location_codes: scopeCodes(filters.location_scope)
  });
  if (error) throw error;
  return (data ?? []) as unknown as GreeterPeriodReportRow[];
}

/**
 * Raw site days for a window, each enriched with how much of it greeters
 * attributed to themselves.
 *
 * NOT AGGREGATED, on purpose. The caller groups these by site for the
 * morning-call table and by date for the trend chart. One fetch, two groupings,
 * and the two can never disagree — which is exactly what would eventually
 * happen with a separate totals endpoint and a separate trend endpoint.
 *
 * When you group these: sum the raw numerators and denominators and divide at
 * the end. Averaging the per-day `capture_pct` / `dob` columns weights a 3-car
 * day the same as a 300-car one.
 *
 * DO NOT SUM `total_members`. It is a level — active members as of that day —
 * so a week's worth sums to roughly seven times reality. Read it at the latest
 * `business_date` in the set; use `net_members` for the period's change.
 *
 * Window is REQUIRED: this returns day rows, so an unbounded call returns every
 * site day ever recorded.
 *
 * `greeter` / `beekeeper_user_id` are deliberately not passed through. These
 * are site facts, and filtering the attribution numerator by one person's name
 * would make sites look underreported whenever someone typed in the filter bar.
 */
export async function listLocationPeriodRows(
  client: SupabaseClient,
  window: { date_from: string; date_to: string },
  filters: Omit<GreeterDayFilters, "date_from" | "date_to"> = {}
): Promise<LocationPeriodRow[]> {
  const { data, error } = await client.rpc("location_period_rows", {
    p_date_from: window.date_from,
    p_date_to: window.date_to,
    p_location_id: filters.location_id ?? null,
    p_site_number: filters.site_number ?? null,
    p_location_codes: scopeCodes(filters.location_scope)
  });
  if (error) throw error;
  return (data ?? []) as unknown as LocationPeriodRow[];
}

/** Shared predicate builder for greeter_daily and its rollup view. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyDayFilters<T extends Record<string, any>>(
  query: T,
  filters: GreeterDayFilters
): T {
  let q = query;
  if (filters.date_from) q = q.gte("business_date", filters.date_from);
  if (filters.date_to) q = q.lte("business_date", filters.date_to);
  if (filters.location_id != null) q = q.eq("location_id", filters.location_id);
  if (filters.site_number != null) q = q.eq("site_number", filters.site_number);
  if (filters.beekeeper_user_id) {
    q = q.eq("beekeeper_user_id", filters.beekeeper_user_id);
  }
  if (filters.greeter && filters.greeter.trim()) {
    // Strip PostgREST's filter-grammar metacharacters — an unescaped comma or
    // paren would terminate the ilike operand and change the query shape.
    const needle = filters.greeter.replace(/[(),*]/g, "").trim();
    if (needle) q = q.ilike("greeter_name", `*${needle}*`);
  }
  const scope = scopeCodes(filters.location_scope);
  if (scope) q = q.in("location_code", scope);
  return q;
}
