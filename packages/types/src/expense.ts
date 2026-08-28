// Expense log types — the CPM workbook's "Expense Log" tab, per location, per
// month. Schema: supabase/expense-log-tables.sql. Read that header before
// changing anything here; the non-obvious rules it encodes are all load-bearing
// and several of them are the reason these types look the way they do.
//
// The four that bite hardest:
//
//   PO NUMBERS ARE SERVER-SIDE. `po_number` and `po_seq` exist on the ROW type
//   and deliberately NOT on the INSERT type. The client sends a date, a
//   location and the submitter's initials; the database assembles
//   `{site_number}-YYYYMMDD{initials}{seq}` inside insert_expense_entry() under
//   an advisory lock. A po_number in a request body is ignored, so giving the
//   insert type a slot for one would only invite somebody to try.
//
//   `amount` IS SIGNED. Refunds and credit memos are negative — the workbook
//   has a Refunds column precisely so they net against the month. Do not add a
//   non-negative refinement anywhere in the stack; the database deliberately
//   has no such CHECK. `budget_amount` is the opposite: a ceiling, CHECKed
//   >= 0, because a negative ceiling makes the variance arithmetic meaningless.
//
//   DELETES ARE SOFT. `voided_at`/`voided_by`/`voided_by_email`/`void_reason`.
//   A money log reconciles against paper invoices, so a row that vanishes
//   leaves a hole in the PO sequence with nothing to explain it. Every read
//   filters `voided_at IS NULL`.
//
//   `po_number` IS NOT UNIQUE. A purchase that splits across two categories is
//   two rows sharing one PO (the $400 invoice that was $250 wash chemical and
//   $150 detail chemical). Uniqueness is (location_id, business_date, po_seq).
//   Never key a map or a React list on po_number alone — use `id`.
//
// MONEY IS numeric(12,2) IN POSTGRES and arrives here as a JS `number` through
// PostgREST's JSON. That is fine for display and for the two-decimal values
// this schema stores, but sum in the database (expense_month_rollup) rather
// than in JS wherever a total is compared against a budget.

/* ============================================================
 * Location keying
 * ============================================================ */

/**
 * The three-column location key carried on every expense row. Identical in
 * shape and intent to GreeterLocationKey, and identical for the same reasons:
 *
 * - `location_id` is what the LocationPicker submits.
 * - `site_number` is the stable cross-app join key, and is also the literal
 *   prefix of the PO number, which is why it has to be resolved server-side —
 *   a hand-typed PO could otherwise claim another site's number.
 * - `location_code` exists for the caller-scoping filter only (session.locations
 *   is an array of location_codes). It has been observed to diverge between
 *   tables for the same site, so don't JOIN on it.
 *
 * There is NO foreign key from expense_entry/expense_budget to `locations`.
 * All three values are resolved server-side at write time and the write is
 * HARD-REJECTED when they can't be — see resolveExpenseLocationKey().
 */
export interface ExpenseLocationKey {
  location_id: number;
  site_number: number;
  location_code: string;
}

/* ============================================================
 * expense_categories — the grid's columns, as data
 * ============================================================ */

/**
 * One column of the workbook's Expense Log grid.
 *
 * The sheet's row 5 (merged group heading) and row 6 (label) are `group_label`
 * and `label` here, so the page can render the same two-tier header —
 * "Chemicals" spanning Wash and Detail — without hard-coding the spans.
 *
 * `key` is a TEXT primary key (`repair_equipment`), not a serial. It appears in
 * URL query strings and form field names, and a stable readable key survives a
 * re-seed where an integer id would silently repoint every historical row.
 */
export interface ExpenseCategory {
  /** Matches `^[a-z][a-z0-9_]*$`, enforced by a CHECK. */
  key: string;
  /**
   * The merged row-5 heading. NULL for a standalone column that isn't part of
   * a group (Refunds), which the page renders with no group cell. Null is a
   * real, expected state — do not coalesce it to the label.
   */
  group_label: string | null;
  label: string;
  /**
   * Column order in the grid. Gapped by 10 in the seed so a category can be
   * inserted between two others without renumbering the table. Unique.
   */
  sort_order: number;
  /**
   * Deactivated rather than deleted: a category that stops being used still has
   * years of entries pointing at it. `active: false` drops it from the entry
   * form and from new budgets while leaving history readable, and the month
   * rollup still returns it wherever it carries money.
   */
  active: boolean;
  /**
   * The key this category's money is REPORTED under, or null when it is its own
   * grid column. `maintenance_labor` rolls into `repair_equipment`.
   *
   * The fold happens entirely inside expense_month_rollup(): a child never
   * appears as a column and its spend is already inside its parent's
   * `actual_amount`. The entry LIST is deliberately not folded — each row still
   * shows its own category, because "where did the money go" and "what did we
   * buy" are different questions.
   *
   * One level only, enforced by a CHECK. A chain would silently drop the
   * grandchild's money from the rollup's single join.
   */
  rolls_up_to: string | null;
  /**
   * True when the entry form should ask for HOURS instead of a dollar amount,
   * and drop the payment-method field entirely.
   *
   * This is data rather than `key === "maintenance_labor"` because the form,
   * the worker and insert_expense_entry() all have to agree, and three copies
   * of a hard-coded key is three places to forget. The amount for such an entry
   * is computed IN THE DATABASE from hours times the rate in force — the client
   * never sends the dollar figure, or the admin-set rate would be advisory.
   */
  billed_by_hours: boolean;
  created_at: string;
}

