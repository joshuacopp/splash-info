// Expense Log (/admin/expenses).
//
// The database version of the CPM workbook's "Expense Log" tab: every purchase
// a site makes in a month, against the budget somebody set for that month.
//
// This is NOT part of the Greeter Scorecard at /admin/greeters. The two share
// the "pertrack" grant, the same worker and the same transport, and nothing
// else — one logs a greeter's sales day, this one logs money going out.
//
// Sections (top -> bottom):
//   1. Action-error / success banners.
//   2. Filter bar — month, location, category, description search.
//   3. Budget vs actual grid, one per site: BUDGET / MTD ACTUAL / UNDER (OVER).
//   4. The entry form.
//   5. The budget editor (collapsed).
//   6. The entry table, with a per-row void.
//
//
// TALL STORAGE, WIDE RENDER. The sheet is one row per purchase with thirteen
// amount columns, twelve of them blank. The table behind this page is one row
// per purchase with ONE category key and ONE amount. The wide grid the
// operators know is reconstructed here, at read time, from
// expense_month_rollup(). Section 3 is that reconstruction; section 6 is the
// storage shape shown as-is. Both are the same data and neither is the "real"
// one.
//
//
// THE THREE BLANKS. This page's whole job is being careful about which kind of
// nothing it is looking at, and every one of these has been rendered wrong in
// the spreadsheet at some point:
//
//   budget NULL     nobody set a budget. A DASH. Not zero, and specifically not
//                   an overspend — a site that budgets chemicals and nothing
//                   else would otherwise show eleven fictional overruns.
//   actual 0.00     a KNOWN zero. Rendered "$0.00", never a dash.
//   variance NULL   follows the budget: no ceiling, nothing to be under.
//
//   no rollup rows  a site with no budget AND no entries this month produces no
//                   rows at all — expense_month_rollup() is driven from the
//                   sites that have something, not from `locations`. That is
//                   "nothing logged this month", NOT an error and NOT an
//                   access problem.
//
// The rendering of the first three lives in _lib/format.tsx so the decision is
// made once. The fourth is handled below.
//
//
// PO NUMBERS ARE SERVER-ASSIGNED and this page never predicts one. The sequence
// is allocated under an advisory lock at insert time; anything shown before the
// save would be a guess about the field people write on a paper invoice. It is
// echoed back in the success banner instead.
//
// NEVER RENDER "ENTRY N OF M" FROM po_seq. Voids keep their number forever, so
// a month with one void has a permanent gap and the highest seq is not the
// count. `entry_count` off the rollup is the only count on this page.
//
// Auth posture: performanceGetJson collapses 401/403 to null -> no-access card,
// same as the greeter scorecard. A location admin's rows are scoped worker-side.

import Link from "next/link";
import type {
  ExpenseEntryRow,
  ExpenseMonthRollupRow
} from "@splash/types/expense";
import { performanceGetJson } from "../performance/_lib/worker-fetch";
import { LocationPicker } from "../performance/_components/LocationPicker";
import {
  ActualCell,
  BudgetCell,
  VarianceCell,
  currentMonthStart,
  entryDayLabel,
  firstParam,
  localDay,
  monthLabel,
  monthStart,
  shiftMonth,
  signedMoney
} from "./_lib/format";
import {
  BTN_CLS,
  Card,
  EmptyNote,
  HINT_CLS,
  INPUT_CLS,
  LABEL_CLS,
  TBODY_CLS,
  THEAD_CLS,
  TableWrap
} from "./_lib/ui";
import {
  ExpenseEntryForm,
  type CategoryOption
} from "./_components/ExpenseEntryForm";
import { BudgetEditor, type BudgetValue } from "./_components/BudgetEditor";
import {
  copyBudgetMonthAction,
  saveBudgetAction,
  submitExpenseAction,
  voidExpenseAction
} from "./actions";

