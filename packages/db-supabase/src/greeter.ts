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
  GreeterDailyUpdate,
  GreeterGoalInsert,
  GreeterGoalRestampResult,
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
  LocationDailyUpdate,
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
 * DELEGATES TO greeter_goal_for() AND MUST CONTINUE TO. Overlapping windows are
 * legal — a promo week laid over a monthly baseline is the reason this feature
 * exists — and the rule for choosing between them (shortest span wins; an
 * open-ended window has infinite span and always loses to a bounded one) lives
 * in that function, once. This used to be a hand-built PostgREST filter with a
 * bare `.limit(1)` and no ordering, which was correct only for as long as the
 * `greeter_goals_no_overlap` exclusion constraint made two matches impossible.
 * That constraint is gone (greeter-goal-overlap-11.sql), so an unordered
 * limit-1 here would now return whichever of two windows Postgres handed back
 * first — a different answer on different days for the same submission.
 *
 * Callers snapshot the result onto the submission row — see the schema header
 * for why goals are frozen per-submission rather than joined at read time. The
 * corollary is greeter_restamp_goals(): a goal added for a window that is
 * partly in the past has to walk back over the days already entered under it.
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
  const { data, error } = await client.rpc("greeter_goal_for", {
    p_site_number: siteNumber,
    p_business_date: businessDate
  });
  if (error) throw error;

  // RETURNS TABLE, so PostgREST hands back an array even though the function
  // is LIMIT 1. Empty means no window covered the date, which is a normal
  // answer and not an error: the goal columns are nullable precisely so a day
  // nobody set a target for can say so. Do NOT substitute zeros — a zero
  // capture goal grades every day as a win.
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

/**
 * Remove a goal window, returning the row that was removed.
 *
 * RETURNS THE ROW BECAUSE THE CALLER NEEDS IT AFTER THE FACT. Deleting a goal
 * changes how days already submitted inside its window should be graded, and
 * re-stamping them needs the site and the window — which only exist on the row
 * that just stopped existing. Fetching it back afterwards is not an option.
 *
 * Null when no row matched. Deleting a goal that is already gone is not an
 * error worth raising: two clicks on the same button, or a stale page, and the
 * user's intent is satisfied either way.
 *
 * SCOPE IS PART OF THE DELETE, not a check in front of it. Passing the caller's
 * location_codes narrows the DELETE itself, so a location admin who guesses
 * another site's goal id removes nothing and gets the same null a stale id
 * gives. Doing it in one statement rather than read-then-check-then-delete is
 * what makes it atomic, and scopeCodes() turns an empty scope into a sentinel
 * that matches nothing — a scoping bug deletes zero rows rather than all of
 * them. `null` scope means no restriction (super_admin / dc-admin), matching
 * every other function in this module.
 *
 * There is no updateGreeterGoal, deliberately. A window is deleted and
 * re-entered so that exactly one code path has to re-stamp, and so the delete
 * confirmation is the only place the consequence has to be spelled out.
 */
export async function deleteGreeterGoal(
  client: SupabaseClient,
  id: string,
  opts: { location_scope?: string[] | null } = {}
): Promise<GreeterGoalRow | null> {
  let q = client.from("greeter_goals").delete().eq("id", id);

  const codes = scopeCodes(opts.location_scope);
  if (codes) q = q.in("location_code", codes);

  const { data, error } = await q.select();
  if (error) throw error;
  return ((data ?? [])[0] as unknown as GreeterGoalRow) ?? null;
}

/**
 * Re-resolve and rewrite the goal snapshot on every day already submitted in a
 * window, and report how many rows moved.
 *
 * Goals are frozen onto each submission at submit time, so a goal set today for
 * a window partly in the past leaves those days graded against whatever was in
 * force when they were typed. Without this, adding the special-week goal after
 * the special week would change nothing visible and look like a save that
 * silently failed. Josh confirmed those days should move.
 *
 * IT RE-RESOLVES RATHER THAN APPLYING ONE GOAL, which is why the same call
 * serves both the insert and the delete path: after an insert the promo week
 * inside a re-stamped baseline resolves to the promo again and is left alone;
 * after a delete the days fall back to whatever is left, or to nulls.
 *
 * `to` null means open-ended. Days in the future can't have submissions, so the
 * range is bounded by reality rather than by the argument.
 *
 * The two counts are different grains — four greeter rows and one site row is
 * one day at a four-greeter site — so they are reported separately and must not
 * be added together for display.
 */
