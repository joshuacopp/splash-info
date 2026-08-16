// Greeter scorecard endpoints for performance-worker.
//
// Split out of index.ts because this is a second, independent feature living
// behind the same "pertrack" grant — the visit-based tracker (/api/submissions)
// and the daily scorecard (/api/greeter/*) share auth and nothing else.
//
// Owned routes (post-prefix-strip, all gated by index.ts before dispatch):
//   GET  /api/greeter/roster         ?location_id=   -> Beekeeper people picker
//   GET  /api/greeter/days           filters         -> per-greeter day rows
//   POST /api/greeter/days                           -> submit/correct a day
//   GET  /api/greeter/rollup         filters         -> per-greeter aggregate
//   GET  /api/greeter/location-days  filters         -> site-wide day rows
//   POST /api/greeter/location-days                  -> submit/correct a day
//   GET  /api/greeter/goals          ?site_number=   -> goal windows
//   POST /api/greeter/goals                          -> add a goal window
//
// SCOPING RULE, applied identically to reads and writes:
//   Full admin tier (super_admin / dcRole admin|super_admin) -> undefined scope,
//   no filter. Everyone else -> their session.locations, lowercased. An empty
//   array reaches applyScope() in @splash/db-supabase, which substitutes a
//   sentinel so a scoping bug shows nothing rather than everything.
//
//   Writes go further: the location is resolved server-side from location_id and
//   the resulting location_code is checked against the caller's scope. The
//   client never supplies site_number or location_code — trusting either would
//   let a location admin stamp another site's rows.

import type { Session } from "@splash/auth";
import {
  createServiceClient,
  getGoalSnapshot,
  getGreeterRoster,
  insertGreeterGoal,
  listGreeterDays,
  listGreeterGoals,
  listGreeterRollup,
  listLocationDays,
  resolveGreeterLocationKey,
  submitGreeterDay,
  submitLocationDay,
  type GreeterDayFilters,
  type SupabaseEnv
} from "@splash/db-supabase";
import { json as jsonResponse } from "@splash/http";
import type {
  GreeterDailyInsert,
  GreeterLocationKey,
  LocationDailyInsert
} from "@splash/types/greeter";

type Env = SupabaseEnv;

/** Paths this module owns, as (method, path) pairs index.ts can test cheaply. */
export function isGreeterRoute(pathname: string, method: string): boolean {
  switch (pathname) {
    case "/api/greeter/roster":
    case "/api/greeter/rollup":
      return method === "GET";
    case "/api/greeter/days":
    case "/api/greeter/location-days":
    case "/api/greeter/goals":
      return method === "GET" || method === "POST";
    default:
      return false;
  }
}

/**
 * Dispatch a greeter route. index.ts has already authenticated the request and
 * confirmed the "pertrack" grant; this function assumes both.
 * Returns null when the path isn't ours, so index.ts can fall through to 404.
 */
export async function handleGreeterRoute(
  pathname: string,
  method: string,
  request: Request,
  url: URL,
  env: Env,
  session: Session
): Promise<Response | null> {
  const scope = locationScopeFor(session);

  if (pathname === "/api/greeter/roster" && method === "GET") {
    return apiRoster(url, env, scope);
  }
  if (pathname === "/api/greeter/days" && method === "GET") {
    return apiListGreeterDays(url, env, scope);
  }
  if (pathname === "/api/greeter/days" && method === "POST") {
    return apiSubmitGreeterDay(request, env, session, scope);
  }
  if (pathname === "/api/greeter/rollup" && method === "GET") {
    return apiRollup(url, env, scope);
  }
  if (pathname === "/api/greeter/location-days" && method === "GET") {
    return apiListLocationDays(url, env, scope);
  }
  if (pathname === "/api/greeter/location-days" && method === "POST") {
    return apiSubmitLocationDay(request, env, session, scope);
  }
  if (pathname === "/api/greeter/goals" && method === "GET") {
    return apiListGoals(url, env, scope);
  }
  if (pathname === "/api/greeter/goals" && method === "POST") {
    return apiCreateGoal(request, env, session, scope);
  }
  return null;
}

/* ============================================================
 * Scoping
 * ============================================================ */

/**
 * `undefined` = sees every site. An array = restricted to those location_codes.
 *
 * Mirrors submissionGate() in forms-worker/src/admin/auth.ts, with one
 * deliberate difference: a location admin holding "pertrack" but assigned no
 * locations gets an EMPTY array (sees nothing) rather than a 403. Forms treats
 * that as forbidden; here the page still needs to render its filter bar and
 * empty state, and applyScope() already fails closed on an empty array.
 */