/* ============================================================
 * expense_entry — one row per purchase per category
 * ============================================================ */

/**
 * What the caller supplies to create an entry. Mirrors the arguments of the
 * `insert_expense_entry()` RPC, NOT the columns of the table — the difference
 * is the point.
 *
 * ABSENT ON PURPOSE: `po_number`, `po_seq`, `id`, `created_at`, `updated_at`
 * and the void quad. The first two are allocated by the database under
 * `pg_advisory_xact_lock`; the rest are defaults or a later state transition.
 *
 * `po_initials` is named for the column it lands in even though the RPC
 * parameter is `p_initials`; the db layer does that one-word mapping so callers
 * only ever have to know the column vocabulary.
 */
export interface ExpenseEntryInsert extends ExpenseLocationKey {
  /** YYYY-MM-DD. The purchase date, not the submission time — it is also the
   *  YYYYMMDD embedded in the PO and the day the sequence counts within. */
  business_date: string;
  /**
   * The submitter's initials. 1-4 letters, uppercased by the database on the
   * way in and validated there against `^[A-Z]{1,4}$` — two is the norm, three
   * covers a middle initial, four is the ceiling before this stops being
   * initials. A bad value raises SQLSTATE 22023, not a constraint violation.
   */
  po_initials: string;
  /**
   * How it was paid. Free text on purpose: the workbook's METHOD column has no
   * fixed vocabulary and sites use their own words for the same card. The form
   * offers a datalist of common values rather than a closed enum. Blank is
   * normalised to NULL by the RPC.
   */
  method: string | null;
  /** Blank is normalised to NULL by the RPC. Trigram-indexed for the filter
   *  bar's ILIKE search. */
  description: string | null;
  /** FK to expense_categories.key. Validated by the FK, not re-checked in TS —
   *  a second copy of a rule the database enforces is a second place to drift. */
  category_key: string;
  /**
   * SIGNED. numeric(12,2) in Postgres. Negative is a refund or credit memo and
   * is expected; there is no >= 0 CHECK and there must not be one here either,
   * or a returned pump becomes impossible to record.
   *
   * IGNORED for a `billed_by_hours` category — see `labor_hours`. Pass 0 there;
   * the RPC overwrites it and does not complain.
   */
  amount: number;
  /**
   * Hours billed to the site, for a `billed_by_hours` category only. Null for
   * everything else, and the RPC RAISES if it is set on a category that isn't
   * hourly.
   *
   * THIS IS THE ONLY THING THE CLIENT SENDS ON THAT PATH. The database looks up
   * the rate in force on `business_date`, multiplies, and writes both the
   * amount and the rate it used. If the client sent the dollar figure instead,
   * a stale page or a hand-rolled request could price labor at anything it
   * liked and the admin-set rate would mean nothing.
   *
   * Raises SQLSTATE 22023 when the category is hourly and this is missing, or
   * when no rate has ever been set for that date. "No rate configured" is
   * deliberately an error rather than a $0.00 entry that looks intentional.
   */
  labor_hours: number | null;
  /**
   * Who did the work. Free text, v1, not FK'd — there is no mechanic table yet.
   * Nulled by the RPC on any non-hourly category, so it stays reliable as "who
   * did the work" for anything that reads it.
   *
   * It is also the key expense_labor_rate.mechanic_key will match against if
   * per-mechanic rates ever get turned on; that resolution already works, the
   * UI just never writes a non-null value today.
   */
  mechanic_key: string | null;
  created_by: string;
  created_by_email: string;
}

/**
 * A stored entry, as returned by the insert RPC and by every read.
 *
 * `po_number` / `po_seq` are present here and absent from the insert type
 * because they are the database's answer, not the caller's input — echoing them
 * back is the whole point of server-side assignment: the submitter doesn't know
 * the number until it's saved.
 */
