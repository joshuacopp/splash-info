// Greeter scorecard endpoints for performance-worker.
//
// Split out of index.ts because this is a second, independent feature living
// behind the same "pertrack" grant — the visit-based tracker (/api/submissions)
// and the daily scorecard (/api/greeter/*) share auth and nothing else.
//
// Owned routes (post-prefix-strip, all gated by index.ts before dispatch):
//   GET  /api/greeter/roster         ?location_id=   -> Beekeeper people picker
//   GET  /api/greeter/contact-roster ?role=          -> RD/RM filter dropdowns
//   GET  /api/greeter/days           filters         -> per-greeter day rows
//   POST /api/greeter/days                           -> submit/correct a day
//   GET  /api/greeter/rollup         filters         -> per-greeter aggregate
//   GET  /api/greeter/scan-rates     filters         -> per site-day scan rate
//   GET  /api/greeter/missing-days   dates required  -> location-days not logged
//   GET  /api/greeter/period-report  dates required  -> per-greeter period grades
//   GET  /api/greeter/location-rows  dates required  -> site day rows + scanned
//   GET  /api/greeter/location-days  filters         -> site-wide day rows
//   POST /api/greeter/location-days                  -> submit/correct a day
//   GET  /api/greeter/goals          ?site_number=   -> goal windows
//   POST /api/greeter/goals                          -> add a goal window
//   POST /api/greeter/goals/delete   { id }          -> remove a goal window
//
// THE DELETE IS A POST, not a DELETE verb. apps/web reaches this worker through
// performancePostJson only (app/admin/performance/_lib/worker-fetch.ts), which
// speaks POST; adding a verb would mean a second transport helper, a second
// CSRF-origin path and a second thing to get wrong, to express something the
// path already says.
//
// SCOPING RULE, applied identically to reads and writes:
//   Full admin tier (super_admin / dcRole admin|super_admin) -> undefined scope,
//   no filter. Everyone else -> their session.locations, lowercased. An empty
//   array reaches scopeCodes() in @splash/db-supabase/greeter, which substitutes
//   a sentinel so a scoping bug shows nothing rather than everything.
//
//   Writes go further: the location is resolved server-side from location_id and
//   the resulting location_code is checked against the caller's scope. The
//   client never supplies site_number or location_code — trusting either would
//   let a location admin stamp another site's rows.
//
// MANAGER FILTER (?rd= / ?rm=, emails). Every LIST read accepts them — the
// eight endpoints below the guard in handleGreeterRoute. They are not a second
// scope: they are INTERSECTED with the caller's scope, so a filter can only
// ever narrow what somebody already sees. That direction matters, because the
// codes come from pricing_simple and the client picks the manager — treating
// them as a scope in their own right would let a location admin name a manager
// and read that manager's other sites.
//
// THREE ENDPOINTS SIT OUTSIDE THE NARROWING and it is not an oversight:
//   - the three writes. A greeter filling in yesterday's numbers with a manager
//     selected in the filter bar must not get a 403 because the row's site fell
//     outside the current view. Writes authorise by location_id against the
//     session scope alone.
//   - /roster and /contact-roster, which answer "who can I pick", not "what am
//     I looking at". Narrowing the dropdown by its own current selection would
//     make the filter impossible to change once set.

import type { Session } from "@splash/auth";
import {
  createServiceClient,
  deleteGreeterGoal,
  getGoalSnapshot,
  getGreeterRoster,
  insertGreeterGoal,
  listGreeterDays,
  listGreeterGoals,
  listGreeterMissingDays,
  listGreeterPeriodReport,
  listGreeterRollup,
  listGreeterScanRates,
  listContactRoster,
  listLocationDays,
  listLocationPeriodRows,
  resolveGreeterLocationKey,
  restampGoals,
  submitGreeterDay,
  submitLocationDay,
  type ContactRosterEntry,
  type GreeterDayFilters,
  type SupabaseEnv
} from "@splash/db-supabase";
import { json as jsonResponse } from "@splash/http";
import type {
  GreeterDailyInsert,
  GreeterGoalRestampResult,
  GreeterGoalRow,
  GreeterLocationKey,
  LocationDailyInsert
} from "@splash/types/greeter";

