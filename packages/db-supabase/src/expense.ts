// Expense log queries — expense_entry / expense_budget / expense_categories.
// Schema + the reasoning behind every rule below: supabase/expense-log-tables.sql.
//
// Read that header before touching anything here. The four rules this module
// exists to enforce, and which are easy to break by "simplifying":
//
//  1. ENTRIES ARE INSERTED THROUGH insert_expense_entry(), NEVER through
//     `.from("expense_entry").insert()`. The PO sequence is allocated inside
//     that function under `pg_advisory_xact_lock`, and the lock is
//     TRANSACTION-scoped. Calling next_expense_po() over one round trip and
//     inserting over a second ends the transaction — and releases the lock —
//     before the row lands, which puts the race straight back: two greeters
//     entering an order in the same second both read seq 6, both write 7, and
//     one dies on a 23505 the user can do nothing about. Do not add a
//     `SELECT MAX(po_seq)+1` here. That is the exact bug the function exists
//     to prevent.
//
//  2. `amount` IS SIGNED. Refunds are negative. No non-negative guard, here or
//     anywhere upstream — the column deliberately has no such CHECK.
//
//  3. DELETES ARE SOFT. Every read in this file filters `voided_at IS NULL`.
//     A voided entry keeps its PO number so the paperwork still reconciles,
//     which means it is still sitting in the table waiting to be summed by any
//     query that forgets about it.
//
//  4. `po_number` IS NOT UNIQUE. A split purchase is two rows sharing one PO.
//     Look entries up by `id`; treat a po_number match as a list.

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  ExpenseBudgetCopyInput,
  ExpenseBudgetCopyResult,
  ExpenseBudgetFilters,
  ExpenseBudgetInsert,
  ExpenseBudgetRow,
  ExpenseCategory,
  ExpenseEntryInsert,
  ExpenseEntryRow,
  ExpenseEntryUpdate,
  ExpenseLaborRateInsert,
  ExpenseLaborRateRow,
  ExpenseListFilters,
  ExpenseLocationKey,
  ExpenseMonthRollupRow,
  ExpenseRollupFilters,
  ExpenseVoidInput
} from "@splash/types/expense";

/* ============================================================
 * Location resolution
 * ============================================================ */

/**
 * Resolve the full location key from the id the LocationPicker submits.
 *
 * Identical two-hop shape to resolveGreeterLocationKey() in greeter.ts, because
 * it is the same problem: `locations` has no location_code column, its business
 * key is site_number, and pricing_simple is where the code lives:
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
 *
 * CALLERS MUST TREAT NULL AS A HARD REJECT AND REFUSE THE WRITE. This matters
 * more here than it does on the greeter side, for two reasons on top of the
 * usual one:
 *
 *   * expense_entry.location_code is NOT NULL and has no FK to `locations`, so
 *     nothing downstream will catch a wrong value. A row written with a
 *     null-ish or guessed code would be invisible to its own location admin
 *     (their scope filter would never match it) while potentially surfacing in
 *     another site's scoped view — an expense silently escaping location
 *     scoping, in a money log.
 *   * `site_number` from this call becomes the literal PREFIX of the PO number
 *     the database assembles. Getting it wrong doesn't just misfile the row, it
 *     mints a PO that claims to belong to another site, onto paperwork that
 *     someone will later try to reconcile.
 *
 * Do not fall back to a default site, do not pass the raw location_id through
 * as a code, and do not let the caller supply these three values from the
 * request body.
 */