export interface ExpenseEntryRow extends ExpenseEntryInsert {
  id: string;
  /** `{site_number}-YYYYMMDD{initials}{seq}`, e.g. `196-20260820JC1`.
   *  NOT UNIQUE — a split purchase is two rows sharing one PO. */
  po_number: string;
  /** Nth order entered for this location on this date, starting at 1. Unique
   *  per (location_id, business_date). Voided rows still hold their number. */
  po_seq: number;

  /**
   * The rate the row was PRICED AT. Null on any non-hourly entry.
   *
   * Stored rather than looked up at read time so a rate change in November
   * cannot restate August. A CHECK enforces
   * `amount = round(labor_hours * labor_rate, 2)`, so the row can always explain
   * its own dollar figure and the three can never drift apart.
   *
   * RE-RESOLVED ON EDIT, because an edit can move `business_date`. The stamp is
   * "the rate in force on the date this row claims", not "the rate on the day
   * somebody first typed it in" — a row dated the 21st carrying the 20th's rate
   * could not explain itself, and would fail the CHECK above. See
   * update_expense_entry() in supabase/expense-edit-02.sql.
   */
  labor_rate: number | null;

  /**
   * Soft-delete quad. `voided_at` and `voided_by` are both-or-neither, enforced
   * by a CHECK — a void with no actor is unauditable, which defeats the point
   * of not deleting. `void_reason` is free text and may be null even on a
   * voided row.
   *
   * Any read that does not filter these out is a bug: a voided entry still sums
   * into whatever total forgets about it.
   */
  voided_at: string | null;
  voided_by: string | null;
  voided_by_email: string | null;
  void_reason: string | null;

  created_at: string;
  updated_at: string;
  updated_by: string | null;
  updated_by_email: string | null;
}

/**
 * A correction to a posted entry.
 *
 * EVERY FIELD IS SENT, NOT JUST THE CHANGED ONES. This is a whole-row replace,
 * because the form that produces it is the same form that creates an entry and
 * it submits every input it has. A partial-patch shape would need the RPC to
 * distinguish "field omitted" from "field cleared to null", which for `method`
 * and `description` — both legitimately nullable — is a distinction FormData
 * cannot make.
 *
 * `po_number` and `po_seq` are absent for the same reason they are absent from
 * `ExpenseEntryInsert`: the database assigns them. On an edit it also decides
 * whether to REASSIGN them. Moving an entry to a different site or a different
 * date moves it into a different `(location_id, business_date, po_seq)`
 * namespace, so it is allocated a fresh sequence there; changing only the
 * initials rebuilds the printed string and keeps the sequence. Either way the
 * caller finds out what the number became by reading it off the returned row.
 *
 * The location triple is the DESTINATION. The worker checks the caller's scope
 * against both this and the row's current location, so an edit can neither push
 * a row out of the caller's scope nor pull one in.
 */
export interface ExpenseEntryUpdate
  extends Omit<ExpenseEntryInsert, "created_by" | "created_by_email"> {
  id: string;
  /** The editor, from the session. Lands in `updated_by`; `created_by` is never
   *  touched, so the row keeps saying who originally posted it. */
  updated_by: string;
  updated_by_email: string;
}

/* ============================================================
 * expense_budget — the workbook's BUDGET row
 * ============================================================ */

/**
 * One budgeted category for one site for one month. The sheet's row 1 is
 * thirteen cells; here it is up to thirteen rows, and a category with NO row
 * simply has no budget — which is not the same as a budget of zero. See
 * ExpenseMonthRollupRow for how the two are kept apart downstream.
 */
export interface ExpenseBudgetInsert extends ExpenseLocationKey {
  /**
   * YYYY-MM-01. The FIRST OF THE MONTH, enforced by a CHECK
   * (`period_month = date_trunc('month', period_month)`). Storing an arbitrary
   * day in the month would make (location, month, category) non-unique in
   * practice and every lookup a range scan. Callers should normalise before
   * sending rather than relying on the constraint to tell them off.
   */
  period_month: string;
  category_key: string;
  /**
   * numeric(12,2), CHECKed >= 0. Unlike an entry amount this cannot be
   * negative: it is a ceiling, and a negative ceiling makes the variance
   * arithmetic meaningless.
   */
  budget_amount: number;
  /** Free text. copy_expense_budget_month() stamps "Copied from Mon YYYY" here
   *  on rows it creates, which is how a carried-forward budget is identifiable
   *  from one that was actually typed. */
  note: string | null;
  created_by: string;
  created_by_email: string;
}

