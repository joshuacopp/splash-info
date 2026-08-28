// Expense log endpoints for performance-worker.
//
// Third feature behind the same "pertrack" grant, sitting beside ./greeter.ts
// for the same reason greeter sits beside /api/submissions: shared auth, shared
// location scoping, and nothing else. Schema and the reasoning behind every
// rule this file defends: supabase/expense-log-tables.sql. Query layer:
// packages/db-supabase/src/expense.ts.
//
// Owned routes (post-prefix-strip, all gated by index.ts before dispatch):
//   GET  /api/expenses/categories                 -> { categories }
//   GET  /api/expenses/entries       filters      -> { entries }
//   POST /api/expenses/entries       no body id   -> { entry }   201
//   POST /api/expenses/entries       body id      -> { entry, updated,
//                                                     reissued,
//                                                     previous_po_number }
//   POST /api/expenses/entries/void               -> { entry }
//   GET  /api/expenses/budgets       month req.   -> { budgets }
//   POST /api/expenses/budgets                    -> { budget, corrected }
//   POST /api/expenses/budgets/copy               -> { created }
//   GET  /api/expenses/rollup        month req.   -> { rows }
//   GET  /api/expenses/labor-rates                -> { rates }
//   POST /api/expenses/labor-rates                -> { rate }    201
//
// NO wrangler.toml CHANGE IS NEEDED FOR A NEW PATH HERE, unlike dashboard-worker
// where prod binds individual /api/* paths and a new endpoint 404s in prod while
// working in dev. This worker is bound by the wildcard `/pertrack/*` and reached
// from apps/web over a service binding, so adding a route is enough. Checked
// 2026-08-21 against apps/performance-worker/wrangler.toml — re-check if that
// routes array ever gains a per-path entry.
//
// RESPONSES ARE ENVELOPED ({ entries: [...] }), unlike greeter.ts which returns
// bare arrays. Not an inconsistency for its own sake: two of these endpoints
// have to return a scalar alongside the payload (`corrected`, `created`), and a
// route table where half the shapes are arrays and half are objects is the kind
// of thing a caller gets wrong once per endpoint. One shape for all ten.
//
// SCOPING RULE, identical to greeter.ts and applied to reads and writes alike:
//   Full admin tier (super_admin / dcRole admin|super_admin) -> undefined scope,
//   no filter. Everyone else -> their session.locations, lowercased. An empty
//   array reaches scopeCodes() in @splash/db-supabase/expense, which substitutes
//   a sentinel so a scoping bug shows nothing rather than everything.
//
//   Writes go further: the location is resolved server-side from location_id
//   and the resulting location_code is checked against the caller's scope. The
//   client never supplies site_number or location_code. On this feature that is
//   not merely a scoping concern — site_number is the literal PREFIX of the PO
//   number the database mints, so a client-supplied one would stamp another
//   site's number onto paperwork somebody later has to reconcile.
//
// NO MANAGER (?rd=/?rm=) NARROWING HERE, and its absence is deliberate rather
// than unfinished. The greeter reports are performance reviews read by the RD
// and RM who own the sites; an expense log is a ledger read by whoever spends
// against it, and the filter bar the parallel UI brief builds is month + site +
// category. If a regional expense view is ever wanted, lift
// narrowScopeByManagers() out of greeter.ts at that point — copying it now
// would mean maintaining a roster cache nothing calls.
//
// THE CLIENT NEVER SENDS A PO NUMBER. `po_number`/`po_seq` are absent from
// ExpenseEntryInsert on purpose (see @splash/types/expense) and a body that
// carries one is ignored silently — not 400'd. A stale form field or a caller
// echoing a row back is not an attack worth failing a purchase over, and
// nothing downstream can act on the value: it is never read out of the body.
// This holds on the EDIT path too, where the row already has a PO: whether it
// keeps that number or gets a new one is decided by update_expense_entry() from
// whether the site or date moved, never from anything the client sent.
//
// AND THE CLIENT NEVER SENDS A LABOR DOLLAR AMOUNT. Maintenance labor is
// entered as HOURS; insert_expense_entry() looks the rate up and multiplies,
// inside the same transaction that mints the PO. This module does not do that
// arithmetic — not even "to show the user a preview and send it along" — because
// an admin-settable rate that the client is trusted to apply is an advisory
// rate, and a CHECK constraint (expense_entry_labor_amount_matches) would reject
// the row anyway the moment the two copies disagreed. Hours in, priced row out.
//
// SETTING THE RATE IS super_admin ONLY (Josh, 2026-08-21). Note that is a
// STRICTER test than locationScopeFor()'s full-admin tier, which also lets a
// dcRole admin through: the rate is one company-wide number that reprices every
// future labor entry at every site, so it is not a location-scoped write at all
// and the location-scoping helper is the wrong instrument for it. READING the
// rates is not gated beyond the "pertrack" grant index.ts already checked —
// anyone entering hours needs to see what they cost.

import type { Session } from "@splash/auth";
import {
  copyExpenseBudgetMonth,
  createServiceClient,
  getExpenseEntry,
  insertExpenseEntry,
  insertExpenseLaborRate,
  listExpenseBudgets,
  listExpenseCategories,
  listExpenseLaborRates,
  listExpenseMonthRollup,
  listExpenses,
  resolveExpenseLocationKey,
  updateExpenseEntry,
  upsertExpenseBudget,
  voidExpenseEntry,
  type SupabaseEnv
} from "@splash/db-supabase";
import { json as jsonResponse } from "@splash/http";
import type {
  ExpenseBudgetInsert,
  ExpenseEntryInsert,
  ExpenseEntryUpdate,
  ExpenseLaborRateInsert,
  ExpenseListFilters,
  ExpenseLocationKey
} from "@splash/types/expense";

type Env = SupabaseEnv;