export async function restampGoals(
  client: SupabaseClient,
  siteNumber: number,
  from: string,
  to: string | null
): Promise<GreeterGoalRestampResult> {
  const { data, error } = await client.rpc("greeter_restamp_goals", {
    p_site_number: siteNumber,
    p_from: from,
    p_to: to
  });
  if (error) throw error;

  const row = (data ?? [])[0] as
    | { greeter_rows: number | null; location_rows: number | null }
    | undefined;
  return {
    greeter_rows: row?.greeter_rows ?? 0,
    location_rows: row?.location_rows ?? 0
  };
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
 * `idx_greeter_daily_unique_live_day`, since every other unique column is a
 * generated uuid PK.
 *
 * `.is("voided_at", null)` IS LOAD-BEARING, not defensive. That index is
 * PARTIAL (live rows only), so struck-out rows pile up freely underneath the
 * live one at the same (location, greeter, date) — that is what makes a void
 * genuinely free the day. Without the filter this UPDATE matches the live row
 * AND every voided one: `.single()` then throws PGRST116 on an ordinary
 * correction, and every withdrawn row gets overwritten with the new numbers,
 * destroying the record of what was withdrawn. Which is the entire reason this
 * feature is a void and not a delete.
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
    // See the note above — the unique index is partial, so this is the only
    // thing keeping the correction off the struck-out rows beneath it.
    .is("voided_at", null)
    .select()
    .single();
  if (updErr) throw updErr;

  return { row: updated as unknown as GreeterDailyRow, corrected: true };
}

/** Site-wide day totals. Same insert-then-correct semantics as above, and the
 *  same load-bearing `.is("voided_at", null)` for the same reason. */
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
    .is("voided_at", null)
    .select()
    .single();
  if (updErr) throw updErr;

  return { row: updated as unknown as LocationDailyRow, corrected: true };
}

/* ============================================================
 * Corrections — update by id, void, restore
 * ============================================================ */

/**
 * Rewrite one greeter day, addressed by its id.
 *
 * BY ID, NOT BY THE NATURAL KEY, because an edit is allowed to change the date,
 * the site or the greeter — the three columns the natural key is made of. Going
 * through submitGreeterDay would insert a second row at the new coordinates and
 * leave the original standing at the old ones, which is how a typo becomes two
 * days that both look real. Addressing the row directly moves it instead.
 *
 * A key collision is therefore possible and is left to the database:
 * idx_greeter_daily_unique_live_day raises 23505 when the edit lands on a date
 * that site+greeter already has a live row for. That error propagates. The
 * caller must catch it and say which day is already taken — it is the one case
 * where the user can actually fix the problem, so it must not read as "save
 * failed".
 *
 * SCOPE NARROWS THE STATEMENT, exactly as in deleteGreeterGoal, so a location
 * admin who guesses another site's id updates nothing. That guard binds against
 * the row's CURRENT location_code, which is not enough on its own: an edit that
 * moves a day to a different site must also be allowed at the DESTINATION, or a
 * location admin could push their row into a site they don't administer and lose
 * sight of it. Hence the second check below. It sits in front of the statement
 * rather than inside it because the destination code isn't in the table yet —
 * it's in the payload.
 *
 * Null means the update matched nothing. Deliberately one return value for three
 * causes — no such id, not the caller's site, or already voided — because
 * distinguishing them would confirm to a location admin that another site's id
 * exists. Callers should phrase the message to cover all three.
 *
 * Voided rows are excluded on purpose: a struck-out row is restored first and
 * edited second, so that "what did this row say when it was withdrawn" stays
 * answerable.
 */