export interface ExpenseBudgetRow extends ExpenseBudgetInsert {
  id: string;
  created_at: string;
  updated_at: string;
  updated_by: string | null;
  updated_by_email: string | null;
}

/* ============================================================
 * expense_month_rollup() — the workbook's three header rows
 * ============================================================ */

/**
 * One category x one location for one month: the budget, what was spent, and
 * the variance. This is rows 1-3 of the sheet (BUDGET / MTD TOTAL / AMOUNT
 * UNDER (OVER) BUDGET), transposed.
 *
 * THE THREE NULLS ARE DISTINCT AND MUST STAY THAT WAY. This is the single most
 * important thing about this type, and the reason `budget_amount` is not
 * `number`:
 *
 *   budget_amount  NULL   no budget was ever set for this category. NOT a
 *                         budget of zero. Render a dash. Coalescing this to 0
 *                         turns every unbudgeted category into a fictional
 *                         overspend on every site that only budgets chemicals.
 *   actual_amount  0.00   NEVER null. "No purchases" is a known zero, and the
 *                         MTD row on the sheet reads 0 for an untouched column.
 *   variance       NULL   follows budget_amount exactly: with no ceiling there
 *                         is nothing to be under or over.
 *
 * VARIANCE IS BUDGET MINUS ACTUAL, matching the sheet's `=+E1-E2`: POSITIVE is
 * under budget, NEGATIVE is over. The column is named `variance` rather than
 * `under_over` so the sign convention has to be read rather than assumed.
 *
 * Every active category comes back for every location in scope, even with no
 * budget and no spend, because the grid has a column for it either way and a
 * missing row would shift the whole header. Inactive categories appear only
 * where they still carry a budget or an entry.
 *
 * The category metadata (group_label/label/sort_order) is joined in by the
 * function so the page can build the two-tier header from the rollup alone,
 * without a second fetch of expense_categories.
 */
export interface ExpenseMonthRollupRow extends ExpenseLocationKey {
  category_key: string;
  group_label: string | null;
  label: string;
  sort_order: number;
  /** NULL = never budgeted. Do NOT coalesce to 0. */
  budget_amount: number | null;
  /** Never null; 0 means "no purchases", which is a known zero. */
  actual_amount: number;
  /** budget_amount - actual_amount, or NULL when there is no budget. Positive
   *  is under budget. */
  variance: number | null;
  /** Live (non-voided) entries behind `actual_amount`. `bigint` in Postgres,
   *  a JS number here — one site-month-category will never approach 2^53. */
  /**
   * Live (non-voided) entries behind `actual_amount`, INCLUDING any that were
   * folded in from a child category. An Equipment Repair cell reading 4 entries
   * may include maintenance-labor rows that a filter on `repair_equipment`
   * alone will not return — the list is unfolded, the rollup is not.
   */
  entry_count: number;
}

/* ============================================================
 * expense_labor_rate — the admin-set hourly rate
 * ============================================================ */

/**
 * One hourly rate, in force from a date until the next row supersedes it.
 *
 * COMPANY-WIDE IN V1: `mechanic_key` is always null. Josh, 2026-08-21, on
 * whether the rate is per site: "as a whole. not on a per site basis" — and on
 * the column existing anyway: "this is v1 - if this catches on, may set by
 * mechanic and have a rate for each mechanic. may be worth building the table
 * to account for that even if it's not currently utilized". Per-mechanic
 * resolution already works in `expense_labor_rate_for()`; the UI just never
 * writes a non-null key today.
 *
 * NO `effective_to`, and no update path. A window is closed by the NEXT row's
 * `effective_from`, which makes overlaps and gaps unrepresentable rather than
 * merely invalid; and a rate is superseded, never edited, because correcting
 * one in place would restate the price of work already logged against it.
 *
 * Setting one is super_admin only, enforced in the worker.
 */
export interface ExpenseLaborRateRow {
  id: string;
  /** Null IS the company-wide rate — the only kind v1 writes. */
  mechanic_key: string | null;
  /** YYYY-MM-DD, inclusive. */
  effective_from: string;
  /** numeric(10,2), CHECKed strictly positive. Zero is not a rate. */
  rate_per_hour: number;
  note: string | null;
  created_at: string;
  created_by: string;
  created_by_email: string;
}

/** What the caller supplies to set a new rate. The id and created_at are the
 *  database's. */
export interface ExpenseLaborRateInsert {
  mechanic_key: string | null;
  effective_from: string;
  rate_per_hour: number;
  note: string | null;
  created_by: string;
  created_by_email: string;
}