export async function resolveExpenseLocationKey(
  client: SupabaseClient,
  locationId: number
): Promise<ExpenseLocationKey | null> {
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
 * Deliberately returns the codes instead of applying them: the consumers bind
 * them differently (supabase-js `.in()` calls and rpc arguments), and a generic
 * "apply to a query builder" helper can't be typed across a PostgREST builder
 * passed through another generic function. Keeping the rule in one place and
 * the binding at the call site is the part that matters.
 *
 * Copied rather than imported from greeter.ts, where it is module-private: the
 * two modules are independently deployable domain slices and neither should
 * become the other's utility library. If a third copy appears, promote it —
 * but promote it with this comment attached, because the empty-array case is
 * the whole point and it is invisible from the signature.
 */
function scopeCodes(scope: string[] | null | undefined): string[] | null {
  if (scope == null) return null;
  return scope.length > 0 ? scope : ["__no_location__"];
}

/* ============================================================
 * Month arithmetic
 * ============================================================ */

/**
 * First-of-month and first-of-next-month for any day in a month, as
 * `YYYY-MM-DD` strings.
 *
 * Done with string arithmetic and NOT with `new Date(...)` on purpose.
 * `new Date("2026-08-01")` parses as UTC midnight and then renders in the
 * runtime's local zone, so on a worker running west of UTC the "first of
 * August" comes back as 31 July and every month boundary is off by a day. The
 * values here are Postgres `date`s — calendar labels with no time and no zone —
 * and treating them as strings is the only representation that can't drift.
 *
 * The upper bound is EXCLUSIVE (`< next month`) rather than an inclusive last
 * day, which sidesteps leap years and short months entirely and matches the
 * `>= month_start AND < month_end` bounds expense_month_rollup() uses, so the
 * list and the rollup can never disagree about which rows are in the month.
 */
function monthBounds(day: string): { start: string; endExclusive: string } {
  const m = /^(\d{4})-(\d{2})/.exec(day.trim());
  if (!m) {
    throw new Error(`expense: month must start with YYYY-MM, got "${day}"`);
  }
  const year = Number(m[1]);
  const month = Number(m[2]); // 1-12
  if (month < 1 || month > 12) {
    throw new Error(`expense: month out of range in "${day}"`);
  }
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return {
    start: `${m[1]}-${m[2]}-01`,
    endExclusive: `${String(nextYear).padStart(4, "0")}-${String(nextMonth).padStart(2, "0")}-01`
  };
}

/**
 * Strip PostgREST's filter-grammar metacharacters from a free-text needle.
 *
 * An unescaped comma or paren would terminate the ilike operand and change the
 * query shape — `.ilike("description", "*a,b*")` is parsed as two filters, not
 * one substring. `*` is PostgREST's wildcard, so a user typing one would widen
 * their own search in a way they didn't ask for. Same treatment the greeter
 * name search gets in greeter.ts.
 *
 * Returns null for a needle that is empty (or was entirely metacharacters), so
 * callers can skip the predicate rather than binding `*%*`.
 */
function searchNeedle(raw: string | null | undefined): string | null {
  const needle = raw?.replace(/[(),*]/g, "").trim();
  return needle ? needle : null;
}

/* ============================================================
 * Categories
 * ============================================================ */

/**
 * The grid's columns, left to right.
 *
 * ACTIVE ONLY. This feeds the entry form's category picker and the budget
 * editor, and both are about what can be spent against NOW — a retired category
 * must not be selectable. Historical readback is a different question and is
 * answered by expense_month_rollup(), which keeps an inactive category wherever
 * it still carries a budget or an entry so a past month's total still agrees
 * with the sum of its own columns.
 *
 * Ordered by `sort_order`, which is unique and gapped by 10. Do not re-sort by
 * label: the operators read this grid left-to-right in workbook order and the
 * two-tier header ("Chemicals" spanning Wash and Detail) only forms correctly
 * when grouped categories stay adjacent.
 */
export async function listExpenseCategories(
  client: SupabaseClient
): Promise<ExpenseCategory[]> {
  const { data, error } = await client
    .from("expense_categories")
    // rolls_up_to and billed_by_hours come back so the FORM can drive off them:
    // an hourly category swaps its dollar box for an hours box and drops the
    // payment-method field, and neither decision should be a hard-coded key in
    // the UI. Note this list is not filtered by rolls_up_to — a child category
    // IS selectable when entering, it just isn't a column in the rollup grid.
    .select(
      "key,group_label,label,sort_order,active,rolls_up_to,billed_by_hours,created_at"
    )
    .eq("active", true)
    .order("sort_order", { ascending: true });
  if (error) throw error;
  return (data ?? []) as unknown as ExpenseCategory[];
}

/* ============================================================
 * Entries — reads
 * ============================================================ */

// Every column, explicitly. The void quad is selected even though every read
// below excludes voided rows (so it is always null in these results) because
// ExpenseEntryRow is also what insertExpenseEntry() returns straight from the
// RPC, and one row type for one table is worth four always-null fields.
const ENTRY_COLS =
  "id,business_date,location_id,site_number,location_code," +
  "po_number,po_initials,po_seq," +
  "method,description,category_key,amount," +
  // The hourly trio. Null on every non-labor row, and always null together
  // except mechanic_key, which is only meaningful when the other two are set.
  // Selected unconditionally for the same reason the void quad is: one row type
  // per table beats a conditional column list.
  "labor_hours,labor_rate,mechanic_key," +
  "voided_at,voided_by,voided_by_email,void_reason," +
  "created_at,created_by,created_by_email,updated_at,updated_by,updated_by_email";

/**
 * The entry list behind the Expense Log page and its filter bar.
 *
 * ALWAYS excludes voided rows — see the module header. There is no opt-in flag
 * to include them, deliberately: this is a money list, and a boolean that
 * defaults wrong in one caller silently inflates a total.
 *
 * DATE WINDOW PRECEDENCE: an explicit `date_from`/`date_to` beats
 * `period_month`. The month view and the ad-hoc range report are different
 * callers, and when both arrive the more specific request should win rather
 * than the two ANDing into an empty intersection that looks like "no expenses".
 *
 * The month path uses `>= start AND < next month`, matching the bounds
 * expense_month_rollup() uses, so the list and the header totals above it can
 * never disagree about which rows belong to the month.
 *
 * Ordered newest-first, then by PO sequence DESCENDING within a day, so the
 * entry somebody just saved is the top row of the page they land back on.
 *
 * `limit` defaults to 500, matching listGreeterDays(). This is a paged list,
 * not an aggregate — when a total is wanted, ask listExpenseMonthRollup(),
 * which is unlimited by design and sums in the database.
 */
export async function listExpenses(
  client: SupabaseClient,
  filters: ExpenseListFilters = {}
): Promise<ExpenseEntryRow[]> {
  let q = client
    .from("expense_entry")
    .select(ENTRY_COLS)
    // The soft-delete filter. Not optional, not conditional.
    .is("voided_at", null)
    .order("business_date", { ascending: false })
    .order("po_seq", { ascending: false })
    .limit(filters.limit ?? 500);

  const hasExplicitRange = Boolean(filters.date_from || filters.date_to);
  if (hasExplicitRange) {
    if (filters.date_from) q = q.gte("business_date", filters.date_from);
    if (filters.date_to) q = q.lte("business_date", filters.date_to);
  } else if (filters.period_month) {
    const { start, endExclusive } = monthBounds(filters.period_month);
    q = q.gte("business_date", start).lt("business_date", endExclusive);
  }

  if (filters.location_id != null) q = q.eq("location_id", filters.location_id);
  if (filters.site_number != null) q = q.eq("site_number", filters.site_number);
  if (filters.category_key) q = q.eq("category_key", filters.category_key);

  // Exact match, because this is somebody typing a number off a paper invoice.
  // May legitimately return several rows: a split purchase shares one PO.
  if (filters.po_number?.trim()) q = q.eq("po_number", filters.po_number.trim());

  const needle = searchNeedle(filters.description);
  if (needle) q = q.ilike("description", `*${needle}*`);

  const scope = scopeCodes(filters.location_scope);
  if (scope) q = q.in("location_code", scope);

  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as unknown as ExpenseEntryRow[];
}

/**
 * One entry by id, for the edit form to prefill from and for the worker to
 * scope-check an edit against.
 *
 * INCLUDES VOIDED ROWS, which every other read here refuses. Both callers need
 * them: the worker has to be able to answer "voided" rather than "not found",
 * and a prefill that 404s on a voided row sends somebody looking for a line they
 * can see sitting in the log. This is the reason the filter is not folded into
 * the shared query path — it is a genuine exception, and it is scoped to
 * single-row lookups where a voided row cannot silently land in a total.
 *
 * Returns null rather than throwing when the id matches nothing. A caller
 * looking a row up by an id from a URL is asking a question, not asserting the
 * row exists; the RPC is where "not found" becomes an error.
 */
export async function getExpenseEntry(
  client: SupabaseClient,
  id: string
): Promise<ExpenseEntryRow | null> {
  const { data, error } = await client
    .from("expense_entry")
    .select(ENTRY_COLS)
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return (data as unknown as ExpenseEntryRow | null) ?? null;
}

/* ============================================================
 * Entries — writes
 * ============================================================ */

/**
 * Create an entry, letting the database mint the PO number.
 *
 * THIS IS AN RPC AND MUST STAY ONE. `insert_expense_entry()` allocates the
 * sequence and writes the row inside a single transaction, holding
 * `pg_advisory_xact_lock` on the (location, date) pair across both. Replacing
 * this with a table insert — or with next_expense_po() followed by an insert —
 * reintroduces the duplicate-sequence race the lock exists to remove, and the
 * failure mode is an opaque 23505 at 6pm on the busiest day of the month. The
 * unique constraint on (location_id, business_date, po_seq) is the guarantee;
 * this function is what stops it from ever being hit.
 *
 * The RPC also normalises for us and we deliberately do not duplicate any of
 * it: initials are uppercased and shape-checked there (a bad value raises
 * SQLSTATE 22023, not a constraint violation), blank method/description are
 * collapsed to NULL there, and category_key and amount are validated by the FK
 * and the column type. A second copy of a rule the database already enforces is
 * a second place for it to drift.
 *
 * HOURLY CATEGORIES ARE PRICED BY THE DATABASE, NOT HERE. For a category with
 * `billed_by_hours`, the caller sends `labor_hours` and the RPC looks up the
 * rate in force on `business_date`, multiplies, and writes both the amount and
 * the rate it used. `input.amount` is IGNORED on that path — pass 0. Do not
 * "helpfully" compute the amount in TS and send it: the client being able to
 * name the dollar figure is exactly what makes an admin-set rate advisory
 * rather than binding, and a stale page would then post yesterday's price.
 *
 * The RPC raises 22023 (surfacing as a readable 400) when an hourly category
 * arrives with no hours, when hours arrive on a category that isn't hourly, or
 * when no rate has ever been set for that date. That last one is deliberately
 * an error and not a $0.00 entry.
 *
 * The three location columns must come from resolveExpenseLocationKey(), never
 * from the request body — read that function's note on why.
 *
 * Returns the inserted row INCLUDING its assigned `po_number` and `po_seq`.
 * That echo is the entire point of server-side assignment: the submitter cannot
 * know the number until it is saved, so the response has to carry it back.
 */
export async function insertExpenseEntry(
  client: SupabaseClient,
  input: ExpenseEntryInsert
): Promise<ExpenseEntryRow> {
  const { data, error } = await client.rpc("insert_expense_entry", {
    p_business_date: input.business_date,
    p_location_id: input.location_id,
    p_site_number: input.site_number,
    p_location_code: input.location_code,
    // The column is `po_initials`; the function parameter is `p_initials`. The
    // one-word rename lives here so callers only learn the column vocabulary.
    p_initials: input.po_initials,
    p_method: input.method ?? null,
    p_description: input.description ?? null,
    p_category_key: input.category_key,
    p_amount: input.amount,
    p_created_by: input.created_by,
    p_created_by_email: input.created_by_email,
    p_labor_hours: input.labor_hours ?? null,
    p_mechanic_key: input.mechanic_key ?? null
  });
  if (error) throw error;

  // RETURNS expense_entry (a composite, not SETOF), so PostgREST hands back a
  // single JSON object rather than an array. A null here would mean the
  // function returned nothing at all, which it has no path to do — treat it as
  // a hard error rather than returning a half-typed row.
  if (data == null) {
    throw new Error("insert_expense_entry returned no row");
  }
  return data as unknown as ExpenseEntryRow;
}

/**
 * Correct a posted entry. Every field is rewritten; see ExpenseEntryUpdate.
 *
 * AN RPC FOR THE SAME REASON THE INSERT IS ONE. An edit that moves the row's
 * site or date moves it into a different PO sequence, so it has to take the same
 * `pg_advisory_xact_lock` and mint the next number inside the same transaction
 * as the write. A read-then-update from here would drop the lock between the two
 * and hand two concurrent edits the same sequence number.
 *
 * THE PO IS REISSUED ONLY WHEN THE NAMESPACE MOVES — i.e. when `location_id` or
 * `business_date` actually changes. Fixing a typo in the initials rebuilds the
 * PO string around the same `po_seq`; it does not consume a new number. Note
 * that a move LEAVES A GAP in the old day's sequence and the number printed on
 * the original paper invoice no longer resolves. That was accepted deliberately
 * (see the header of supabase/expense-edit-02.sql) as the price of editable
 * dates and sites.
 *
 * HOURLY ROWS ARE RE-PRICED FROM THE NEW DATE, not from the rate already stored
 * on the row. Once the date is editable, carrying the old rate forward produces
 * a row dated the 21st priced at the 20th's rate, which can neither explain
 * itself nor satisfy the expense_entry_labor_amount_matches CHECK. As on insert,
 * `input.amount` is ignored on the hourly path — pass 0.
 *
 * NOT-FOUND AND ALREADY-VOIDED ARE RAISED, NOT RETURNED. Unlike
 * voidExpenseEntry, which probes on its cold path, the RPC knows both cases
 * itself and raises P0002 and 22023 respectively — the worker's translatePgError
 * turns those into a 404 and a 409. There is nothing for a second round trip
 * here to discover.
 *
 * The location triple is the DESTINATION, and must come from
 * resolveExpenseLocationKey() like the insert's. Checking that the caller may
 * write to the row's CURRENT location is the worker's job and cannot be done
 * here: this function has no scope to check against, and an edit that only
 * validated the destination would let a location admin pull another site's row
 * into their own.
 */
export async function updateExpenseEntry(
  client: SupabaseClient,
  input: ExpenseEntryUpdate
): Promise<ExpenseEntryRow> {
  const { data, error } = await client.rpc("update_expense_entry", {
    p_id: input.id,
    p_business_date: input.business_date,
    p_location_id: input.location_id,
    p_site_number: input.site_number,
    p_location_code: input.location_code,
    // Same one-word rename as the insert: column `po_initials`, param
    // `p_initials`.
    p_initials: input.po_initials,
    p_method: input.method ?? null,
    p_description: input.description ?? null,
    p_category_key: input.category_key,
    p_amount: input.amount,
    p_updated_by: input.updated_by,
    p_updated_by_email: input.updated_by_email,
    p_labor_hours: input.labor_hours ?? null,
    p_mechanic_key: input.mechanic_key ?? null
  });
  if (error) throw error;

  // RETURNS expense_entry, so this is a single object. Null would mean the
  // function returned nothing, which it has no path to do — every failure it
  // knows about is a RAISE.
  if (data == null) {
    throw new Error("update_expense_entry returned no row");
  }
  return data as unknown as ExpenseEntryRow;
}

/**
 * Soft-delete an entry: stamp the void quad, keep the row and its PO number.
 *
 * Never a DELETE. This log reconciles against paper invoices, so a row that
 * vanishes leaves a gap in the site's PO sequence with nothing to explain it —
 * and next_expense_po() counts voided rows precisely so the number is never
 * reissued to a different purchase.
 *
 * VOIDS ONE ROW, NOT ONE PO. A split purchase is two rows sharing a PO; voiding
 * the wrongly-categorised leg must leave the other leg intact, so the target is
 * `id`.
 *
 * IDEMPOTENCE / ALREADY-VOIDED: the update carries `.is("voided_at", null)` in
 * its predicate, so re-voiding matches zero rows and cannot overwrite the
 * original voider and timestamp with a later one. When nothing matched we then
 * probe to say WHICH thing happened — "already voided" and "no such entry" have
 * different fixes, and collapsing them into one 404 sends the operator looking
 * for a row that is sitting right there. Both surface as a thrown Error rather
 * than a silent no-op: the caller asked for a state change and didn't get one.
 *
 * `voided_by` is required by the `expense_entry_void_pair` CHECK — a void with
 * no actor is unauditable, which defeats the point of not deleting. There is
 * intentionally no system/anonymous void path.
 */
export async function voidExpenseEntry(
  client: SupabaseClient,
  { id, voidedBy, voidedByEmail, reason }: ExpenseVoidInput
): Promise<ExpenseEntryRow> {
  const { data, error } = await client
    .from("expense_entry")
    .update({
      voided_at: new Date().toISOString(),
      voided_by: voidedBy,
      voided_by_email: voidedByEmail,
      void_reason: reason?.trim() ? reason.trim() : null,
      // updated_at moves via trg_expense_entry_touch; updated_by does not, so
      // set it here. A void is an edit, and the audit columns should agree.
      updated_by: voidedBy,
      updated_by_email: voidedByEmail
    })
    .eq("id", id)
    .is("voided_at", null)
    .select(ENTRY_COLS)
    .maybeSingle();
  if (error) throw error;
  if (data) return data as unknown as ExpenseEntryRow;

  // Nothing updated. Second read only on this cold path — the happy path stays
  // one round trip.
  const { data: probe, error: probeErr } = await client
    .from("expense_entry")
    .select("id,po_number,voided_at,voided_by_email")
    .eq("id", id)
    .maybeSingle();
  if (probeErr) throw probeErr;

  if (!probe) throw new Error(`expense entry ${id} not found`);
  const already = probe as { po_number: string; voided_at: string | null; voided_by_email: string | null };
  throw new Error(
    `expense entry ${id} (PO ${already.po_number}) was already voided at ` +
      `${already.voided_at} by ${already.voided_by_email ?? "unknown"}`
  );
}

/* ============================================================
 * Labor rate — the admin-set hourly price of maintenance labor
 * ============================================================ */

const LABOR_RATE_COLS =
  "id,mechanic_key,effective_from,rate_per_hour,note," +
  "created_at,created_by,created_by_email";

/**
 * Every rate ever set, newest first — the history screen and the audit trail in
 * one list.
 *
 * NOT filtered to "the current one". A rate table with no history is a number
 * in a settings box, and the whole reason this is row-per-effective-date is so
 * an August entry priced at the August rate can still be explained in November.
 * The current rate is the first element on the company-wide path; ask
 * `expense_labor_rate_for()` if you want the database's own answer.
 *
 * Ordered by effective_from DESC, then mechanic-specific rows after the
 * company-wide one for the same date, matching the resolution order in
 * expense_labor_rate_for(): the row that would WIN sorts first.
 *
 * No scope filter and no location columns — the rate is company-wide. Josh,
 * 2026-08-21: "as a whole. not on a per site basis".
 */
export async function listExpenseLaborRates(
  client: SupabaseClient,
  limit = 100
): Promise<ExpenseLaborRateRow[]> {
  const { data, error } = await client
    .from("expense_labor_rate")
    .select(LABOR_RATE_COLS)
    .order("effective_from", { ascending: false })
    .order("mechanic_key", { ascending: false, nullsFirst: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as unknown as ExpenseLaborRateRow[];
}

/**
 * The rate in force on a date, as the DATABASE resolves it.
 *
 * An RPC rather than a client-side scan of listExpenseLaborRates(), because
 * this is the same function insert_expense_entry() calls to price a row. Two
 * implementations of "which rate applies" is two answers the day somebody adds
 * a mechanic-specific row, and the one that matters is the one that already ran
 * inside the insert.
 *
 * NULL means no rate has ever been set for a date that early. Callers must
 * treat that as "cannot price labor yet" and say so — never as zero.
 */
export async function getExpenseLaborRate(
  client: SupabaseClient,
  businessDate: string,
  mechanicKey: string | null = null
): Promise<number | null> {
  const { data, error } = await client.rpc("expense_labor_rate_for", {
    p_business_date: businessDate,
    p_mechanic_key: mechanicKey
  });
  if (error) throw error;
  return data == null ? null : Number(data);
}

/**
 * Add a rate window. Super_admin only — enforced in performance-worker, not
 * here, matching every other authorisation in this module.
 *
 * A PLAIN INSERT, AND DELIBERATELY NOT AN UPSERT. Setting a rate for a date
 * that already has one is a conflict the operator needs to see, not something
 * to silently overwrite: the existing row may already have priced entries, and
 * replacing it would restate them. The unique index on
 * (COALESCE(mechanic_key,''), effective_from) is what raises, and 23505 here
 * can only be that index.
 *
 * There is no update and no delete path on purpose. A rate is superseded by a
 * later row, never edited — see the type's doc comment.
 */
export async function insertExpenseLaborRate(
  client: SupabaseClient,
  input: ExpenseLaborRateInsert
): Promise<ExpenseLaborRateRow> {
  const { data, error } = await client
    .from("expense_labor_rate")
    .insert({
      mechanic_key: input.mechanic_key?.trim() ? input.mechanic_key.trim() : null,
      effective_from: input.effective_from,
      rate_per_hour: input.rate_per_hour,
      note: input.note?.trim() ? input.note.trim() : null,
      created_by: input.created_by,
      created_by_email: input.created_by_email
    })
    .select(LABOR_RATE_COLS)
    .single();
  if (error) throw error;
  return data as unknown as ExpenseLaborRateRow;
}

/* ============================================================
 * Budgets
 * ============================================================ */

const BUDGET_COLS =
  "id,period_month,location_id,site_number,location_code," +
  "category_key,budget_amount,note," +
  "created_at,created_by,created_by_email,updated_at,updated_by,updated_by_email";

/**
 * The budget rows for one month, in scope.
 *
 * `periodMonth` is normalised to the first of its month and matched with `=`,
 * not a range: the `expense_budget_month_first` CHECK guarantees the stored
 * value IS the first of the month, so equality is exact and uses the
 * (location_code, period_month) index directly.
 *
 * A category with NO row here has no budget, which is NOT a budget of zero.
 * Don't densify this list against expense_categories to "fill the gaps" — that
 * is what expense_month_rollup() is for, and it is careful to keep the missing
 * ones as NULL rather than 0.
 *
 * No `limit`: bounded by (sites in scope x categories), and a truncated budget
 * list would silently under-report the month's total ceiling.
 */
export async function listExpenseBudgets(
  client: SupabaseClient,
  { periodMonth, scope, locationId, siteNumber }: ExpenseBudgetFilters
): Promise<ExpenseBudgetRow[]> {
  const { start } = monthBounds(periodMonth);

  let q = client
    .from("expense_budget")
    .select(BUDGET_COLS)
    .eq("period_month", start)
    .order("location_code", { ascending: true })
    .order("category_key", { ascending: true });

  if (locationId != null) q = q.eq("location_id", locationId);
  if (siteNumber != null) q = q.eq("site_number", siteNumber);

  const codes = scopeCodes(scope);
  if (codes) q = q.in("location_code", codes);

  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as unknown as ExpenseBudgetRow[];
}

/**
 * Set or correct one category's budget for one site-month, on the
 * (location_id, period_month, category_key) unique key.
 *
 * INSERT-THEN-UPDATE-ON-23505, not `.upsert()`. Exactly the reasoning behind
 * submitGreeterDay() in greeter.ts, and it applies here for the same reason: an
 * upsert writes every column in the payload, which would stamp the CORRECTING
 * user over `created_by`/`created_by_email` and destroy the record of who first
 * set the budget. The second path leaves the creator columns alone and sets
 * `updated_by`/`updated_by_email` instead. The extra round trip only happens on
 * the correction path, which is the rare case — and correcting a budget is
 * precisely when you most want to know who set the original number.
 *
 * 23505 is Postgres' unique_violation; here it can only be
 * `expense_budget_unique`, since the only other unique column is a generated
 * uuid PK.
 *
 * `period_month` is normalised to the first of the month before either write.
 * The CHECK would otherwise reject a mid-month date with a 23514 that reads
 * like a bug in the caller's data rather than a date they didn't round.
 *
 * `corrected` in the return distinguishes "created" from "changed" so the UI can
 * say which happened; the caller shouldn't have to infer it from timestamps.
 */
export async function upsertExpenseBudget(
  client: SupabaseClient,
  input: ExpenseBudgetInsert
): Promise<{ row: ExpenseBudgetRow; corrected: boolean }> {
  const row: ExpenseBudgetInsert = {
    ...input,
    period_month: monthBounds(input.period_month).start,
    note: input.note?.trim() ? input.note.trim() : null
  };

  const { data, error } = await client
    .from("expense_budget")
    .insert(row)
    .select(BUDGET_COLS)
    .single();

  if (!error) {
    return { row: data as unknown as ExpenseBudgetRow, corrected: false };
  }
  if (error.code !== "23505") throw error;

  // Drop the creator columns from the correction payload — see the note above.
  const { created_by: _c, created_by_email: _e, ...mutable } = row;
  const { data: updated, error: updErr } = await client
    .from("expense_budget")
    .update({
      ...mutable,
      updated_by: input.created_by,
      updated_by_email: input.created_by_email
    })
    .eq("location_id", row.location_id)
    .eq("period_month", row.period_month)
    .eq("category_key", row.category_key)
    .select(BUDGET_COLS)
    .single();
  if (updErr) throw updErr;

  return { row: updated as unknown as ExpenseBudgetRow, corrected: true };
}

/**
 * Carry one site's budget forward from one month to another.
 *
 * Sites set a budget once and adjust it; retyping thirteen numbers every month
 * is how a budget row quietly stops being maintained.
 *
 * DOES NOT OVERWRITE. The function is `ON CONFLICT DO NOTHING`, so a category
 * already budgeted in the target month keeps its own number — the operator's
 * edit always wins over the copy, whichever order the two happen in. Re-running
 * is therefore safe and idempotent.
 *
 * `copied` is rows ACTUALLY created, which is NOT the number of rows in the
 * source month. Report it as-is ("9 copied, 4 already set") rather than
 * claiming success over what may have been a complete no-op.
 *
 * Source and target must differ — the function raises SQLSTATE 22023 rather
 * than silently doing nothing, so a UI that lets someone pick the same month
 * twice gets told about it.
 */
export async function copyExpenseBudgetMonth(
  client: SupabaseClient,
  { locationId, fromMonth, toMonth, createdBy, createdByEmail }: ExpenseBudgetCopyInput
): Promise<ExpenseBudgetCopyResult> {
  const { data, error } = await client.rpc("copy_expense_budget_month", {
    p_location_id: locationId,
    // The function date_trunc()s both, but normalising here too means the value
    // we send is the month we are claiming to act on — which is what shows up
    // in a log line or an error message when this goes wrong.
    p_from_month: monthBounds(fromMonth).start,
    p_to_month: monthBounds(toMonth).start,
    p_created_by: createdBy,
    p_created_by_email: createdByEmail
  });
  if (error) throw error;

  // RETURNS integer — a bare JSON number, not a row.
  return { copied: typeof data === "number" ? data : 0 };
}

/* ============================================================
 * Month rollup
 * ============================================================ */

/**
 * Budget / actual / variance per category per site for a month — rows 1-3 of
 * the workbook sheet, transposed.
 *
 * An RPC rather than a view, for the same reason greeter_rollup() is one: a
 * view would have to aggregate before the month and scope filters could bind,
 * so every caller would silently get an all-time, all-sites total. The filters
 * are arguments and are applied to the base rows first.
 *
 * THE THREE NULLS ARE DISTINCT AND THIS FUNCTION PRESERVES THEM. Do not
 * coalesce, and do not "tidy" the row shape on the way out:
 *
 *   budget_amount NULL  no budget was ever set. NOT zero. Coalescing it to 0
 *                       makes every unbudgeted category read as a full
 *                       overspend, so a site that only budgets chemicals shows
 *                       twelve fictional overruns. Render a dash.
 *   actual_amount 0.00  never null — "no purchases" is a known zero, and the
 *                       MTD row on the sheet reads 0 for an untouched column.
 *   variance      NULL  follows budget_amount: with no ceiling there is nothing
 *                       to be under or over.
 *
 * VARIANCE IS BUDGET MINUS ACTUAL (the sheet's `=+E1-E2`): POSITIVE is under
 * budget, NEGATIVE is over. It is named `variance` and not `under_over` so the
 * sign convention has to be read rather than assumed — check it before you
 * colour a cell red.
 *
 * Voided entries are already excluded inside the function; the actuals CTE
 * filters `voided_at IS NULL`.
 *
 * No `limit`, deliberately: this is the aggregate the header row reads, and
 * truncating it would produce totals that silently disagree with the entry list
 * underneath. Cardinality is (sites in scope x categories).
 */
export async function listExpenseMonthRollup(
  client: SupabaseClient,
  { periodMonth, scope, locationId, siteNumber }: ExpenseRollupFilters
): Promise<ExpenseMonthRollupRow[]> {
  const { data, error } = await client.rpc("expense_month_rollup", {
    // Normalised here as well as in the function — see copyExpenseBudgetMonth().
    p_period_month: monthBounds(periodMonth).start,
    p_location_id: locationId ?? null,
    p_site_number: siteNumber ?? null,
    // null = caller sees every site. An empty scope array must fail closed, so
    // scopeCodes() turns it into a sentinel that matches no real code.
    p_location_codes: scopeCodes(scope)
  });
  if (error) throw error;
  return (data ?? []) as unknown as ExpenseMonthRollupRow[];
}