export async function updateGreeterDayById(
  client: SupabaseClient,
  id: string,
  patch: GreeterDailyUpdate,
  actor: DaySubmitActor,
  opts: { location_scope?: string[] | null } = {}
): Promise<GreeterDailyRow | null> {
  const codes = scopeCodes(opts.location_scope);
  if (codes && !codes.includes(patch.location_code)) return null;

  let q = client
    .from("greeter_daily")
    .update({
      ...patch,
      updated_by: actor.user_id,
      updated_by_email: actor.email
    })
    .eq("id", id)
    .is("voided_at", null);

  if (codes) q = q.in("location_code", codes);

  const { data, error } = await q.select();
  if (error) throw error;
  return ((data ?? [])[0] as unknown as GreeterDailyRow) ?? null;
}

/** Site-day equivalent of updateGreeterDayById — read that comment. */
export async function updateLocationDayById(
  client: SupabaseClient,
  id: string,
  patch: LocationDailyUpdate,
  actor: DaySubmitActor,
  opts: { location_scope?: string[] | null } = {}
): Promise<LocationDailyRow | null> {
  const codes = scopeCodes(opts.location_scope);
  if (codes && !codes.includes(patch.location_code)) return null;

  let q = client
    .from("location_daily")
    .update({
      ...patch,
      updated_by: actor.user_id,
      updated_by_email: actor.email
    })
    .eq("id", id)
    .is("voided_at", null);

  if (codes) q = q.in("location_code", codes);

  const { data, error } = await q.select();
  if (error) throw error;
  return ((data ?? [])[0] as unknown as LocationDailyRow) ?? null;
}

/**
 * Strike out a greeter day, returning the row that was struck.
 *
 * NOT A DELETE. The numbers stay on the row and the row keeps its id; only
 * voided_at is set, and every reporting function reads through the _live views,
 * so the day leaves every total at once. It also becomes MISSING again — the
 * site now has no standing answer for that date, which is the truth, and the
 * missing-days panel will start asking for it. That is intended, not a leak.
 *
 * `.is("voided_at", null)` keeps the FIRST voider's name on the row. Without it
 * a second click would overwrite voided_by with whoever clicked last, which is
 * the one fact this function exists to record.
 *
 * Null when nothing matched — same three-causes-one-value reasoning as
 * updateGreeterDayById, plus a fourth here (already voided). Voiding a day that
 * is already void is not an error worth raising: two clicks, or a stale page,
 * and the user's intent is satisfied either way.
 */
export async function voidGreeterDay(
  client: SupabaseClient,
  id: string,
  actor: DaySubmitActor,
  opts: { location_scope?: string[] | null } = {}
): Promise<GreeterDailyRow | null> {
  let q = client
    .from("greeter_daily")
    .update({
      voided_at: new Date().toISOString(),
      voided_by: actor.user_id,
      voided_by_email: actor.email
    })
    .eq("id", id)
    .is("voided_at", null);

  const codes = scopeCodes(opts.location_scope);
  if (codes) q = q.in("location_code", codes);

  const { data, error } = await q.select();
  if (error) throw error;
  return ((data ?? [])[0] as unknown as GreeterDailyRow) ?? null;
}

/** Site-day equivalent of voidGreeterDay. */
export async function voidLocationDay(
  client: SupabaseClient,
  id: string,
  actor: DaySubmitActor,
  opts: { location_scope?: string[] | null } = {}
): Promise<LocationDailyRow | null> {
  let q = client
    .from("location_daily")
    .update({
      voided_at: new Date().toISOString(),
      voided_by: actor.user_id,
      voided_by_email: actor.email
    })
    .eq("id", id)
    .is("voided_at", null);

  const codes = scopeCodes(opts.location_scope);
  if (codes) q = q.in("location_code", codes);

  const { data, error } = await q.select();
  if (error) throw error;
  return ((data ?? [])[0] as unknown as LocationDailyRow) ?? null;
}

/**
 * Put a struck-out greeter day back into the totals.
 *
 * CAN FAIL WITH 23505, which is the whole reason this isn't a trivial inverse.
 * While the row was void its slot was free, so someone may have re-entered the
 * day; restoring would then put two live rows on one (site, greeter, date) and
 * the partial unique index refuses. The error propagates and the caller has to
 * say so — "there is already a live entry for that day" is actionable, "restore
 * failed" is not.
 *
 * ALL THREE VOID COLUMNS ARE CLEARED, which does lose the record of who struck
 * the row out. The alternative — leaving voided_by set on a live row — is worse:
 * every reader that checks the wrong one of the three columns would conclude the
 * row is still withdrawn. A row is either struck out or it isn't.
 *
 * updated_by is deliberately NOT touched. It records who last typed the numbers,
 * and a restore doesn't change them; overwriting it would trade a true fact for
 * a misleading one. Same reasoning as greeter_restamp_goals.
 */