function locationScopeFor(session: Session): string[] | undefined {
  if (
    session.role === "super_admin" ||
    session.dcRole === "admin" ||
    session.dcRole === "super_admin"
  ) {
    return undefined;
  }
  return session.locations.map((l) => l.toLowerCase());
}

/** True when the caller may read/write rows stamped with this location_code. */
function inScope(scope: string[] | undefined, locationCode: string): boolean {
  if (scope === undefined) return true;
  return scope.includes(locationCode.toLowerCase());
}

/**
 * Resolve the client's location_id into the full key, refusing anything the
 * caller can't reach.
 *
 * A null from resolveGreeterLocationKey means the site has no pricing_simple
 * row and therefore no location_code — see the note there for why that MUST be
 * a hard reject rather than a null-code insert.
 */
async function resolveWritableLocation(
  env: Env,
  locationId: number,
  scope: string[] | undefined
): Promise<
  { ok: true; key: GreeterLocationKey } | { ok: false; response: Response }
> {
  const sb = createServiceClient(env);
  const key = await resolveGreeterLocationKey(sb, locationId);
  if (!key) {
    return {
      ok: false,
      response: jsonResponse(
        {
          error: "unknown location",
          reason:
            "That location has no pricing_simple row, so it has no location_code to stamp on the row."
        },
        400
      )
    };
  }
  if (!inScope(scope, key.location_code)) {
    return { ok: false, response: jsonResponse({ error: "forbidden" }, 403) };
  }
  return { ok: true, key };
}

/* ============================================================
 * Roster
 * ============================================================ */

/**
 * People picker for a location. Takes location_id (what the LocationPicker
 * submits) and resolves the code server-side rather than accepting a raw
 * location_code, so the scope check can't be sidestepped by guessing a code.
 *
 * `mapped: false` in the response is a normal outcome, not an error: the
 * Beekeeper org-unit id only exists on a beekeeper_schedules row, so a site not
 * yet onboarded to the scheduler has no roster. Render that as an explanation,
 * not as an empty dropdown.
 */
async function apiRoster(
  url: URL,
  env: Env,
  scope: string[] | undefined
): Promise<Response> {
  const locationId = toIntOrNull(url.searchParams.get("location_id"));
  if (locationId == null) {
    return jsonResponse({ error: "location_id is required" }, 400);
  }

  const sb = createServiceClient(env);
  const key = await resolveGreeterLocationKey(sb, locationId);
  if (!key) return jsonResponse({ error: "unknown location" }, 404);
  if (!inScope(scope, key.location_code)) {
    return jsonResponse({ error: "forbidden" }, 403);
  }

  const roster = await getGreeterRoster(sb, key.location_code);
  return jsonResponse({ ...roster, site_number: key.site_number });
}

/* ============================================================
 * Reads
 * ============================================================ */

/** Shared query-string -> GreeterDayFilters parse for all three read paths. */
function filtersFromQuery(url: URL, scope: string[] | undefined): GreeterDayFilters {
  const sp = url.searchParams;
  return {
    date_from: sp.get("date_from"),
    date_to: sp.get("date_to"),
    location_id: toIntOrNull(sp.get("location_id")),
    site_number: toIntOrNull(sp.get("site_number")),
    beekeeper_user_id: sp.get("beekeeper_user_id"),
    greeter: sp.get("greeter"),
    location_scope: scope ?? null,
    limit: toIntOrNull(sp.get("limit")) ?? 500
  };
}

async function apiListGreeterDays(
  url: URL,
  env: Env,
  scope: string[] | undefined
): Promise<Response> {
  const sb = createServiceClient(env);
  const rows = await listGreeterDays(sb, filtersFromQuery(url, scope));
  return jsonResponse(rows);
}

async function apiRollup(
  url: URL,
  env: Env,
  scope: string[] | undefined
): Promise<Response> {
  const sb = createServiceClient(env);
  const rows = await listGreeterRollup(sb, filtersFromQuery(url, scope));
  return jsonResponse(rows);
}

async function apiListLocationDays(
  url: URL,
  env: Env,
  scope: string[] | undefined
): Promise<Response> {
  const sb = createServiceClient(env);
  const rows = await listLocationDays(sb, filtersFromQuery(url, scope));
  return jsonResponse(rows);
}

async function apiListGoals(
  url: URL,
  env: Env,
  scope: string[] | undefined
): Promise<Response> {
  const sb = createServiceClient(env);
  const rows = await listGreeterGoals(sb, {
    site_number: toIntOrNull(url.searchParams.get("site_number")),
    location_scope: scope ?? null
  });
  return jsonResponse(rows);
}