/* ============================================================
 * Filter / parameter shapes
 * ============================================================ */

/**
 * Filters for the entry list. Every field is optional and an omitted field
 * applies no predicate — EXCEPT `location_scope`, where omitted and empty mean
 * opposite things. See scopeCodes() in db-supabase/src/expense.ts.
 *
 * `period_month` and the date range are alternatives, not a pair: the page's
 * month view sends the former, the ad-hoc report sends the latter. When both
 * arrive the explicit range wins, because it is the more specific request.
 *
 * There is deliberately NO `include_voided` flag. Voided rows are audit
 * history, not list content, and an opt-in toggle is exactly the kind of thing
 * that ends up defaulted wrong in one caller and quietly inflates a total.
 * A void-audit view, if it is ever wanted, should be its own function with its
 * own name so the intent is legible at the call site.
 */
export interface ExpenseListFilters {
  /** YYYY-MM-DD, inclusive. */
  date_from?: string | null;
  /** YYYY-MM-DD, inclusive. */
  date_to?: string | null;
  /** Any day in the wanted month; normalised to the whole month by the query.
   *  Ignored when date_from/date_to are supplied. */
  period_month?: string | null;
  location_id?: number | null;
  site_number?: number | null;
  category_key?: string | null;
  /** Exact match, for looking a paper invoice up. May return several rows —
   *  po_number is not unique. */
  po_number?: string | null;
  /** Substring (ILIKE) match on `description`. Sanitised before binding. */
  description?: string | null;
  /** undefined/null = caller sees every site; array = restrict to these codes;
   *  EMPTY array = see nothing (fails closed). */
  location_scope?: string[] | null;
  limit?: number;
}

/*
 * NAMING CONVENTION IN THE BAGS BELOW, because it is not accidental:
 *
 *   snake_case  — payloads and filters whose fields ARE column names
 *                 (ExpenseEntryInsert, ExpenseBudgetInsert, ExpenseListFilters).
 *                 Keeping the column vocabulary means a filter can be handed
 *                 straight to a PostgREST predicate without a rename table,
 *                 and it matches GreeterDayFilters, the module these mirror.
 *   camelCase   — command option-bags that are NOT a row and do not map
 *                 one-to-one onto columns (void, budget listing, month copy).
 *                 These are verbs with arguments, so they read as TS, not SQL.
 */

/** Arguments to listExpenseBudgets(). `periodMonth` is required because a
 *  budget list with no month is every month of every site, which is never what
 *  a caller wants and is not what any view renders. */
export interface ExpenseBudgetFilters {
  /** Any day in the wanted month; normalised to the first of the month, which
   *  is the only value `period_month` is ever allowed to hold. */
  periodMonth: string;
  /** undefined/null = every site; array = these location_codes; EMPTY = none. */
  scope?: string[] | null;
  locationId?: number | null;
  siteNumber?: number | null;
}

/** Arguments to expense_month_rollup(). Month is required for the same reason
 *  the function normalises it: an unbounded rollup is an all-time total behind
 *  a heading that claims to be about one month. */
export interface ExpenseRollupFilters {
  periodMonth: string;
  scope?: string[] | null;
  locationId?: number | null;
  siteNumber?: number | null;
}

/**
 * The soft delete. All four columns move together: `voided_at` is stamped by
 * the db layer, the two actor columns come from the session, and `reason` is
 * optional free text.
 *
 * `voided_by` must be a real uuid — the `expense_entry_void_pair` CHECK rejects
 * a void with no actor, so there is no "system void" path.
 */
export interface ExpenseVoidInput {
  /** expense_entry.id. Void targets a ROW, not a PO: a split purchase is two
   *  rows sharing a PO and voiding one leg must not take the other with it. */
  id: string;
  voidedBy: string;
  voidedByEmail: string;
  reason?: string | null;
}

/** Arguments to copy_expense_budget_month(). Source and target must differ —
 *  the function raises 22023 otherwise rather than silently no-opping. */
export interface ExpenseBudgetCopyInput {
  locationId: number;
  /** Any day in the source month; normalised to the first of it. */
  fromMonth: string;
  /** Any day in the target month; normalised to the first of it. */
  toMonth: string;
  createdBy: string;
  createdByEmail: string;
}

/**
 * Result of a budget carry-forward. `copied` is the number of rows ACTUALLY
 * created, which is not the number of rows in the source month: the copy is
 * ON CONFLICT DO NOTHING, so a category already budgeted in the target month
 * keeps its own number. The UI reports "9 copied, 4 already set" from this
 * rather than claiming success over a no-op.
 */
export interface ExpenseBudgetCopyResult {
  copied: number;
}