export async function restoreGreeterDay(
  client: SupabaseClient,
  id: string,
  opts: { location_scope?: string[] | null } = {}
): Promise<GreeterDailyRow | null> {
  let q = client
    .from("greeter_daily")
    .update({ voided_at: null, voided_by: null, voided_by_email: null })
    .eq("id", id)
    .not("voided_at", "is", null);

  const codes = scopeCodes(opts.location_scope);
  if (codes) q = q.in("location_code", codes);

  const { data, error } = await q.select();
  if (error) throw error;
  return ((data ?? [])[0] as unknown as GreeterDailyRow) ?? null;
}

/** Site-day equivalent of restoreGreeterDay — including the 23505. */
export async function restoreLocationDay(
  client: SupabaseClient,
  id: string,
  opts: { location_scope?: string[] | null } = {}
): Promise<LocationDailyRow | null> {
  let q = client
    .from("location_daily")
    .update({ voided_at: null, voided_by: null, voided_by_email: null })
    .eq("id", id)
    .not("voided_at", "is", null);

  const codes = scopeCodes(opts.location_scope);
  if (codes) q = q.in("location_code", codes);

  const { data, error } = await q.select();
  if (error) throw error;
  return ((data ?? [])[0] as unknown as LocationDailyRow) ?? null;
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
  /**
   * Default false — struck-out rows are hidden.
   *
   * Set true ONLY on the correction screens, which need to render a voided row
   * so that restoring it is reachable. Anything that totals, averages or charts
   * must leave this alone: a voided row still carries its full set of numbers,
   * so including one doesn't fail loudly, it just makes the number wrong.
   */
  include_voided?: boolean;
}

// No total_cars: it's site-level only. hours_worked / wash_sales_per_hour are
// generated from the shift window and read-only.
//
// The three void columns are selected in full, including the uuid, unlike
// created_by / updated_by above them — those two are omitted because nothing
// renders a raw uuid, and their _email twins carry the display value. voided_by
// is here anyway because VoidState declares it, and a row whose type promises a
// field the SELECT never asked for is a lie that costs more to debug than one
// uuid costs to fetch.
const DAY_COLS =
  "id,business_date,location_id,site_number,location_code," +
  "beekeeper_user_id,greeter_name," +
  "wash_sales,rewashes,package_dollars,extras_dollars,sign_ups,reactivations," +
  "google_reviews," +
  "shift_start,shift_end,hours_worked,wash_sales_per_hour," +
  "capture_goal_pct,dob_goal,capture_pct,dob," +
  "comments,created_at,created_by_email,updated_at,updated_by_email," +
  "voided_at,voided_by,voided_by_email";

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
  "comments,created_at,created_by_email,updated_at,updated_by_email," +
  "voided_at,voided_by,voided_by_email";

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
  // See the note in applyDayFilters — this list is hand-rolled rather than
  // sharing that helper because greeter-only filters don't apply to site rows,
  // so the void predicate has to be repeated here.
  if (!filters.include_voided) q = q.is("voided_at", null);

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
 * capture_pct and dob are NOT computed here and do not net house accounts or
 * rewashes off their denominators by company policy — they're generated
 * columns on location_daily. (capture_pct divides by wash_sales + sign_ups;
 * dob divides by wash_sales. Neither deducts anything the scan rate deducts.)
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
  // A PREDICATE HERE, A VIEW EVERYWHERE ELSE. The six SQL reporting functions go
  // through greeter_daily_live / location_daily_live precisely so they cannot
  // forget this line. The day list is the one read that must be able to see a
  // struck-out row — that's how a restore is reached — so it reads the base
  // table and opts out by default instead.
  if (!filters.include_voided) q = q.is("voided_at", null);
  return q;
}