/** Paths this module owns, as (method, path) pairs index.ts can test cheaply. */
export function isExpenseRoute(pathname: string, method: string): boolean {
  switch (pathname) {
    case "/api/expenses/categories":
    case "/api/expenses/rollup":
      return method === "GET";
    case "/api/expenses/entries":
    case "/api/expenses/budgets":
    // Hyphenated, not `labor_rates`, matching /api/expenses/budgets/copy and
    // every other path on this worker: URLs are hyphenated, columns are
    // underscored, and the two are not the same namespace.
    case "/api/expenses/labor-rates":
      return method === "GET" || method === "POST";
    // Sub-paths rather than a `?action=void` flag or a DELETE: the void is a
    // state transition with a body (the reason), and DELETE would read as the
    // hard delete this table specifically does not do.
    case "/api/expenses/entries/void":
    case "/api/expenses/budgets/copy":
      return method === "POST";
    default:
      return false;
  }
}

/**
 * Dispatch an expense route. index.ts has already authenticated the request and
 * confirmed the "pertrack" grant; this function assumes both.
 * Returns null when the path isn't ours, so index.ts can fall through to 404.
 *
 * Writes are dispatched BEFORE the isExpenseRoute() guard, matching
 * handleGreeterRoute(). There the split exists because reads narrow by the
 * manager filter and writes must not; here nothing narrows, so the ordering is
 * kept purely so the two files stay diff-able — if a read-side narrowing is
 * ever added, the seam it has to go through already exists.
 */
export async function handleExpenseRoute(
  pathname: string,
  method: string,
  request: Request,
  url: URL,
  env: Env,
  session: Session
): Promise<Response | null> {
  const scope = locationScopeFor(session);

  // Writes: authorise by location_id against the SESSION scope alone. The
  // entries POST covers create AND edit, branching on an optional body `id` —
  // see apiWriteEntry, which checks scope twice on the edit path.
  if (pathname === "/api/expenses/entries" && method === "POST") {
    return apiWriteEntry(request, env, session, scope);
  }
  if (pathname === "/api/expenses/entries/void" && method === "POST") {
    return apiVoidEntry(request, env, session);
  }
  if (pathname === "/api/expenses/budgets" && method === "POST") {
    return apiUpsertBudget(request, env, session, scope);
  }
  if (pathname === "/api/expenses/budgets/copy" && method === "POST") {
    return apiCopyBudgetMonth(request, env, session, scope);
  }
  // Takes no scope, and is the one write on this module that doesn't: the rate
  // is company-wide, so there is no location to resolve or check. Its gate is
  // the super_admin test inside the handler instead.
  if (pathname === "/api/expenses/labor-rates" && method === "POST") {
    return apiCreateLaborRate(request, env, session);
  }

  if (!isExpenseRoute(pathname, method)) return null;

  // Everything below is a read, scoped by the same session scope.
  const readScope = scope;

  if (pathname === "/api/expenses/categories" && method === "GET") {
    return apiCategories(env);
  }
  if (pathname === "/api/expenses/entries" && method === "GET") {
    return apiListEntries(url, env, readScope);
  }
  if (pathname === "/api/expenses/budgets" && method === "GET") {
    return apiListBudgets(url, env, readScope);
  }
  if (pathname === "/api/expenses/rollup" && method === "GET") {
    return apiRollup(url, env, readScope);
  }
  if (pathname === "/api/expenses/labor-rates" && method === "GET") {
    return apiListLaborRates(env);
  }
  return null;
}

/* ============================================================
 * Scoping
 * (locationScopeFor / inScope / resolveWritableLocation are DELIBERATE
 * DUPLICATES of the module-private versions in ./greeter.ts. They are private
 * there, and greeter.ts is a domain slice rather than this module's utility
 * library — importing across the two would make an expense deploy able to break
 * on a greeter refactor. The rule-of-three trigger has now fired on
 * locationScopeFor (here, greeter.ts, and forms-worker's submissionGate); if a
 * fourth copy appears, promote it to @splash/auth WITH these comments, because
 * the empty-array case is the whole point and is invisible from the signature.)
 * ============================================================ */

/**
 * `undefined` = sees every site. An array = restricted to those location_codes.
 *
 * A location admin holding "pertrack" but assigned no locations gets an EMPTY
 * array (sees nothing) rather than a 403, so the page still renders its filter
 * bar and empty state. scopeCodes() in @splash/db-supabase/expense fails closed
 * on an empty array by substituting a sentinel code.
 *
 * LOWERCASES, which is a no-op against the data and load-bearing anyway:
 * pricing_simple.location_code is lowercase for every row today, but the SQL
 * compares `location_code = ANY(...)` with no folding at either end, so this
 * normalises the SESSION side — which is assembled elsewhere — against the day
 * a mixed-case code shows up.
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
 * Resolve the client's location_id into the full three-column key, refusing
 * anything the caller can't reach.
 *
 * NULL IS A HARD REJECT. resolveExpenseLocationKey() returns null when the
 * location doesn't exist or has no pricing_simple row, and therefore no
 * location_code. There is no fallback path from here — not a default site, not
 * the raw location_id as a code, not an insert with the code left out:
 *
 *   * expense_entry.location_code is NOT NULL with no FK to `locations`, so a
 *     guessed value is caught by nothing downstream. The row would be invisible
 *     to its own site's admin while potentially appearing in another's — an
 *     expense silently escaping location scoping, in a money log.
 *   * site_number becomes the PO number's prefix. A wrong one doesn't just
 *     misfile the row, it mints a PO claiming to belong to another site.
 *
 * 400 rather than 404 because from the caller's side this is a bad request
 * body, and the `reason` names the actual fix (the site needs a pricing_simple
 * row) rather than leaving somebody re-picking the same location.
 */
async function resolveWritableLocation(
  env: Env,
  locationId: number,
  scope: string[] | undefined
): Promise<
  { ok: true; key: ExpenseLocationKey } | { ok: false; response: Response }