/* ============================================================
 * Writes
 * ============================================================ */

async function apiSubmitGreeterDay(
  request: Request,
  env: Env,
  session: Session,
  scope: string[] | undefined
): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

  const businessDate = isoDateOrNull(body.business_date);
  if (!businessDate) {
    return jsonResponse({ error: "business_date (YYYY-MM-DD) is required" }, 400);
  }
  const locationId = toIntOrNull(body.location_id);
  if (locationId == null) {
    return jsonResponse({ error: "location_id is required" }, 400);
  }
  const beekeeperUserId = trimOrNull(body.beekeeper_user_id);
  if (!beekeeperUserId) {
    return jsonResponse({ error: "beekeeper_user_id is required" }, 400);
  }
  const greeterName = trimOrNull(body.greeter_name);
  if (!greeterName) {
    return jsonResponse({ error: "greeter_name is required" }, 400);
  }

  // Both-or-neither, enforced here as well as by greeter_daily_shift_pair, so
  // the caller gets a readable 400 instead of a raw constraint violation.
  const shiftStart = timeOrNull(body.shift_start);
  const shiftEnd = timeOrNull(body.shift_end);
  if ((shiftStart === null) !== (shiftEnd === null)) {
    return jsonResponse(
      {
        error: "incomplete shift",
        reason:
          "Give both a shift start and a shift end, or neither. A half-filled window can't produce hours worked."
      },
      400
    );
  }

  const resolved = await resolveWritableLocation(env, locationId, scope);
  if (!resolved.ok) return resolved.response;

  const sb = createServiceClient(env);
  // Snapshot the goal that was in force on the business date — not today's.
  // Backfilling last month must grade against last month's target.
  // member_goal_month_end is dropped: it's a site membership target, and a
  // single greeter's day is not the thing it grades. greeter_daily has no such
  // column, and PostgREST would reject the insert if it were spread in.
  const { member_goal_month_end: _memberGoal, ...greeterGoal } =
    await getGoalSnapshot(sb, resolved.key.site_number, businessDate);

  const row: GreeterDailyInsert = {
    business_date: businessDate,
    ...resolved.key,
    beekeeper_user_id: beekeeperUserId,
    greeter_name: greeterName,
    wash_sales: toIntOrNull(body.wash_sales),
    rewashes: toIntOrNull(body.rewashes),
    package_dollars: toNumOrNull(body.package_dollars),
    extras_dollars: toNumOrNull(body.extras_dollars),
    sign_ups: toIntOrNull(body.sign_ups),
    shift_start: shiftStart,
    shift_end: shiftEnd,
    ...greeterGoal,
    comments: trimOrNull(body.comments),
    created_by: session.userId,
    created_by_email: session.email
  };

  const { row: saved, corrected } = await submitGreeterDay(sb, row, {
    user_id: session.userId,
    email: session.email
  });
  return jsonResponse({ row: saved, corrected }, corrected ? 200 : 201);
}

async function apiSubmitLocationDay(
  request: Request,
  env: Env,
  session: Session,
  scope: string[] | undefined
): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

  const businessDate = isoDateOrNull(body.business_date);
  if (!businessDate) {
    return jsonResponse({ error: "business_date (YYYY-MM-DD) is required" }, 400);
  }
  const locationId = toIntOrNull(body.location_id);
  if (locationId == null) {
    return jsonResponse({ error: "location_id is required" }, 400);
  }

  const resolved = await resolveWritableLocation(env, locationId, scope);
  if (!resolved.ok) return resolved.response;

  const sb = createServiceClient(env);
  const goal = await getGoalSnapshot(sb, resolved.key.site_number, businessDate);

  const row: LocationDailyInsert = {
    business_date: businessDate,
    ...resolved.key,
    total_cars: toIntOrNull(body.total_cars),
    wash_sales: toIntOrNull(body.wash_sales),
    rewashes: toIntOrNull(body.rewashes),
    package_dollars: toNumOrNull(body.package_dollars),
    extras_dollars: toNumOrNull(body.extras_dollars),
    sign_ups: toIntOrNull(body.sign_ups),
    cancellations: toIntOrNull(body.cancellations),
    total_members: toIntOrNull(body.total_members),
    ...goal,
    comments: trimOrNull(body.comments),
    created_by: session.userId,
    created_by_email: session.email
  };

  const { row: saved, corrected } = await submitLocationDay(sb, row, {
    user_id: session.userId,
    email: session.email
  });
  return jsonResponse({ row: saved, corrected }, corrected ? 200 : 201);
}

