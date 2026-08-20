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
//   POST /api/expenses/entries                    -> { entry }   201
//   POST /api/expenses/entries/void               -> { entry }
//   GET  /api/expenses/budgets       month req.   -> { budgets }
//   POST /api/expenses/budgets                    -> { budget, corrected }
//   POST /api/expenses/budgets/copy               -> { created }
//   GET  /api/expenses/rollup        month req.   -> { rows }
//
// RESPONSES ARE ENVELOPED ({ entries: [...] }), unlike greeter.ts which returns
// bare arrays. Not an inconsistency for its own sake: two of these endpoints
// have to return a scalar alongside the payload (`corrected`, `created`), and a
// route table where half the shapes are arrays and half are objects is the kind
// of thing a caller gets wrong once per endpoint. One shape for all eight.
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

import type { Session } from "@splash/auth";
import {
  copyExpenseBudgetMonth,
  createServiceClient,
  insertExpenseEntry,
  listExpenseBudgets,
  listExpenseCategories,
  listExpenseMonthRollup,
  listExpenses,
  resolveExpenseLocationKey,
  upsertExpenseBudget,
  voidExpenseEntry,
  type SupabaseEnv
} from "@splash/db-supabase";
import { json as jsonResponse } from "@splash/http";
import type {
  ExpenseBudgetInsert,
  ExpenseEntryInsert,
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

  // Writes: authorise by location_id against the SESSION scope alone.
  if (pathname === "/api/expenses/entries" && method === "POST") {
    return apiCreateEntry(request, env, session, scope);
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
 * Create an entry. The database mints the PO number.
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
 */
async function apiCreateEntry(
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

  // SIGNED — a refund or credit memo is negative and there is deliberately no
  // >= 0 check here or in the database. Zero IS rejected, though: it is never a
  // real purchase, and it is what an empty or unparseable amount box looks like
  // once Number("") has had its way with it. Naming that beats filing a
  // zero-dollar row nobody can reconcile.
  const amount = toNumOrNull(body.amount);
  if (amount == null || amount === 0) {
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

  const resolved = await resolveWritableLocation(env, locationId, scope);
  if (!resolved.ok) return resolved.response;

  const row: ExpenseEntryInsert = {
    business_date: businessDate,
    ...resolved.key,
    po_initials: initials,
    // Blank method/description are collapsed to NULL by the RPC; trimOrNull
    // already produces the null, so the two agree either way.
    method: trimOrNull(body.method),
    description: trimOrNull(body.description),
    category_key: categoryKey,
    amount,
    created_by: session.userId,
    created_by_email: session.email
  };

  const sb = createServiceClient(env);
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
  // initials and by copy_expense_budget_month() for from == to. Both are
  // pre-checked above, so reaching here means the two copies of the rule
  // disagreed; still worth a 400 rather than a 500, since the caller can fix it.
  if (e.code === "22023") {
    return jsonResponse({ error: "invalid value", reason: e.message ?? "" }, 400);
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
    return jsonResponse({ error: "invalid value", reason: e.message ?? "" }, 400);
  }

  // 23505 unique_violation on expense_entry_po_seq_unique means two inserts got
  // the same sequence for one site-day — the exact race the advisory lock in
  // next_expense_po() exists to prevent, so it should be unreachable. 409 with
  // a retry hint rather than a 500: the user can just submit again, and the
  // line stays in the log for whoever has to work out how the lock was bypassed.
  if (e.code === "23505" && text.includes("expense_entry_po_seq")) {
    return jsonResponse(
      {
        error: "PO number collision",
        reason: "Two entries were saved for this site and date at once. Try again."
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