// Row types come from @splash/types/expense rather than being restated here.
// The greeter page declares its own interfaces inline, but these carry the
// nullability rules above in their doc comments and a local copy would be a
// second place for "budget_amount: number | null" to lose its `| null`.

/** GET /pertrack/api/expenses/budgets. Narrower than ExpenseBudgetRow because
 *  the editor only needs the three fields it renders. */
interface BudgetListRow extends BudgetValue {
  location_id: number;
}

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function ExpensesPage({ searchParams }: PageProps) {
  const sp = await searchParams;

  // MONTH IS ALWAYS RESOLVED, never left empty. The expense log has no
  // all-time view: budgets are monthly and a rollup with no month is an
  // all-time total under a heading claiming to be about one month. An
  // unparseable or absent param falls back to the current month rather than
  // being forwarded to the worker.
  const month = monthStart(firstParam(sp.month)) ?? currentMonthStart();
  const prevMonth = shiftMonth(month, -1);
  const nextMonth = shiftMonth(month, 1);

  const locationIdRaw = firstParam(sp.location_id).trim();
  const locationIdNum =
    locationIdRaw && /^\d+$/.test(locationIdRaw)
      ? Number.parseInt(locationIdRaw, 10)
      : undefined;
  const category = firstParam(sp.category).trim();
  const q = firstParam(sp.q).trim();

  const actionError = firstParam(sp.action_error).trim() || null;
  const successMessage = successCopy(sp);

  // Two query strings, on purpose.
  //
  //   listQs   month + location + category + description search. The entry
  //            table's query.
  //   scopeQs  month + location ONLY. The grid's and the budget editor's.
  //
  // The category and description filters must NOT reach the rollup: narrowing
  // it to one category would leave the other twelve columns absent from the
  // grid (the function returns a row per category per site) and the header
  // would silently reshape itself around whatever was being searched for. The
  // grid is the month's whole picture; the table below it is the filtered view.
  const listParams = new URLSearchParams({ month });
  const scopeParams = new URLSearchParams({ month });
  if (locationIdNum !== undefined) {
    listParams.set("location_id", String(locationIdNum));
    scopeParams.set("location_id", String(locationIdNum));
  }
  if (category) listParams.set("category", category);
  if (q) listParams.set("q", q);

  const listQs = `?${listParams.toString()}`;
  const scopeQs = `?${scopeParams.toString()}`;
  // What every form posts back as `return_qs` so the redirect lands on this
  // exact view. The banner params are stripped by the action.
  const returnQs = listQs;

  let categoriesRes: { categories: CategoryOption[] } | null = null;
  let entriesRes: { entries: ExpenseEntryRow[] } | null = null;
  let rollupRes: { rows: ExpenseMonthRollupRow[] } | null = null;
  let budgetsRes: { budgets: BudgetListRow[] } | null = null;
  let fetchError: string | null = null;

  try {
    // Parallel: four independent reads. Sequential awaits would multiply the
    // page's time-to-first-byte for no benefit.
    [categoriesRes, entriesRes, rollupRes, budgetsRes] = await Promise.all([
      performanceGetJson<{ categories: CategoryOption[] }>(
        "/pertrack/api/expenses/categories"
      ),
      performanceGetJson<{ entries: ExpenseEntryRow[] }>(
        `/pertrack/api/expenses/entries${listQs}`
      ),
      performanceGetJson<{ rows: ExpenseMonthRollupRow[] }>(
        `/pertrack/api/expenses/rollup${scopeQs}`
      ),
      performanceGetJson<{ budgets: BudgetListRow[] }>(
        `/pertrack/api/expenses/budgets${scopeQs}`
      )
    ]);
  } catch (err) {
    fetchError =
      err instanceof Error ? err.message : "Unknown error loading the expense log.";
  }

  const returnPath = `/admin/expenses${listQs}`;

  // The categories endpoint is the auth probe: it takes no filters, so a null
  // from it is an access decision and never an empty result set.
  if (categoriesRes === null && !fetchError) {
    return (
      <section className="mx-auto w-full max-w-[1200px] px-5 py-9">
        <PageBanner />
        <div className="rounded-splash-lg border border-gray-light bg-white p-6 shadow-splash-card">
          <p className="mb-4 text-splash-deny">
            You don&rsquo;t have access to the expense log. Contact your
            administrator if this is unexpected.
          </p>
          <Link
            href={`/login?return=${encodeURIComponent(returnPath)}`}
            className={BTN_CLS}
          >
            Sign In
          </Link>
        </div>
      </section>
    );
  }

  if (fetchError) {
    return (
      <section className="mx-auto w-full max-w-[1200px] px-5 py-9">
        <PageBanner />
        <div className="rounded-splash-lg border border-gray-light bg-white p-6 shadow-splash-card">
          <h2 className="mb-2 text-lg font-bold text-splash-deny">
            Could not load the expense log
          </h2>
          <p className="text-sm text-splash-navy/80">{fetchError}</p>
          <p className="mt-2 text-sm text-splash-navy/60">
            Reload the page to retry.
          </p>
        </div>
      </section>
    );
  }

  const categories = categoriesRes?.categories ?? [];
  const entries = entriesRes?.entries ?? [];
  const rollupRows = rollupRes?.rows ?? [];
  const budgets = budgetsRes?.budgets ?? [];

  const columns = gridColumns(rollupRows);
  const groups = headerGroups(columns);
  const sites = bySite(rollupRows);
  // How many header rows the grid needs. Two whenever anything is grouped (the
  // workbook's merged row 5 over row 6); one when every category is standalone.
  const tiers = groups.some((g) => g.group !== null) ? 2 : 1;

  // Entry rows carry `category_key` only; the grid's headings are the
  // human-readable pair. Built from the category list rather than the rollup so
  // an entry in a category that fell out of scope still renders a name.
  const categoryLabels = new Map<string, string>();
  for (const c of categories) {
    categoryLabels.set(c.key, c.group_label ? `${c.group_label} · ${c.label}` : c.label);
  }

  // Label for the filter's LocationPicker on round-trip, and for the budget
  // editor's copy. Derived from any row that mentions the id; falls back to the
  // raw id when the month has nothing in it for that site.
  let filterLocationLabel: string | undefined;
  if (locationIdNum !== undefined) {
    const match =
      rollupRows.find((r) => r.location_id === locationIdNum) ??
      entries.find((e) => e.location_id === locationIdNum);
    filterLocationLabel = match
      ? `${match.location_code} · ${match.site_number}`
      : `ID ${locationIdNum}`;
  }

  // The entry form defaults to today ONLY when today is inside the month being
  // viewed. Looking at July in August and getting an August date pre-filled is
  // how an entry lands in the wrong month — and the date is also the YYYYMMDD
  // inside the PO, so it is not a cosmetic mistake. Out of month, the field is
  // left blank and required.
  const today = localDay(Date.now());
  const todayIsInMonth = today.slice(0, 7) === month.slice(0, 7);

  return (
    <section className="mx-auto w-full max-w-[1200px] px-5 py-9">
      <ActionAlert message={actionError} />
      {successMessage ? <SuccessBanner message={successMessage} /> : null}
      <PageBanner />

      {/* Filter bar */}
      <form
        method="GET"
        action="/admin/expenses"
        className="mb-5 rounded-splash-lg border border-gray-light bg-white p-5 shadow-splash-card"
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <label className="flex flex-col gap-1">
            <span className={LABEL_CLS}>Month</span>
            {/* type="month" submits "YYYY-MM"; monthStart() normalises it to
                the first of the month, which is the only value the worker and
                the period_month CHECK will accept. */}
            <input
              type="month"
              name="month"
              defaultValue={month.slice(0, 7)}
              className={INPUT_CLS}
            />
          </label>

          <div className="flex flex-col gap-1">
            <span className={LABEL_CLS}>Location</span>
            <LocationPicker
              name="location_id"
              defaultValue={locationIdNum}
              defaultLabel={filterLocationLabel}
              placeholder="Search by site number, name, or code…"
            />
          </div>

          <label className="flex flex-col gap-1">
            <span className={LABEL_CLS}>Category</span>
            <select name="category" defaultValue={category} className={INPUT_CLS}>
              <option value="">All categories</option>
              {categories.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.group_label ? `${c.group_label} · ${c.label}` : c.label}
                </option>
              ))}
            </select>
            {/* Said out loud because the grid does not move when this changes,
                and a filter that appears to do nothing gets pressed twice. */}
            <span className={HINT_CLS}>Filters the entry table only.</span>
          </label>

          <label className="flex flex-col gap-1">
            <span className={LABEL_CLS}>Description</span>
            <input
              type="text"
              name="q"
              defaultValue={q}
              placeholder="Contains…"
              className={INPUT_CLS}
            />
          </label>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button type="submit" className={BTN_CLS}>
            Apply filters
          </button>
          {/* Month stepping keeps the location and the search; only the period
              moves. Rebuilt from the current params rather than being a bare
              href so paging back does not silently widen the view. */}
          <Link
            href={withMonth(listParams, prevMonth)}
            className="text-sm font-semibold text-splash-blue hover:text-splash-blue-dark"
          >
            ← {monthLabel(prevMonth)}
          </Link>
          <Link
            href={withMonth(listParams, nextMonth)}
            className="text-sm font-semibold text-splash-blue hover:text-splash-blue-dark"
          >
            {monthLabel(nextMonth)} →
          </Link>
          <Link
            href="/admin/expenses"
            className="text-sm font-semibold text-splash-blue hover:text-splash-blue-dark"
          >
            Reset
          </Link>
        </div>
      </form>

      {/* ------------------------------------------------------------------
          Budget vs actual — the workbook's rows 1-3, one grid per site.
          ------------------------------------------------------------------ */}
      {sites.length === 0 ? (
        <Card
          title={`Budget vs actual — ${monthLabel(month)}`}
          subtitle="The workbook's BUDGET / MTD TOTAL / UNDER (OVER) rows."
        >
          {/* NOT an error and NOT an empty-permissions state. The rollup is
              driven from the sites that have a budget or an entry this month,
              so nothing back means nothing has happened yet. */}
          <EmptyNote>
            Nothing logged for {monthLabel(month)}
            {locationIdNum !== undefined ? " at this location" : ""}. Once an
            expense is entered or a budget is set, the grid appears here.
          </EmptyNote>
        </Card>
      ) : (
        sites.map((site) => (
          <Card
            key={site.location_id}
            title={`${site.location_code} · ${site.site_number} — ${monthLabel(month)}`}
            subtitle="Budget is what was set for the month. Actual is month-to-date, excluding voided entries. Positive variance is under budget."
          >
            <TableWrap>
              <thead className={THEAD_CLS}>
                {/*
                  TWO-TIER HEADER, from the data. `group_label` spans its run of
                  columns exactly as the workbook's merged row 5 does, and a
                  category with no group (Refunds) spans both header rows
                  instead. Nothing about the spans is hard-coded, so adding a
                  category is a row in expense_categories and not a change here.

                  Runs are CONSECUTIVE-ONLY: the columns arrive in sort_order,
                  which is the workbook's left-to-right order, and bucketing by
                  label instead would quietly reorder the grid the first time
                  somebody inserts a category between two groups.
                */}
                <tr>
                  {/* The spanning cells collapse to one row when NOTHING is
                      grouped (every category standalone, or a single ungrouped
                      one left after a re-seed). rowSpan={2} over a second row
                      that isn't rendered would leave a phantom band under the
                      header. */}
                  <th className="px-4 py-3" rowSpan={tiers}>
                    &nbsp;
                  </th>
                  {groups.map((g, i) =>
                    g.group === null ? (
                      <th
                        key={`solo-${g.columns[0].key}`}
                        className="whitespace-nowrap px-4 py-3 text-right"
                        rowSpan={tiers}
                      >
                        {g.columns[0].label}
                      </th>
                    ) : (
                      <th
                        key={`grp-${g.group}-${i}`}
                        className="whitespace-nowrap border-l border-gray-light px-4 py-2 text-center"
                        colSpan={g.columns.length}
                      >
                        {g.group}
                      </th>
                    )
                  )}
                </tr>
                {tiers === 2 ? (
                  <tr>
                    {groups.flatMap((g) =>
                      g.group === null
                        ? // Already spanned from the row above.
                          []
                        : g.columns.map((c) => (
                            <th
                              key={c.key}
                              className="whitespace-nowrap px-4 py-2 text-right font-normal normal-case tracking-normal"
                            >
                              {c.label}
                            </th>
                          ))
                    )}
                  </tr>
                ) : null}
              </thead>
              <tbody className={TBODY_CLS}>
                <tr>
                  <th className="whitespace-nowrap px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-splash-navy/70">
                    Budget
                  </th>
                  {columns.map((c) => (
                    <td key={c.key} className="px-4 py-3 text-right">
                      <BudgetCell
                        amount={site.cells.get(c.key)?.budget_amount ?? null}
                      />
                    </td>
                  ))}
                </tr>
                <tr>
                  <th className="whitespace-nowrap px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-splash-navy/70">
                    Actual (MTD)
                  </th>
                  {columns.map((c) => {
                    const cell = site.cells.get(c.key);
                    return (
                      <td key={c.key} className="px-4 py-3 text-right">
                        {/* A category absent from this site's rollup rows has
                            no row at all, which is different from a zero: it
                            only happens for an inactive category another site
                            still carries money in. Blank, not $0.00. */}
                        {cell ? (
                          <ActualCell
                            amount={cell.actual_amount}
                            entryCount={cell.entry_count}
                          />
                        ) : (
                          <span className="text-splash-navy/40">—</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
                <tr>
                  <th className="whitespace-nowrap px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-splash-navy/70">
                    Under (Over)
                  </th>
                  {columns.map((c) => (
                    <td key={c.key} className="px-4 py-3 text-right">
                      <VarianceCell
                        variance={site.cells.get(c.key)?.variance ?? null}
                      />
                    </td>
                  ))}
                </tr>
              </tbody>
            </TableWrap>
            {/*
              NO TOTAL COLUMN, deliberately.

              A row total would have to be summed in JavaScript across cells
              that Postgres summed in `numeric`, and then compared against a
              budget total summed the same way. Every other figure on this grid
              comes out of expense_month_rollup(); a JS total would be the one
              number on the page no database ever produced, and the first one to
              disagree with the accounting system. Add it to the rollup function
              if it is wanted.
            */}
            <p className="border-t border-gray-light px-5 py-3 text-[11px] text-splash-navy/60">
              A dash in the Budget row means no budget was ever set for that
              category — it is not a budget of zero, and there is no variance to
              report against it.
            </p>
          </Card>
        ))
      )}

      {/* Entry form */}
      <Card
        title="Log an expense"
        subtitle="One purchase, one category, one amount. The PO number is assigned when you save."
      >
        <ExpenseEntryForm
          action={submitExpenseAction}
          categories={categories}
          returnQs={returnQs}
          defaultDate={todayIsInMonth ? today : ""}
          defaultLocationId={locationIdNum}
          defaultLocationLabel={filterLocationLabel}
          dateNote={
            todayIsInMonth
              ? undefined
              : `You are viewing ${monthLabel(month)}, which isn't the current month — pick the date deliberately.`
          }
        />
      </Card>

      {/*
        Budget editor, COLLAPSED BY DEFAULT.

        <details> rather than a modal or a tab: setting budgets is a
        once-a-month job and the grid above is the daily one, but the editor
        still has to be one click away from the row it edits. Native disclosure
        costs no client JavaScript and keeps the forms inside server-rendered
        markup.
      */}
      <details className="mb-6 overflow-hidden rounded-splash-lg border border-gray-light bg-white shadow-splash-card">
        <summary className="cursor-pointer border-b border-gray-light px-5 py-4 text-lg font-bold text-splash-navy">
          Set budgets for {monthLabel(month)}
        </summary>
        <BudgetEditor
          saveAction={saveBudgetAction}
          copyAction={copyBudgetMonthAction}
          categories={categories}
          budgets={budgets}
          month={month}
          prevMonth={prevMonth}
          locationId={locationIdNum}
          locationLabel={filterLocationLabel}
          returnQs={returnQs}
        />
      </details>

      {/* ------------------------------------------------------------------
          Entries — the storage shape, shown as-is.
          ------------------------------------------------------------------ */}
      <Card
        title="Entries"
        subtitle="Voided entries are hidden and are not in the totals above. Voiding never reissues a PO number, so gaps in the sequence are expected."
      >
        {entries.length === 0 ? (
          <EmptyNote>
            No entries for {monthLabel(month)} with these filters.
          </EmptyNote>
        ) : (
          <TableWrap>
            <thead className={THEAD_CLS}>
              <tr>
                <th className="px-4 py-3">Date</th>
                <th className="px-4 py-3">PO number</th>
                <th className="px-4 py-3">Site</th>
                <th className="px-4 py-3">Method</th>
                <th className="px-4 py-3">Description</th>
                <th className="px-4 py-3">Category</th>
                <th className="px-4 py-3 text-right">Amount</th>
                <th className="px-4 py-3">Void</th>
              </tr>
            </thead>
            <tbody className={TBODY_CLS}>
              {/* Keyed on `id`, NEVER on po_number: a purchase split across two
                  categories is two rows sharing one PO. */}
              {entries.map((e) => (
                <tr key={e.id}>
                  <td className="whitespace-nowrap px-4 py-3 text-splash-navy/80">
                    {entryDayLabel(e.business_date)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 font-mono text-xs">
                    {e.po_number}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-splash-navy/80">
                    {e.location_code}
                    <div className="font-mono text-xs text-splash-navy/60">
                      {e.site_number}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-splash-navy/80">
                    {e.method || "—"}
                  </td>
                  <td className="px-4 py-3 text-splash-navy/80">
                    {e.description || "—"}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-splash-navy/80">
                    {categoryLabels.get(e.category_key) ?? e.category_key}
                  </td>
                  {/* Negative is a refund or credit, not an error. Tinted and
                      titled so it reads as deliberate. */}
                  <td
                    className={`whitespace-nowrap px-4 py-3 text-right font-semibold ${
                      e.amount < 0 ? "text-splash-success" : ""
                    }`}
                    title={e.amount < 0 ? "Refund or credit — nets against the month." : undefined}
                  >
                    {signedMoney(e.amount)}
                  </td>
                  <td className="px-4 py-3">
                    <VoidCell id={e.id} po={e.po_number} returnQs={returnQs} />
                  </td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Card>
    </section>
  );
}

/* ============================================================
 * Pivot: rollup rows -> the wide grid
 * ============================================================ */

interface GridColumn {
  key: string;
  group_label: string | null;
  label: string;
  sort_order: number;
}

/**
 * The grid's columns, unioned across EVERY site in the result.
 *
 * Per-site columns would be the obvious thing and would be wrong: the rollup
 * returns inactive categories only where that site still carries money in them,
 * so two sites in the same month can come back with different column sets. Two
 * grids on one page with silently different headers is the kind of thing people
 * read across horizontally without noticing. Unioned, every grid has the same
 * columns in the same order and a site with no row for one of them renders a
 * blank cell (handled at the call site).
 */
function gridColumns(rows: ExpenseMonthRollupRow[]): GridColumn[] {
  const byKey = new Map<string, GridColumn>();
  for (const r of rows) {
    if (byKey.has(r.category_key)) continue;
    byKey.set(r.category_key, {
      key: r.category_key,
      group_label: r.group_label,
      label: r.label,
      sort_order: r.sort_order
    });
  }
  // sort_order is unique in the table, so the key tiebreak is belt and braces
  // against a bad seed rather than a real case.
  return [...byKey.values()].sort(
    (a, b) => a.sort_order - b.sort_order || a.key.localeCompare(b.key)
  );
}

/**
 * A run of grid columns sharing one merged heading.
 *
 * Modelled as a union rather than `{ group: string | null; columns: [] }` so
 * that the ungrouped case carries a ONE-ELEMENT TUPLE. The header markup reads
 * `g.columns[0]` for an ungrouped run, and under `noUncheckedIndexedAccess` an
 * array index is `T | undefined` while a tuple index is not — the union is what
 * lets that read be safe without a non-null assertion. It also states the
 * invariant the builder below actually maintains: a null group is always
 * exactly one column, never more.
 */
type HeaderGroup =
  | { group: null; columns: [GridColumn] }
  | { group: string; columns: GridColumn[] };

/**
 * Columns folded into the workbook's merged row-5 headings.
 *
 * Consecutive runs only — see the comment on the header markup. A null
 * group_label always starts its own single-column run and never merges with an
 * adjacent null, because two ungrouped categories side by side are two separate
 * columns, not one group called "nothing".
 */
function headerGroups(columns: GridColumn[]): HeaderGroup[] {
  const out: HeaderGroup[] = [];
  for (const c of columns) {
    const last = out[out.length - 1];
    if (last && last.group !== null && last.group === c.group_label) {
      last.columns.push(c);
    } else if (c.group_label === null) {
      out.push({ group: null, columns: [c] });
    } else {
      out.push({ group: c.group_label, columns: [c] });
    }
  }
  return out;
}

interface SiteGrid {
  location_id: number;
  site_number: number;
  location_code: string;
  /** category_key -> that site's row. Absent means the rollup returned no row
   *  for this site/category pair, which is not the same as a zero. */
  cells: Map<string, ExpenseMonthRollupRow>;
}

/**
 * One grid per site.
 *
 * The page renders every site the rollup returns rather than requiring a
 * location filter: the function already restricts itself to sites with a budget
 * or an entry this month AND to the caller's scope, so "all sites" is a short
 * list of the ones actually in use, not forty empty grids. Keyed on
 * location_id, not location_code — the code has been observed to diverge
 * between tables for the same site.
 */
function bySite(rows: ExpenseMonthRollupRow[]): SiteGrid[] {
  const map = new Map<number, SiteGrid>();
  for (const r of rows) {
    let site = map.get(r.location_id);
    if (!site) {
      site = {
        location_id: r.location_id,
        site_number: r.site_number,
        location_code: r.location_code,
        cells: new Map()
      };
      map.set(r.location_id, site);
    }
    site.cells.set(r.category_key, r);
  }
  return [...map.values()].sort((a, b) =>
    a.location_code.localeCompare(b.location_code)
  );
}

/** The current filter params with the month swapped. */
function withMonth(params: URLSearchParams, month: string): string {
  const next = new URLSearchParams(params);
  next.set("month", month);
  return `/admin/expenses?${next.toString()}`;
}

/* ============================================================
 * Small presentational pieces
 * ============================================================ */

/**
 * The void control.
 *
 * A <details> and not a confirm() dialog or a modal: the reason is REQUIRED, so
 * there has to be a text field either way, and a native disclosure gives one
 * without a line of client JavaScript. It is also two deliberate interactions
 * (open, then type, then submit), which is about right for an action that
 * cannot be undone.
 *
 * The copy names the consequence people get wrong — the PO number is not
 * reissued and the gap it leaves is permanent — because that is the difference
 * between this and a delete.
 */
function VoidCell({
  id,
  po,
  returnQs
}: {
  id: string;
  po: string;
  returnQs: string;
}) {
  return (
    <details>
      <summary className="cursor-pointer whitespace-nowrap text-xs font-semibold text-splash-deny hover:underline">
        Void
      </summary>
      <form
        action={voidExpenseAction}
        className="mt-2 flex w-56 flex-col gap-2 rounded-splash-sm border border-splash-deny/40 bg-splash-deny/5 p-3"
      >
        <input type="hidden" name="return_qs" value={returnQs} />
        <input type="hidden" name="id" value={id} />
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold text-splash-deny">
            Reason (required)
          </span>
          <input
            type="text"
            name="reason"
            required
            placeholder="Duplicate of 196-…"
            className="rounded-splash-sm border border-gray-light bg-white px-2 py-1.5 text-xs text-splash-navy focus:border-splash-blue focus:outline-none"
          />
        </label>
        <p className="text-[11px] leading-snug text-splash-navy/70">
          {po} stays on the record and is never reissued. The entry drops out of
          the totals above.
        </p>
        <button
          type="submit"
          className="rounded-splash-sm bg-splash-deny px-3 py-1.5 text-xs font-bold text-white transition-opacity hover:opacity-90"
        >
          Void this entry
        </button>
      </form>
    </details>
  );
}

/**
 * Success copy.
 *
 * Assembled from the query rather than a lookup table because two of the four
 * outcomes carry a detail the user cannot get anywhere else: the PO number the
 * database just assigned, and how many budget rows the copy ACTUALLY created
 * (which is not how many were in the source month — the copy never overwrites).
 */
function successCopy(
  sp: Record<string, string | string[] | undefined>
): string | null {
  const key = firstParam(sp.success).trim();
  if (!key) return null;

  if (key === "entry") {
    const po = firstParam(sp.po).trim();
    return po
      ? `Expense saved. PO number ${po} — write this on the invoice.`
      : "Expense saved.";
  }
  if (key === "void") {
    return "Entry voided. It is out of the totals; the PO number stays on the record.";
  }
  if (key === "budget") {
    // `corrected` means the category ALREADY had a budget for this month and
    // the amount was replaced — not that anything about the request was
    // normalised. Worth saying, because an update overwrites a number somebody
    // else may have set.
    return firstParam(sp.corrected).trim()
      ? "Budget updated. This category already had a budget for the month and the amount was replaced."
      : "Budget saved.";
  }
  if (key === "copy") {
    const created = firstParam(sp.created).trim();
    if (created === "0") {
      return "Nothing copied — every category already had a budget this month, and the copy never overwrites.";
    }
    return created
      ? `${created} budget${created === "1" ? "" : "s"} copied. Categories already budgeted this month were left alone.`
      : "Budget copied.";
  }
  return null;
}

function ActionAlert({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div
      role="alert"
      className="mb-5 flex flex-col gap-2 rounded-splash-md border border-splash-deny/40 bg-splash-deny/10 p-4 text-sm text-splash-deny sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex-1 whitespace-pre-line">
        <span className="font-bold">Action failed: </span>
        {message}
      </div>
      <Link
        href="/admin/expenses"
        className="text-xs font-semibold underline underline-offset-2 hover:text-splash-deny/80"
      >
        Dismiss
      </Link>
    </div>
  );
}

function SuccessBanner({ message }: { message: string }) {
  return (
    <div
      role="status"
      className="mb-5 flex flex-col gap-2 rounded-splash-md border border-splash-success/40 bg-splash-success/10 p-4 text-sm text-splash-success sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex-1">
        <span className="font-bold">{message}</span>
      </div>
      <Link
        href="/admin/expenses"
        className="text-xs font-semibold underline underline-offset-2 hover:text-splash-success/80"
      >
        Dismiss
      </Link>
    </div>
  );
}

function PageBanner() {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-sudsy-blue">
          Internal Tools
        </p>
        <h1 className="text-2xl font-bold text-splash-navy">Expense Log</h1>
      </div>
    </div>
  );
}