/**
 * Add a goal window.
 *
 * Overlapping windows for a site are rejected by the greeter_goals_no_overlap
 * exclusion constraint (Postgres 23P01), surfaced here as a 409 with an
 * actionable message — otherwise it reads as an opaque 500. Closing the
 * previous window is a separate edit, on purpose: silently truncating an
 * existing goal would change how already-submitted days are graded.
 */
async function apiCreateGoal(
  request: Request,
  env: Env,
  session: Session,
  scope: string[] | undefined
): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

  const effectiveFrom = isoDateOrNull(body.effective_from);
  if (!effectiveFrom) {
    return jsonResponse({ error: "effective_from (YYYY-MM-DD) is required" }, 400);
  }
  const effectiveTo = isoDateOrNull(body.effective_to);
  if (effectiveTo && effectiveTo < effectiveFrom) {
    return jsonResponse({ error: "effective_to is before effective_from" }, 400);
  }
  const locationId = toIntOrNull(body.location_id);
  if (locationId == null) {
    return jsonResponse({ error: "location_id is required" }, 400);
  }
  const captureGoalPct = toNumOrNull(body.capture_goal_pct);
  const dobGoal = toNumOrNull(body.dob_goal);
  if (captureGoalPct == null || dobGoal == null) {
    return jsonResponse(
      { error: "capture_goal_pct and dob_goal are required" },
      400
    );
  }
  // Checked here as well as by greeter_goals_capture_goal_pct_range, because
  // "30" meaning 30% and "0.30" meaning 30% is the single easiest mistake to
  // make with this field and the DB message wouldn't say which way to go.
  if (captureGoalPct < 0 || captureGoalPct > 100) {
    return jsonResponse(
      {
        error: "capture_goal_pct out of range",
        reason: "Capture goal is a percentage from 0 to 100 (30 means 30%)."
      },
      400
    );
  }
  const memberGoal = toIntOrNull(body.member_goal_month_end);
  if (memberGoal != null && memberGoal < 0) {
    return jsonResponse({ error: "member_goal_month_end must be >= 0" }, 400);
  }

  const resolved = await resolveWritableLocation(env, locationId, scope);
  if (!resolved.ok) return resolved.response;

  const sb = createServiceClient(env);
  try {
    const saved = await insertGreeterGoal(sb, {
      site_number: resolved.key.site_number,
      location_code: resolved.key.location_code,
      effective_from: effectiveFrom,
      effective_to: effectiveTo,
      capture_goal_pct: captureGoalPct,
      dob_goal: dobGoal,
      member_goal_month_end: memberGoal,
      note: trimOrNull(body.note),
      created_by: session.userId
    });
    return jsonResponse(saved, 201);
  } catch (err) {
    if (isExclusionViolation(err)) {
      return jsonResponse(
        {
          error: "overlapping goal",
          reason:
            "This site already has a goal window covering part of that date range. Close the existing window first."
        },
        409
      );
    }
    throw err;
  }
}

/** Postgres 23P01 exclusion_violation, as surfaced by PostgREST/supabase-js. */
function isExclusionViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "23P01"
  );
}

/* ============================================================
 * Coercion
 * (deliberately local, matching the helpers in index.ts — see the note there.)
 * ============================================================ */

function trimOrNull(v: unknown): string | null {
  if (v == null) return null;
  const t = String(v).trim();
  return t ? t : null;
}

function toNumOrNull(v: unknown): number | null {
  if (v === "" || v == null) return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

function toIntOrNull(v: unknown): number | null {
  if (v === "" || v == null) return null;
  const n = parseInt(String(v), 10);
  return Number.isNaN(n) ? null : n;
}

/**
 * Accept only YYYY-MM-DD. `business_date` is a Postgres DATE and part of the
 * uniqueness key, so a stray timestamp or "8/3/2026" would either be rejected
 * by the database or silently create a second row for the same day.
 */
function isoDateOrNull(v: unknown): string | null {
  const t = trimOrNull(v);
  if (!t || !/^\d{4}-\d{2}-\d{2}$/.test(t)) return null;
  return t;
}

/**
 * Accept 24-hour HH:MM or HH:MM:SS for a Postgres `time` column.
 *
 * The form sends 24-hour text; the hour/minute/AM-PM pickers convert before
 * submitting, so nothing 12-hour reaches here. Anything unparseable becomes
 * null rather than throwing — but note the shift pair check upstream treats
 * "one side null" as a 400, so a malformed time is reported rather than
 * silently dropped.
 */
function timeOrNull(v: unknown): string | null {
  const t = trimOrNull(v);
  if (!t) return null;
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(t);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  const ss = m[3] ? Number(m[3]) : 0;
  if (hh > 23 || mm > 59 || ss > 59) return null;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}