> {
  const sb = createServiceClient(env);
  const key = await resolveExpenseLocationKey(sb, locationId);
  if (!key) {
    return {
      ok: false,
      response: jsonResponse(
        {
          error: "unknown location",
          reason:
            "That location has no pricing_simple row, so it has no location_code " +
            "or site number to stamp on the expense — and the site number is the " +
            "PO number's prefix. Nothing can be saved against it."
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
 * Categories
 * ============================================================ */

/**
 * The grid's columns, left to right. ACTIVE ONLY (see listExpenseCategories) —
 * this feeds the entry form's picker and the budget editor, both of which are
 * about what can be spent against now.
 *
 * Unscoped, and correctly so: the category list is configuration, identical for
 * every site, and says nothing about anybody's spend.
 */
async function apiCategories(env: Env): Promise<Response> {
  const sb = createServiceClient(env);
  const categories = await listExpenseCategories(sb);
  return jsonResponse({ categories });
}

/* ============================================================
 * Reads
 * ============================================================ */

/**
 * Query string -> ExpenseListFilters.
 *
 * TWO RENAMES, both toward the URL rather than toward the column, and both
 * fixed by the UI contract so don't "correct" them:
 *   ?month=    -> period_month   (the page's month picker; one word in a URL)
 *   ?category= -> category_key   (ditto; `_key` is a schema detail)
 *   ?q=        -> description    (the filter bar's search box, ILIKE'd)
 *
 * `month` is parsed leniently HERE (a malformed value simply applies no month
 * predicate) because the caller validates it first and returns a 400 — see
 * apiListEntries. Doing it in both places rather than throwing from a filter
 * builder keeps this function total, the way its greeter counterpart is.
 *
 * `limit` is accepted but undocumented in the UI contract: it exists so an
 * ad-hoc export can raise the db layer's 500-row default. Absent means 500.
 */
function filtersFromQuery(
  url: URL,
  scope: string[] | undefined
): ExpenseListFilters {
  const sp = url.searchParams;
  return {
    // An explicit from/to beats month in the db layer (see listExpenses), which
    // is why both can be sent without one silently emptying the other.
    date_from: isoDateOrNull(sp.get("from")),
    date_to: isoDateOrNull(sp.get("to")),
    period_month: monthStartOrNull(sp.get("month")),
    location_id: toIntOrNull(sp.get("location_id")),
    category_key: trimOrNull(sp.get("category")),
    description: trimOrNull(sp.get("q")),
    location_scope: scope ?? null,
    limit: toIntOrNull(sp.get("limit")) ?? undefined
  };
}

/**
 * The entry list behind the Expense Log page.
 *
 * Voided rows are excluded by the db layer with no opt-in flag — this is a
 * money list, and a boolean that defaults wrong in one caller quietly inflates
 * a total.
 *
 * Bad-but-present filter values are 400'd rather than dropped. A month the
 * server silently ignored renders as "every expense ever" under a heading that
 * says August, which is worse than an error message.
 */
async function apiListEntries(
  url: URL,
  env: Env,
  scope: string[] | undefined
): Promise<Response> {
  const sp = url.searchParams;

  const rawMonth = trimOrNull(sp.get("month"));
  if (rawMonth && !monthStartOrNull(rawMonth)) return badMonth("month", rawMonth);

  const rawFrom = trimOrNull(sp.get("from"));
  const rawTo = trimOrNull(sp.get("to"));
  if (rawFrom && !isoDateOrNull(rawFrom)) {
    return jsonResponse({ error: "from must be YYYY-MM-DD" }, 400);
  }
  if (rawTo && !isoDateOrNull(rawTo)) {
    return jsonResponse({ error: "to must be YYYY-MM-DD" }, 400);
  }
  if (rawFrom && rawTo && rawTo < rawFrom) {
    return jsonResponse({ error: "to is before from" }, 400);
  }

  const sb = createServiceClient(env);
  const entries = await listExpenses(sb, filtersFromQuery(url, scope));
  return jsonResponse({ entries });
}

/**
 * The budget rows for one month. `?month=` is REQUIRED: a budget list with no
 * month is every month of every site, which is not what any view renders and
 * would be a slow way to find that out.
 *
 * A category with no row here has no budget, which is NOT a budget of zero.
 * The gaps are left as gaps — densifying them is expense_month_rollup()'s job,
 * and it keeps the missing ones NULL rather than 0.
 */
async function apiListBudgets(
  url: URL,
  env: Env,
  scope: string[] | undefined
): Promise<Response> {
  const month = requireMonth(url.searchParams.get("month"), "month");
  if (!month.ok) return month.response;

  const sb = createServiceClient(env);
  const budgets = await listExpenseBudgets(sb, {
    periodMonth: month.value,
    scope: scope ?? null,
    locationId: toIntOrNull(url.searchParams.get("location_id"))
  });
  return jsonResponse({ budgets });
}

/**
 * Budget / actual / variance per category per site for a month — the workbook's
 * three header rows, transposed.
 *
 * Returned verbatim. The three nulls are distinct (no budget vs zero spend vs
 * no variance) and must not be coalesced anywhere on the way out; see
 * ExpenseMonthRollupRow. This handler exists to bind the month and the scope
 * and to do nothing else.
 */
async function apiRollup(
  url: URL,
  env: Env,
  scope: string[] | undefined
): Promise<Response> {
  const month = requireMonth(url.searchParams.get("month"), "month");
  if (!month.ok) return month.response;

  const sb = createServiceClient(env);
  const rows = await listExpenseMonthRollup(sb, {
    periodMonth: month.value,
    scope: scope ?? null,
    locationId: toIntOrNull(url.searchParams.get("location_id"))
  });
  return jsonResponse({ rows });
}

/* ============================================================
 * Writes
 * ============================================================ */

/**
 * Create OR correct an entry. The database mints the PO number.
 *
 * ONE ENDPOINT, BRANCHING ON AN OPTIONAL `id` — the same shape as
 * POST /api/greeter/days, and for the same reason: create and edit validate
 * identically, and a second route would be a second copy of every rule above,
 * free to drift from this one the first time a field is added. `id` present
 * means "correct this row"; absent means "file a new one".
 *
 * TWO SCOPE CHECKS ON THE EDIT PATH, NOT ONE. resolveWritableLocation() only
 * proves the caller may write to the DESTINATION. On an edit that changes the
 * location, that leaves the row's CURRENT site unchecked — and a location admin
 * could pull another site's expense into their own, which both removes the money
 * from a log they don't own and is invisible from that side. So the old row is
 * read and checked too, and the caller must hold both. (Contrast apiVoidEntry,
 * which checks neither: a void needs a uuid it could only have got from its own
 * scoped list, and it can't move money between sites.) The second check answers
 * 404, not 403, and shares its body with the genuine not-found — see the note at
 * the branch.
 *
 * EVERY VALUE MAY ARRIVE AS A STRING. The Next.js server action forwards form
 * values unparsed on purpose — one place that knows how to coerce is better
 * than two that can disagree about what "" means — so amount and location_id
 * are `"412.50"` and `"196"` here, not numbers. That is what the coercion
 * helpers at the bottom of this file are for, and it is why nothing below
 * type-tests the body.
 *
 * `po_number` / `po_seq` in the body are IGNORED, not rejected — see the file
 * header. They are simply never read.
 *
 * The three location columns come from resolveWritableLocation() and can come
 * from nowhere else.
 *
 * TWO SHAPES OF BODY, TOLD APART BY `labor_hours` ALONE:
 *   amount + method            -> an ordinary purchase
 *   labor_hours (+ mechanic)   -> hours, priced by the database
 *
 * Which one a given category ACCEPTS is `expense_categories.billed_by_hours`,
 * and this function deliberately does not look that up. The RPC already reads
 * that column and raises 22023 on either mismatch ("hours on a category that
 * isn't billed by hours", "no hours for one that is"), so fetching it here would
 * be a second round trip whose only product is a second copy of a rule that can
 * then disagree with the first. What the branch below decides is narrower: which
 * of amount and labor_hours to validate as present, so the caller gets "enter
 * hours" rather than "amount is required" on a labor line. The database remains
 * the authority on whether that was the right field for the category.
 */
async function apiWriteEntry(
  request: Request,
  env: Env,
  session: Session,
  scope: string[] | undefined
): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

  const businessDate = isoDateOrNull(body.business_date);
  if (!businessDate) {
    return jsonResponse(
      {
        error: "business_date (YYYY-MM-DD) is required",
        reason:
          "This is the purchase date, not today: it is the YYYYMMDD inside the PO " +
          "number and the day the PO sequence counts within."
      },
      400
    );
  }

  const locationId = toIntOrNull(body.location_id);
  if (locationId == null) {
    return jsonResponse({ error: "location_id is required" }, 400);
  }

  // UPPERCASE FIRST, THEN VALIDATE. The database uppercases too, but it checks
  // the shape against '^[A-Z]{1,4}$' before it does — so a lowercase "jc" would
  // come back as a raw 22023 from next_expense_po(). Folding here means the
  // user isn't punished for not holding shift, and the only 400 they can get is
  // about something they actually did wrong.
  const initials = trimOrNull(body.po_initials)?.toUpperCase() ?? null;
  if (!initials || !/^[A-Z]{1,4}$/.test(initials)) {
    return jsonResponse(
      {
        error: "po_initials must be 1-4 letters",
        reason:
          "Your initials go into the PO number (196-20260820JC1). Letters only — " +
          "two is normal, three covers a middle initial, four is the ceiling."
      },
      400
    );
  }

  const categoryKey = trimOrNull(body.category_key);
  if (!categoryKey) {
    return jsonResponse({ error: "category_key is required" }, 400);
  }

  // PRESENCE of labor_hours picks the branch, not its value — `"0"` and `"-2"`
  // are wrong hours rather than an ordinary purchase, and routing them to the
  // amount validator would answer a bad hours box with a complaint about a field
  // the labor form doesn't render.
  //
  // ROUNDED TO THE COLUMN'S PRECISION BEFORE ANYTHING ELSE LOOKS AT IT.
  // `labor_hours` is numeric(8,2), so 2.125 is STORED as 2.13 — but the RPCs
  // price from the argument they were handed, not from what the column kept.
  // The row would then carry hours, a rate and an amount that no longer satisfy
  // `amount = round(hours * rate, 2)`, and the CHECK constraint
  // expense_entry_labor_amount_matches rejects it with 23514 — which
  // translatePgError deliberately does not translate, so the operator gets a
  // bare 500 for typing three decimal places. Rounding here, above the > 0
  // guard, makes the two agree by construction and still rejects hours that
  // round away to nothing.
  const laborHoursRaw = toNumOrNull(body.labor_hours);
  const laborHours =
    laborHoursRaw == null ? null : Math.round(laborHoursRaw * 100) / 100;
  const isLaborBody = body.labor_hours != null && body.labor_hours !== "";

  let amount: number;
  if (isLaborBody) {
    if (laborHours == null || laborHours <= 0) {
      return jsonResponse(
        {
          error: "hours billed to site must be greater than zero",
          reason:
            "Maintenance labor is entered as hours; the dollar cost is worked " +
            "out from the current hourly rate when the entry is saved."
        },
        400
      );
    }
    // The RPC IGNORES this and computes round(hours * rate, 2) itself — see the
    // file header. Zero rather than a client-side product on purpose: if this
    // ever reached the row, a zero-dollar labor line is obviously broken,
    // whereas a plausible-looking wrong number is not.
    amount = 0;
  } else {
    // SIGNED — a refund or credit memo is negative and there is deliberately no
    // >= 0 check here or in the database. Zero IS rejected, though: it is never
    // a real purchase, and it is what an empty or unparseable amount box looks
    // like once Number("") has had its way with it. Naming that beats filing a
    // zero-dollar row nobody can reconcile.
    const parsed = toNumOrNull(body.amount);
    if (parsed == null || parsed === 0) {
      return jsonResponse(
        {
          error: "amount is required and cannot be zero",
          reason:
            "Enter the purchase amount. Refunds and credit memos are entered as " +
            "negative numbers."
        },
        400
      );
    }
    amount = parsed;
  }

  const resolved = await resolveWritableLocation(env, locationId, scope);
  if (!resolved.ok) return resolved.response;

  const sb = createServiceClient(env);

  // Present means edit. Read the existing row before writing anything, both to
  // check the caller's scope against where the row IS (see the header) and so a
  // stale edit form gets a 404 rather than a confusing partial write.
  const id = trimOrNull(body.id);
  if (id) {
    const existing = await getExpenseEntry(sb, id);

    // ONE ANSWER FOR "GONE" AND FOR "NOT YOURS", ON PURPOSE. Splitting these
    // into a 404 and a 403 would turn the endpoint into an existence oracle:
    // feed it uuids and the status code tells you which ones name real rows at
    // sites you can't see. The operator-facing case is the same either way —
    // the row is not in the log they are looking at — so the copy is written to
    // be true of both.
    if (!existing || !inScope(scope, existing.location_code)) {
      return jsonResponse(
        {
          error: "not found",
          reason:
            "That entry isn't in your log any more. Reload — it may have been " +
            "voided or moved while this form was open."
        },
        404
      );
    }
    // Voided is refused by the RPC too (it is the authority, so no other caller
    // can route around it). Answering here as well keeps the message specific
    // and saves a round trip on the one case a stale page reliably produces.
    if (existing.voided_at) {
      return jsonResponse(
        {
          error: "entry is voided",
          reason:
            "This entry was voided" +
            (existing.voided_by_email ? ` by ${existing.voided_by_email}` : "") +
            ". Restore it before editing it."
        },
        409
      );
    }

    const update: ExpenseEntryUpdate = {
      id,
      business_date: businessDate,
      ...resolved.key,
      po_initials: initials,
      method: trimOrNull(body.method),
      description: trimOrNull(body.description),
      category_key: categoryKey,
      amount,
      labor_hours: isLaborBody ? laborHours : null,
      mechanic_key: isLaborBody ? trimOrNull(body.mechanic_key) : null,
      updated_by: session.userId,
      updated_by_email: session.email
    };

    try {
      const entry = await updateExpenseEntry(sb, update);
      // `reissued` so the page can say "the PO changed to X — mark the invoice"
      // rather than making the operator diff two numbers. Computed here from the
      // before/after rather than returned by the RPC, because the RPC's job is
      // the row and this is a statement about the edit.
      return jsonResponse({
        entry,
        updated: true,
        reissued: entry.po_number !== existing.po_number,
        previous_po_number: existing.po_number
      });
    } catch (err) {
      const translated = translatePgError(err);
      if (translated) return translated;
      throw err;
    }
  }

  const row: ExpenseEntryInsert = {
    business_date: businessDate,
    ...resolved.key,
    po_initials: initials,
    // Blank method/description are collapsed to NULL by the RPC; trimOrNull
    // already produces the null, so the two agree either way. On the labor path
    // the RPC also NULLs the method outright — Josh: "if that is chosen, payment
    // method should not be needed" — so a form that leaves the field mounted
    // doesn't file a payment method against hours that weren't paid for at a
    // register.
    method: trimOrNull(body.method),
    description: trimOrNull(body.description),
    category_key: categoryKey,
    amount,
    labor_hours: isLaborBody ? laborHours : null,
    // Always null in v1: nothing writes a per-mechanic rate yet. Read from the
    // body regardless so the column is wired end to end the day one is.
    mechanic_key: isLaborBody ? trimOrNull(body.mechanic_key) : null,
    created_by: session.userId,
    created_by_email: session.email
  };

  try {
    const entry = await insertExpenseEntry(sb, row);
    return jsonResponse({ entry }, 201);
  } catch (err) {
    const translated = translatePgError(err);
    if (translated) return translated;
    throw err;
  }
}

/**
 * Void an entry: soft delete, keeping the row and its PO number.
 *
 * THE ACTOR COMES FROM THE SESSION AND NEVER FROM THE BODY. `voided_by` is the
 * only record of who removed a line from a money log, and a client-supplied one
 * is worth exactly nothing as an audit trail.
 *
 * Takes no location scope check of its own, and that is not a hole: the target
 * is an id, and voidExpenseEntry() matches on it directly. A caller would have
 * to already know the uuid of an out-of-scope row, which the scoped list never
 * shows them. Adding a resolve-and-check here would mean a third round trip to
 * defend against guessing a v4 uuid.
 *
 * Voids ONE ROW, not one PO — a split purchase is two rows sharing a PO and
 * voiding the wrongly-categorised leg must leave the other intact.
 */
async function apiVoidEntry(
  request: Request,
  env: Env,
  session: Session
): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

  const id = trimOrNull(body.id);
  if (!id) {
    return jsonResponse(
      {
        error: "id is required",
        reason:
          "Voiding targets one entry row, not a PO number — a split purchase is " +
          "two rows sharing one PO."
      },
      400
    );
  }

  const sb = createServiceClient(env);
  try {
    const entry = await voidExpenseEntry(sb, {
      id,
      voidedBy: session.userId,
      voidedByEmail: session.email,
      reason: trimOrNull(body.reason)
    });
    return jsonResponse({ entry });
  } catch (err) {
    // voidExpenseEntry() distinguishes "no such entry" from "already voided" and
    // throws a plain Error for each — the two have different fixes and it goes
    // to the trouble of a second query to tell them apart, so collapsing both
    // into a 500 would throw that away. Matched on the message because that is
    // the only signal it carries; if a code is ever added there, switch to it.
    const msg = err instanceof Error ? err.message : "";
    if (/already voided/.test(msg)) {
      return jsonResponse({ error: "already voided", reason: msg }, 409);
    }
    if (/not found/.test(msg)) {
      return jsonResponse({ error: "not found", reason: msg }, 404);
    }
    throw err;
  }
}

/**
 * Set or correct one category's budget for one site-month.
 *
 * Insert-then-update behind upsertExpenseBudget(), so a correction leaves
 * `created_by` alone — correcting a budget is precisely when you want to know
 * who set the original number. `corrected` in the response says which of the
 * two happened so the page doesn't have to infer it from timestamps.
 */
async function apiUpsertBudget(
  request: Request,
  env: Env,
  session: Session,
  scope: string[] | undefined
): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

  const month = requireMonth(body.period_month, "period_month");
  if (!month.ok) return month.response;

  const locationId = toIntOrNull(body.location_id);
  if (locationId == null) {
    return jsonResponse({ error: "location_id is required" }, 400);
  }

  const categoryKey = trimOrNull(body.category_key);
  if (!categoryKey) {
    return jsonResponse({ error: "category_key is required" }, 400);
  }

  // Zero is a LEGITIMATE budget here, unlike a zero entry amount: "this site
  // budgets nothing for snow removal" is a real ceiling and the rollup grades
  // against it. So presence is what's required, not truthiness — which is also
  // why this can't be written as `if (!budgetAmount)`.
  const budgetAmount = toNumOrNull(body.budget_amount);
  if (budgetAmount == null) {
    return jsonResponse({ error: "budget_amount is required" }, 400);
  }
  // Checked here as well as by expense_budget_nonneg, because the DB message
  // wouldn't explain the asymmetry with entry amounts, which ARE signed.
  if (budgetAmount < 0) {
    return jsonResponse(
      {
        error: "budget_amount cannot be negative",
        reason:
          "A budget is a ceiling, and a negative ceiling makes the variance " +
          "arithmetic meaningless. Refunds are recorded as negative ENTRIES."
      },
      400
    );
  }

  const resolved = await resolveWritableLocation(env, locationId, scope);
  if (!resolved.ok) return resolved.response;

  const input: ExpenseBudgetInsert = {
    period_month: month.value,
    ...resolved.key,
    category_key: categoryKey,
    budget_amount: budgetAmount,
    note: trimOrNull(body.note),
    created_by: session.userId,
    created_by_email: session.email
  };

  const sb = createServiceClient(env);
  try {
    const { row, corrected } = await upsertExpenseBudget(sb, input);
    return jsonResponse({ budget: row, corrected });
  } catch (err) {
    const translated = translatePgError(err);
    if (translated) return translated;
    throw err;
  }
}

/**
 * Carry one site's budget forward from one month to another.
 *
 * DOES NOT OVERWRITE — the function is ON CONFLICT DO NOTHING, so re-running is
 * idempotent and a category already budgeted in the target month keeps its own
 * number.
 *
 * `created` is rows ACTUALLY inserted, which is NOT the number of rows in the
 * source month. Report it as-is ("9 copied, 4 already set"); a UI that renders
 * it as "copied 13" over a no-op is lying about a money figure.
 *
 * The db layer calls the same value `copied`; the rename to `created` is fixed
 * by the UI contract and happens here, at the one place it crosses the wire.
 */
async function apiCopyBudgetMonth(
  request: Request,
  env: Env,
  session: Session,
  scope: string[] | undefined
): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

  const locationId = toIntOrNull(body.location_id);
  if (locationId == null) {
    return jsonResponse({ error: "location_id is required" }, 400);
  }

  const from = requireMonth(body.from_month, "from_month");
  if (!from.ok) return from.response;
  const to = requireMonth(body.to_month, "to_month");
  if (!to.ok) return to.response;

  // The function raises SQLSTATE 22023 for this rather than silently no-opping,
  // which is the right behaviour but an ugly way to hear about it. Caught here
  // so the message names the mistake.
  if (from.value === to.value) {
    return jsonResponse(
      {
        error: "source and target month are the same",
        reason: "Pick a different month to copy the budget into."
      },
      400
    );
  }

  const resolved = await resolveWritableLocation(env, locationId, scope);
  if (!resolved.ok) return resolved.response;

  const sb = createServiceClient(env);
  const { copied } = await copyExpenseBudgetMonth(sb, {
    // resolved.key.location_id rather than the body's, even though
    // resolveWritableLocation() looked it up BY that value: the scope check was
    // performed against the resolved key, so the resolved key is what the write
    // must use. Passing the raw input back in is how the two drift.
    locationId: resolved.key.location_id,
    fromMonth: from.value,
    toMonth: to.value,
    createdBy: session.userId,
    createdByEmail: session.email
  });
  return jsonResponse({ created: copied });
}

/* ============================================================
 * Labor rate
 * ============================================================ */

/**
 * Every rate ever set, newest first — the admin screen's history, and the
 * entry form's "hours × $X" preview.
 *
 * NOT SCOPED, and it doesn't need to be: one company-wide number, identical for
 * every site, that anyone entering hours has to be able to see before they
 * enter them. The "pertrack" grant index.ts already checked is the whole gate.
 *
 * RETURNS THE HISTORY, NOT THE CURRENT RATE. Which row is in force on a given
 * date is expense_labor_rate_for()'s answer, and the entry path gets it from
 * there rather than from this list — a UI that takes rates[0] as "current" is
 * right until somebody schedules a raise for next month, at which point it
 * prices today's work at next month's rate. If a caller genuinely needs the
 * scalar, add a `?date=` endpoint over getExpenseLaborRate(); don't infer it.
 */
async function apiListLaborRates(env: Env): Promise<Response> {
  const sb = createServiceClient(env);
  const rates = await listExpenseLaborRates(sb);
  return jsonResponse({ rates });
}

/**
 * Set a new hourly rate, effective from a date.
 *
 * SUPER_ADMIN ONLY (Josh, 2026-08-21), tested on session.role directly rather
 * than through locationScopeFor(): that helper's full-admin tier also admits a
 * dcRole admin, which is the right rule for "may write an expense at any site"
 * and the wrong one for "may reprice labor company-wide".
 *
 * INSERT ONLY — no edit, no delete, no upsert. A rate is superseded by a newer
 * row, never corrected in place, because entries already logged stamped the old
 * value onto themselves (expense_entry.labor_rate) and editing the source row
 * would leave the history saying one thing and the entries another. Setting a
 * wrong rate is fixed by setting the right one from the same effective date —
 * which is exactly what the unique index turns into a 409, on purpose: it forces
 * that to be a deliberate act rather than a silent overwrite of a number that
 * has already priced somebody's work.
 *
 * BACKDATING IS ALLOWED and does not reprice anything. `effective_from` may be
 * any date; existing entries keep the rate stamped on them at insert time, so a
 * backdated rate only affects entries created after it. That is a feature — a
 * raise agreed in June and entered in August prices June's future entries
 * correctly without rewriting July's paperwork.
 */
async function apiCreateLaborRate(
  request: Request,
  env: Env,
  session: Session
): Promise<Response> {
  if (session.role !== "super_admin") {
    return jsonResponse(
      {
        // A SENTENCE AND NOT "forbidden", unlike the bare status words used
        // elsewhere. apps/web's performancePostJson surfaces `error` and drops
        // `reason`, so whatever is in this field is the entire banner the user
        // reads. Every other error on this module already reads as a sentence
        // for that reason; this one is the only 403 a form can provoke.
        error:
          "Only a super admin can change the maintenance labor rate — it is " +
          "company-wide and applies to every site.",
        reason:
          "The expense log itself is open to anyone with the pertrack grant; " +
          "this one setting is not, because changing it changes every " +
          "location's numbers at once."
      },
      403
    );
  }

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

  const effectiveFrom = isoDateOrNull(body.effective_from);
  if (!effectiveFrom) {
    return jsonResponse(
      {
        error: "effective_from (YYYY-MM-DD) is required",
        reason:
          "The rate applies to entries dated on or after this day, until a later " +
          "rate supersedes it."
      },
      400
    );
  }

  // Strictly positive, matching expense_labor_rate_positive. Checked here too
  // because the constraint's message wouldn't explain why zero is different from
  // a zero BUDGET, which is legitimate: a budget of nothing is a real ceiling,
  // an hourly rate of nothing prices a day's work at nothing and passes every
  // other check silently.
  const ratePerHour = toNumOrNull(body.rate_per_hour);
  if (ratePerHour == null || ratePerHour <= 0) {
    return jsonResponse(
      {
        error: "rate_per_hour must be greater than zero",
        reason: "Enter the hourly rate maintenance labor is billed to sites at."
      },
      400
    );
  }

  const input: ExpenseLaborRateInsert = {
    // Read from the body but always null from today's UI — see the type. Wiring
    // it now costs nothing and means turning per-mechanic rates on is a form
    // field rather than a trip back through four layers.
    mechanic_key: trimOrNull(body.mechanic_key),
    effective_from: effectiveFrom,
    rate_per_hour: ratePerHour,
    note: trimOrNull(body.note),
    created_by: session.userId,
    created_by_email: session.email
  };

  const sb = createServiceClient(env);
  try {
    const rate = await insertExpenseLaborRate(sb, input);
    return jsonResponse({ rate }, 201);
  } catch (err) {
    const translated = translatePgError(err);
    if (translated) return translated;
    throw err;
  }
}

/* ============================================================
 * Postgres error translation
 * ============================================================ */

/**
 * Turn the constraint violations a caller can actually provoke into readable
 * 4xx, and leave everything else to index.ts's 500 handler.
 *
 * Returns null for anything unrecognised ON PURPOSE. A translation table that
 * falls back to "bad request" would relabel genuine server faults as user error
 * and hide them from the logs.
 *
 * Constraint names come from supabase/expense-log-tables.sql; PostgREST
 * surfaces them in `details`/`message`, and supabase-js puts the SQLSTATE in
 * `code`.
 */
function translatePgError(err: unknown): Response | null {
  if (typeof err !== "object" || err === null) return null;
  const e = err as { code?: string; message?: string; details?: string };
  const text = `${e.message ?? ""} ${e.details ?? ""}`;

  // 22023 invalid_parameter_value — raised by next_expense_po() for bad
  // initials, by copy_expense_budget_month() for from == to, and by
  // insert_expense_entry() for all four labor mismatches. The first two are
  // pre-checked above, so reaching here on those means the two copies of the
  // rule disagreed; the labor ones are NOT pre-checked and this is their
  // intended exit — see apiWriteEntry, which deliberately leaves the database
  // as the authority on what a category accepts.
  //
  // The RPC's messages are written to be read by the person who filled the form
  // ("no labor rate is in effect on 2026-08-21 — an administrator must set one
  // before hourly work can be logged"), so `reason` passes them through
  // verbatim. Don't replace them with a generic string; the actionable half of
  // that sentence is the half a generic string throws away.
  if (e.code === "22023") {
    // One 22023 is not a bad value at all: update_expense_entry() uses it to
    // refuse an edit to a voided row. That is a state conflict, not a malformed
    // field, and 400 would send the operator looking for the box they got wrong
    // when the fix is to restore the row first. Matched on the message because
    // plpgsql gives a RAISE one SQLSTATE and this function shares it with the
    // labor validations; if these ever need to be told apart more finely, the
    // RPC should start using distinct codes rather than this string growing.
    if (/is voided/.test(text)) {
      return jsonResponse({ error: "entry is voided", reason: e.message ?? "" }, 409);
    }
    return jsonResponse({ error: "invalid value", reason: e.message ?? "" }, 400);
  }

  // P0002 no_data_found — raised by update_expense_entry() when the id matches
  // nothing. Nothing else on this module raises it, and no constraint produces
  // it, so it is unambiguous. 404 rather than the 400 its siblings get: the body
  // was well-formed and the row simply isn't there, which for an edit form
  // usually means somebody else voided or the page is stale.
  if (e.code === "P0002") {
    return jsonResponse({ error: "not found", reason: e.message ?? "" }, 404);
  }

  // 23503 foreign_key_violation — only reachable via category_key, the one FK
  // on either table that a request body feeds.
  if (e.code === "23503") {
    return jsonResponse(
      {
        error: "unknown category",
        reason:
          "That category_key isn't in expense_categories. Pick one from " +
          "GET /api/expenses/categories."
      },
      400
    );
  }

  // 23514 check_violation — named individually because "violates check
  // constraint expense_budget_month_first" tells an operator nothing.
  if (e.code === "23514") {
    if (text.includes("expense_budget_month_first")) {
      return jsonResponse(
        {
          error: "period_month must be the first of the month",
          reason: "Budgets are stored per month, keyed on YYYY-MM-01."
        },
        400
      );
    }
    if (text.includes("expense_budget_nonneg")) {
      return jsonResponse({ error: "budget_amount cannot be negative" }, 400);
    }
    if (text.includes("expense_entry_initials_shape")) {
      return jsonResponse({ error: "po_initials must be 1-4 letters" }, 400);
    }
    // The one check on either table that a CORRECT caller can never trip: the
    // amount is computed by the RPC from the hours and the rate it looked up, so
    // for the three of them to disagree, either that arithmetic changed or
    // something wrote the row around insert_expense_entry(). Neither is a
    // request the user can fix, so this stays a 500 by returning null — the
    // whole point of the fall-through — instead of blaming the form.
    if (text.includes("expense_entry_labor_amount_matches")) return null;
    if (text.includes("expense_entry_labor_hours_positive")) {
      return jsonResponse(
        { error: "hours billed to site must be greater than zero" },
        400
      );
    }
    if (text.includes("expense_labor_rate_positive")) {
      return jsonResponse({ error: "rate_per_hour must be greater than zero" }, 400);
    }
    return jsonResponse({ error: "invalid value", reason: e.message ?? "" }, 400);
  }

  // 23505 unique_violation on expense_entry_po_seq_unique means two writes got
  // the same sequence for one site-day — the exact race the advisory lock in
  // next_expense_po() exists to prevent, so it should be unreachable from either
  // the insert or the edit's re-mint. 409 with a retry hint rather than a 500:
  // the user can just submit again, and the line stays in the log for whoever
  // has to work out how the lock was bypassed.
  //
  // The copy covers BOTH paths deliberately. It used to say "two entries were
  // saved", which on an edit that moved a row to another site-day describes
  // something the operator didn't do and can't picture. "Saved at the same
  // moment" is true of a new entry and of a move, and "try again" is the fix for
  // both.
  if (e.code === "23505" && text.includes("expense_entry_po_seq")) {
    return jsonResponse(
      {
        error: "PO number collision",
        reason:
          "Two entries hit this site and date at the same moment, so the PO " +
          "sequence collided. Nothing was saved — try again."
      },
      409
    );
  }

  // 23505 on idx_expense_labor_rate_unique — a second rate for the same
  // effective date. REACHABLE and not a race: it is what "fix the rate I just
  // set" looks like, and refusing it is the point. There is no update path (see
  // apiCreateLaborRate), so the fix is a new row from a later date; silently
  // overwriting would restate the price of work already logged.
  if (e.code === "23505" && text.includes("expense_labor_rate")) {
    return jsonResponse(
      {
        error: "a rate is already set for that date",
        reason:
          "Rates are never edited, only superseded — entries already logged " +
          "carry the rate they were priced at. Set the new rate from a later " +
          "date instead."
      },
      409
    );
  }

  return null;
}

/* ============================================================
 * Coercion
 * (deliberately local, matching the helpers in ./greeter.ts and index.ts — see
 * the note there. Same names, same semantics, so the three files read alike.)
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
 * Accept only YYYY-MM-DD. `business_date` is a Postgres DATE, part of the PO
 * number and part of the sequence key, so a stray timestamp or "8/3/2026" would
 * either be rejected by the database or file the purchase under the wrong day
 * and mint a PO that says so.
 */
function isoDateOrNull(v: unknown): string | null {
  const t = trimOrNull(v);
  if (!t || !/^\d{4}-\d{2}-\d{2}$/.test(t)) return null;
  return t;
}

/**
 * Accept only the FIRST of a month, as YYYY-MM-01.
 *
 * Stricter than the database, which date_trunc()s whatever it is given, and
 * stricter than monthBounds() in the db layer, which takes any day. That is the
 * point: `expense_budget_month_first` CHECKs the stored value, so a mid-month
 * date sent to the budget endpoints is either a caller that forgot to
 * normalise or a month picker wired to today — and both are worth a message
 * that says which value was wrong rather than a silent rounding the caller
 * never learns about. The month reads use the same rule so one `?month=` value
 * works across every endpoint on this module.
 *
 * The month component is range-checked because /^\d{4}-\d{2}-01$/ happily
 * matches "2026-13-01", which Postgres would reject as a bad date.
 */
function monthStartOrNull(v: unknown): string | null {
  const t = isoDateOrNull(v);
  if (!t) return null;
  const month = Number(t.slice(5, 7));
  if (month < 1 || month > 12) return null;
  if (t.slice(8, 10) !== "01") return null;
  return t;
}

/** The 400 both month paths return, naming the offending parameter and value. */
function badMonth(name: string, raw: string | null): Response {
  return jsonResponse(
    {
      error: `${name} must be the first of a month (YYYY-MM-01)`,
      reason:
        "Expense budgets and rollups are keyed on the first of the month, so " +
        `"${raw ?? ""}" can't be matched against them.`
    },
    400
  );
}

/**
 * A required month parameter, as the same ok/response union
 * resolveWritableLocation() returns — so a handler's guard clauses all read the
 * same way regardless of what they're guarding.
 */
function requireMonth(
  v: unknown,
  name: string
): { ok: true; value: string } | { ok: false; response: Response } {
  const raw = trimOrNull(v);
  if (!raw) {
    return {
      ok: false,
      response: jsonResponse(
        {
          error: `${name} (YYYY-MM-01) is required`,
          reason:
            "Without a month this would read every month of every site, which is " +
            "not what any view renders."
        },
        400
      )
    };
  }
  const month = monthStartOrNull(raw);
  if (!month) return { ok: false, response: badMonth(name, raw) };
  return { ok: true, value: month };
}