type Env = SupabaseEnv;

/** Paths this module owns, as (method, path) pairs index.ts can test cheaply. */
export function isGreeterRoute(pathname: string, method: string): boolean {
  switch (pathname) {
    case "/api/greeter/roster":
    case "/api/greeter/contact-roster":
    case "/api/greeter/rollup":
    case "/api/greeter/scan-rates":
    case "/api/greeter/missing-days":
    case "/api/greeter/period-report":
    case "/api/greeter/location-rows":
      return method === "GET";
    case "/api/greeter/days":
    case "/api/greeter/location-days":
    case "/api/greeter/goals":
      return method === "GET" || method === "POST";
    case "/api/greeter/goals/delete":
      return method === "POST";
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

  // Writes and the two location-keyed lookups authorise against the session
  // scope only — see the MANAGER FILTER note at the top of this file.
  if (pathname === "/api/greeter/roster" && method === "GET") {
    return apiRoster(url, env, scope);
  }
  if (pathname === "/api/greeter/contact-roster" && method === "GET") {
    return apiContactRoster(url, env, scope);
  }
  if (pathname === "/api/greeter/days" && method === "POST") {
    return apiSubmitGreeterDay(request, env, session, scope);
  }
  if (pathname === "/api/greeter/location-days" && method === "POST") {
    return apiSubmitLocationDay(request, env, session, scope);
  }
  if (pathname === "/api/greeter/goals" && method === "POST") {
    return apiCreateGoal(request, env, session, scope);
  }
  // Above the read guard with the other writes, and authorised against the
  // session scope alone for the same reason they are — see the MANAGER FILTER
  // note at the top. Narrowing a delete by whatever manager happens to be
  // selected in the filter bar would make the button fail for no visible cause.
  if (pathname === "/api/greeter/goals/delete" && method === "POST") {
    return apiDeleteGoal(request, env, scope);
  }

  if (!isGreeterRoute(pathname, method)) return null;

  // Everything below is a read, and every read narrows by ?rd=/?rm=.
  const readScope = await narrowScopeByManagers(env, url, scope);

  if (pathname === "/api/greeter/days" && method === "GET") {
    return apiListGreeterDays(url, env, readScope);
  }
  if (pathname === "/api/greeter/rollup" && method === "GET") {
    return apiRollup(url, env, readScope);
  }
  if (pathname === "/api/greeter/scan-rates" && method === "GET") {
    return apiScanRates(url, env, readScope);
  }
  if (pathname === "/api/greeter/missing-days" && method === "GET") {
    return apiMissingDays(url, env, readScope);
  }
  if (pathname === "/api/greeter/period-report" && method === "GET") {
    return apiPeriodReport(url, env, readScope);
  }
  if (pathname === "/api/greeter/location-rows" && method === "GET") {
    return apiLocationRows(url, env, readScope);
  }
  if (pathname === "/api/greeter/location-days" && method === "GET") {
    return apiListLocationDays(url, env, readScope);
  }
  if (pathname === "/api/greeter/goals" && method === "GET") {
    return apiListGoals(url, env, readScope);
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
 * empty state, and scopeCodes() in @splash/db-supabase/greeter already fails
 * closed on an empty array by substituting a sentinel code.
 *
 * LOWERCASES, which is a no-op against the data and load-bearing anyway.
 * pricing_simple.location_code is lowercase for every row — the human-readable
 * name lives in `location`, not here — so this never actually changes a code.
 * It stays because it normalises the SESSION side, which is assembled from
 * elsewhere, and because the SQL compares `location_code = ANY(p_location_codes)`
 * with no folding at either end: the day a mixed-case code is inserted, the
 * comparison is exact and silent about it.
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

/* ------------------------------------------------------------
 * Manager (RD/RM) narrowing
 * ------------------------------------------------------------ */

/**
 * `?role=` -> the roster role, defaulting to Regional Director.
 *
 * LABEL DIVERGENCE, and it is not a typo: the database column `area_manager`
 * holds the *Regional Director's* name and `regional_manager` holds the
 * Regional Manager's. listContactRoster() takes the UI-facing role name and
 * does that mapping, so this worker never touches the raw columns.
 */
function rosterRoleFrom(v: string | null): "regional_director" | "regional_manager" {
  return v === "regional_manager" ? "regional_manager" : "regional_director";
}

/**
 * The full roster for a role, memoised in the isolate for a minute.
 *
 * listContactRoster() is an uncached REST read of up to a thousand
 * pricing_simple rows. One page paint is five or six separate worker requests,
 * each of which narrows by the same manager, so without this the filter costs a
 * full table scan per fetch.
 *
 * Cached ACROSS requests on purpose, and safe to do so because this is the
 * whole roster — not one caller's slice. Every consumer scopes it afterwards
 * (apiContactRoster filters it; narrowScopeByManagers intersects it), so a
 * shared entry can't leak one user's view to another. Manager assignments
 * change on the order of months; a minute of staleness is invisible.
 */
const ROSTER_TTL_MS = 60_000;
const rosterCache = new Map<string, { at: number; rows: ContactRosterEntry[] }>();

async function cachedContactRoster(
  env: Env,
  role: "regional_director" | "regional_manager"
): Promise<ContactRosterEntry[]> {
  const now = Date.now();
  const hit = rosterCache.get(role);
  if (hit && now - hit.at < ROSTER_TTL_MS) return hit.rows;
  const rows = await listContactRoster(env, role);
  rosterCache.set(role, { at: now, rows });
  return rows;
}

/**
 * The location_codes one named manager covers, as lowercased key -> code as
 * stored.
 *
 * The two halves are the same string today — pricing_simple.location_code is
 * lowercase for every row — and the split is here so that stays a fact about
 * the data rather than an assumption in the code. The key is lowercased to
 * match locationScopeFor(), which lowercases the session's locations. The value
 * is left exactly as stored, because that is what resolveGreeterLocationKey()
 * stamps onto greeter_daily.location_code and the SQL compares
 * `location_code = ANY(p_location_codes)` with no folding at either end. Fold
 * the value and a single mixed-case code inserted later drops its site out of
 * every filtered report, with nothing to see in the query.
 */
async function resolveRosterCodes(
  env: Env,
  role: "regional_director" | "regional_manager",
  email: string
): Promise<Map<string, string>> {
  const roster = await cachedContactRoster(env, role);
  const target = email.trim().toLowerCase();
  const entry = roster.find((e) => e.email.toLowerCase() === target);
  const out = new Map<string, string>();
  for (const raw of entry?.location_codes ?? []) {
    const code = raw.trim();
    if (code) out.set(code.toLowerCase(), code);
  }
  return out;
}

/**
 * Fold the ?rd= / ?rm= filters into the caller's scope.
 *
 * Returns the same shape locationScopeFor() does: `undefined` = no restriction,
 * an array = exactly these codes, and an EMPTY array = nothing, which
 * scopeCodes() in @splash/db-supabase turns into a sentinel that matches no
 * row. The empty array is a real, expected answer here — "that manager covers
 * no site you can see" must render an empty report, not the whole company.
 *
 * INTERSECTION, never replacement. Starting from the session scope and only
 * ever shrinking is what makes it safe to accept these emails from the query
 * string at all; see the MANAGER FILTER note at the top of this file.
 *
 * Both filters together mean BOTH — the site must be covered by the named RD
 * *and* the named RM. That matches damage-worker and is the only reading that
 * keeps the two dropdowns independent.
 *
 * Fail-soft is inherited: listContactRoster() returns [] rather than throwing,
 * which lands here as "no codes" and therefore an empty report. That is the
 * correct direction to fail — a roster outage must not widen anybody's view.
 */
async function narrowScopeByManagers(
  env: Env,
  url: URL,
  scope: string[] | undefined
): Promise<string[] | undefined> {
  const rd = trimOrNull(url.searchParams.get("rd"));
  const rm = trimOrNull(url.searchParams.get("rm"));
  if (!rd && !rm) return scope;

  // Lowercased key -> the code to actually emit. null models "unrestricted so
  // far", which an empty map cannot. The session scope arrives already
  // lowercased, so on that side key and value are the same string.
  let working: Map<string, string> | null =
    scope === undefined ? null : new Map(scope.map((c) => [c, c]));
  if (working && working.size === 0) return [];

  for (const [role, email] of [
    ["regional_director", rd],
    ["regional_manager", rm]
  ] as const) {
    if (!email) continue;
    const codes = await resolveRosterCodes(env, role, email);
    if (codes.size === 0) return [];
    working = working ? intersectCodes(working, codes) : codes;
    if (working.size === 0) return [];
  }

  return working === null ? undefined : [...working.values()];
}

/**
 * Keys from both sides, VALUES FROM THE ROSTER.
 *
 * Taking the right-hand value is the point of this function existing rather
 * than a Set intersection: the roster carries pricing_simple's casing, which is
 * what greeter_daily.location_code holds, while the session scope has been
 * lowercased. Emitting the left-hand value would hand the SQL a code that
 * matches nothing for any site whose code is not lowercase. The key set is the
 * intersection either way, so this cannot widen anyone's view.
 */
function intersectCodes(
  a: Map<string, string>,
  b: Map<string, string>
): Map<string, string> {
  const out = new Map<string, string>();
  for (const key of a.keys()) {
    const code = b.get(key);
    if (code !== undefined) out.set(key, code);
  }
  return out;
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

/**
 * The Regional Director / Regional Manager lists that populate the two filter
 * dropdowns. `?role=regional_director|regional_manager`.
 *
 * Filtered to the caller's own scope, and each entry's location_codes is
 * filtered too — not just the entry. A location admin must see their own
 * manager in the dropdown, but must not learn from the payload which other
 * sites that manager covers.
 *
 * A manager whose sites are all outside the caller's scope is dropped
 * entirely: offering a name that can only ever produce an empty report reads
 * as a bug.
 *
 * Never 500s. listContactRoster() is fail-soft by design so the dropdown
 * degrades to "(any)" instead of taking the page down with it.
 */
async function apiContactRoster(
  url: URL,
  env: Env,
  scope: string[] | undefined
): Promise<Response> {
  const role = rosterRoleFrom(url.searchParams.get("role"));
  const roster = await cachedContactRoster(env, role);
  if (scope === undefined) return jsonResponse(roster);
  if (scope.length === 0) return jsonResponse([]);

  const allowed = new Set(scope);
  const filtered: ContactRosterEntry[] = [];
  for (const entry of roster) {
    const codes = entry.location_codes.filter((c) =>
      allowed.has(c.trim().toLowerCase())
    );
    if (codes.length === 0) continue;
    filtered.push({ email: entry.email, name: entry.name, location_codes: codes });
  }
  return jsonResponse(filtered);
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

/**
 * Per site-day scan rate. Uses the same filter parse as the other reads, but
 * listGreeterScanRates() ignores the greeter/beekeeper_user_id members on
 * purpose — see the note there. Passing them would shrink the numerator while
 * the denominator stayed the whole site's day, making every site look
 * underreported the moment somebody typed a name in the filter bar.
 */
async function apiScanRates(
  url: URL,
  env: Env,
  scope: string[] | undefined
): Promise<Response> {
  const sb = createServiceClient(env);
  const rows = await listGreeterScanRates(sb, filtersFromQuery(url, scope));
  return jsonResponse(rows);
}

/**
 * Location-days with a submission missing.
 *
 * Both dates are REQUIRED here, unlike every other read on this module. The
 * function builds an (onboarded locations x days) grid, so an open-ended window
 * would materialise every day since the first submission ever made. A 400 with
 * an explanation beats a query that quietly takes a minute.
 */
async function apiMissingDays(
  url: URL,
  env: Env,
  scope: string[] | undefined
): Promise<Response> {
  const sp = url.searchParams;
  const dateFrom = isoDateOrNull(sp.get("date_from"));
  const dateTo = isoDateOrNull(sp.get("date_to"));
  if (!dateFrom || !dateTo) {
    return jsonResponse(
      {
        error: "date_from and date_to are required",
        reason:
          "This report walks every day in the window for every location, so it needs a bounded range."
      },
      400
    );
  }
  if (dateTo < dateFrom) {
    return jsonResponse({ error: "date_to is before date_from" }, 400);
  }

  const sb = createServiceClient(env);
  const rows = await listGreeterMissingDays(
    sb,
    { date_from: dateFrom, date_to: dateTo },
    {
      location_id: toIntOrNull(sp.get("location_id")),
      site_number: toIntOrNull(sp.get("site_number")),
      location_scope: scope ?? null
    }
  );
  return jsonResponse(rows);
}

/**
 * Per-greeter grades for one window: days over/under goal, weighted capture and
 * DOB, totals.
 *
 * Dates are REQUIRED, like missing-days but for a different reason: every number
 * here is "for the period", and a period with no start is not a period. An
 * open-ended window would silently grade a greeter's whole career against the
 * preset the button claims to apply.
 *
 * Deliberately does NO threshold filtering. The "underperformers" and "top
 * performers" presets are the SAME query as "previous 7 days" with a different
 * window and a filter on pct_days_under / pct_days_over applied by the page.
 * Pushing the thresholds into SQL would mean a new function every time somebody
 * wants a different cut, and would make the row counts impossible to reconcile
 * between views.
 *
 * low_sample rows (two or fewer gradeable days) come back like any other row and
 * MUST be rendered — the page sorts them last with a note. Dropping them hides
 * exactly the greeters whose numbers nobody is watching.
 */
async function apiPeriodReport(
  url: URL,
  env: Env,
  scope: string[] | undefined
): Promise<Response> {
  const sp = url.searchParams;
  const dateFrom = isoDateOrNull(sp.get("date_from"));
  const dateTo = isoDateOrNull(sp.get("date_to"));
  if (!dateFrom || !dateTo) {
    return jsonResponse(
      {
        error: "date_from and date_to are required",
        reason:
          "Every figure in this report is scored over a window, so the window has to be bounded."
      },
      400
    );
  }
  if (dateTo < dateFrom) {
    return jsonResponse({ error: "date_to is before date_from" }, 400);
  }

  const sb = createServiceClient(env);
  const rows = await listGreeterPeriodReport(
    sb,
    { date_from: dateFrom, date_to: dateTo },
    {
      location_id: toIntOrNull(sp.get("location_id")),
      site_number: toIntOrNull(sp.get("site_number")),
      beekeeper_user_id: sp.get("beekeeper_user_id"),
      greeter: sp.get("greeter"),
      location_scope: scope ?? null
    }
  );
  return jsonResponse(rows);
}

/**
 * Raw site-day rows for the window, each carrying the greeter-scanned wash sales
 * for that site-day alongside the site's own total.
 *
 * Returns days, not totals, on purpose: the morning-call table and the trend
 * chart are two groupings of this one payload, so they cannot disagree. Summing
 * happens in the page.
 *
 * Note total_members is a LEVEL — the page reads the latest day's value and must
 * never add the column up. net_members is the summable one.
 *
 * Takes no greeter/beekeeper_user_id filter, matching listLocationPeriodRows():
 * these are site figures, and narrowing them by a greeter name would produce a
 * site total that isn't the site's.
 */
async function apiLocationRows(
  url: URL,
  env: Env,
  scope: string[] | undefined
): Promise<Response> {
  const sp = url.searchParams;
  const dateFrom = isoDateOrNull(sp.get("date_from"));
  const dateTo = isoDateOrNull(sp.get("date_to"));
  if (!dateFrom || !dateTo) {
    return jsonResponse(
      {
        error: "date_from and date_to are required",
        reason:
          "This returns one row per site per day, so an unbounded window would return every day on record."
      },
      400
    );
  }
  if (dateTo < dateFrom) {
    return jsonResponse({ error: "date_to is before date_from" }, 400);
  }

  const sb = createServiceClient(env);
  const rows = await listLocationPeriodRows(
    sb,
    { date_from: dateFrom, date_to: dateTo },
    {
      location_id: toIntOrNull(sp.get("location_id")),
      site_number: toIntOrNull(sp.get("site_number")),
      location_scope: scope ?? null
    }
  );
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
    // Stored and shown, never graded. Nothing on greeter_daily is computed from
    // it — see GreeterSharedMetrics in @splash/types.
    reactivations: toIntOrNull(body.reactivations),
    // Same: a COUNT of reviews collected, stored and summed, never graded.
    google_reviews: toIntOrNull(body.google_reviews),
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

  // Range-checked here as well as by location_daily_churn_pct_range, so the
  // caller gets a readable 400 instead of a raw constraint violation. The most
  // likely bad input is a member COUNT typed into a percent box, which lands
  // well outside 0-100 and is worth naming rather than silently discarding.
  const churnPct = toNumOrNull(body.churn_pct);
  if (churnPct !== null && (churnPct < 0 || churnPct > 100)) {
    return jsonResponse(
      {
        error: "churn out of range",
        reason:
          "Churn is a percentage between 0 and 100. If you have a count of members lost, divide it by the member base first."
      },
      400
    );
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
    // Site-only, and absent from the greeter handler above on purpose. Both of
    // these come OUT of the scan-rate denominator (a customer can't scan a card
    // for a house-account car or a rewash) and stay IN the capture_pct and dob
    // denominators, which are generated columns computed from gross wash_sales.
    house_accounts: toIntOrNull(body.house_accounts),
    rewashes: toIntOrNull(body.rewashes),
    package_dollars: toNumOrNull(body.package_dollars),
    extras_dollars: toNumOrNull(body.extras_dollars),
    sign_ups: toIntOrNull(body.sign_ups),
    // One of the three inputs Postgres generates net_members from.
    reactivations: toIntOrNull(body.reactivations),
    cancellations: toIntOrNull(body.cancellations),
    total_members: toIntOrNull(body.total_members),
    // Both informational. churn_pct is validated above; neither feeds a
    // generated column, a goal, or any rate.
    churn_pct: churnPct,
    google_reviews: toIntOrNull(body.google_reviews),
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
 * OVERLAPPING WINDOWS ARE LEGAL. A promo week laid over a standing monthly
 * baseline is the point — Josh, 2026-08-22: "specials come on by surprise and
 * require different goals... desired behavior would be that shorter term goals
 * override longer term goals, for the term they are in place." The gist EXCLUDE
 * constraint that used to reject them is gone (greeter-goal-overlap-11.sql) and
 * greeter_goal_for() decides between them by span: shortest wins, and an
 * open-ended window has infinite span so it always loses to a bounded one.
 *
 * WHAT IS STILL REJECTED is an identical window for the same site — the same
 * row typed twice, which no rule could choose between. That now arrives as a
 * unique violation (23505) rather than an exclusion violation (23P01), and the
 * 409 message points at the delete button. The old message told the user to
 * "close the existing window first", which is advice that no longer applies to
 * anything.
 *
 * AND IT RE-STAMPS. Goals are snapshotted onto each submission at submit time,
 * so days already entered inside the new window are still carrying the target
 * that was in force when they were typed. Josh confirmed those should move, so
 * the insert is followed by greeter_restamp_goals() over the same window and
 * the counts come back in the response for the banner to report. Without this,
 * setting last week's promo goal today would change nothing anyone can see and
 * look exactly like a save that silently failed.
 *
 * THE RE-STAMP IS NOT IN THE SAME TRANSACTION as the insert, because PostgREST
 * gives us no way to put it there. It therefore runs OUTSIDE the try that
 * catches the duplicate-window 409, and its own failure is caught and logged
 * rather than raised: by the time it runs the goal row is committed, so a 500
 * would report a save that succeeded as one that didn't, and the retry that
 * invites comes back as the 409. The degraded state — goal saved, some days
 * still graded against the old target — is visible and fixable by deleting the
 * goal and re-adding it.
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
  // ABSENT IS NOT THE SAME AS UNREADABLE HERE, which is why this is two checks
  // and effective_from above is one. A missing effective_to legitimately means
  // "open-ended", so isoDateOrNull returning null is a valid answer — but it is
  // also what it returns for "2026-13-01" or "next friday", and letting those
  // through would quietly create a goal that never expires. Under the overlap
  // rules an open-ended window has infinite span, so it also loses to every
  // bounded window: the typo's punishment is a goal that grades nothing and
  // never goes away. Better to refuse it.
  const effectiveToRaw = body.effective_to;
  const effectiveToGiven =
    effectiveToRaw != null && String(effectiveToRaw).trim() !== "";
  const effectiveTo = isoDateOrNull(effectiveToRaw);
  if (effectiveToGiven && !effectiveTo) {
    return jsonResponse(
      { error: "effective_to must be a date in YYYY-MM-DD form, or left blank for an open-ended goal." },
      400
    );
  }
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
  let row: GreeterGoalRow;
  try {
    row = await insertGreeterGoal(sb, {
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
  } catch (err) {
    if (isUniqueViolation(err)) {
      return jsonResponse(
        {
          // A SENTENCE, not "duplicate goal". apps/web's performancePostJson
          // surfaces `error` and drops `reason`, so this string is the whole
          // banner the user reads.
          error:
            "This site already has a goal covering exactly that same date range — this window, entered twice. Overlapping windows are fine; identical ones are not, because nothing could choose between them. Delete the existing goal if you meant to change it.",
          reason:
            "idx_greeter_goals_unique_window. Overlaps were made legal by greeter-goal-overlap-11.sql; only an exact duplicate is refused."
        },
        409
      );
    }
    throw err;
  }

  // OUTSIDE THE try, AND ITS OWN FAILURE IS SWALLOWED, because the row above is
  // already committed and nothing here can take it back. A 500 at this point
  // would tell the user their goal did not save when it did, and the retry it
  // invites would come back as the 409 above. Reporting zero re-grades is the
  // honest degradation: the goal is visible in the table, and deleting and
  // re-adding it runs the re-stamp again.
  let restamped: GreeterGoalRestampResult = {
    greeter_rows: 0,
    location_rows: 0
  };
  try {
    restamped = await restampGoals(
      sb,
      resolved.key.site_number,
      effectiveFrom,
      effectiveTo
    );
  } catch (err) {
    console.error("greeter goal re-stamp failed after insert", err);
  }

  return jsonResponse({ row, restamped }, 201);
}

/**
 * Remove a goal window, and re-grade the days it was covering.
 *
 * THE RE-STAMP IS THE HALF THAT MATTERS. Deleting the row alone would leave
 * every day already submitted inside its window still stamped with its targets,
 * so a goal entered by mistake would go on grading days after it was removed.
 * greeter_restamp_goals() re-resolves each of those days from what is LEFT —
 * the baseline underneath, or nothing at all — which is why the same function
 * serves this path and the insert path with no branch between them.
 *
 * Scope is applied inside the DELETE itself (see deleteGreeterGoal), so an id
 * belonging to another site removes nothing and is reported as gone. That
 * deliberately does not distinguish "not yours" from "not there": the page only
 * ever lists goals the caller can see, so the difference is not information
 * they are owed.
 */
async function apiDeleteGoal(
  request: Request,
  env: Env,
  scope: string[] | undefined
): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

  const id = trimOrNull(body.id);
  if (!id) {
    return jsonResponse({ error: "id is required" }, 400);
  }

  const sb = createServiceClient(env);
  const deleted = await deleteGreeterGoal(sb, id, {
    location_scope: scope ?? null
  });

  if (!deleted) {
    return jsonResponse(
      {
        error:
          "That goal no longer exists — it may already have been deleted. Reload the page to see the current list.",
        reason: "No row matched the id within the caller's location scope."
      },
      404
    );
  }

  // Swallowed for the same reason as the insert path: the row is already gone
  // and a 500 here would report a delete that plainly did happen as a failure.
  // The days keep the deleted goal's targets until something re-stamps them,
  // which is wrong but visible — and re-running the delete can't fix it, so the
  // failure is logged where it can be found rather than shown to the user as
  // something they can retry.
  let restamped: GreeterGoalRestampResult = {
    greeter_rows: 0,
    location_rows: 0
  };
  try {
    restamped = await restampGoals(
      sb,
      deleted.site_number,
      deleted.effective_from,
      deleted.effective_to
    );
  } catch (err) {
    console.error("greeter goal re-stamp failed after delete", err);
  }

  return jsonResponse({ row: deleted, restamped });
}

/**
 * Postgres 23505 unique_violation, as surfaced by PostgREST/supabase-js.
 *
 * Replaced a 23P01 exclusion_violation check when greeter-goal-overlap-11.sql
 * swapped the gist EXCLUDE for a unique index on the exact window. If a 23P01
 * ever reaches this handler again, some database still has the old constraint
 * and the migration has not been applied there.
 */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "23505"
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
