// Cell formatting and month arithmetic for /admin/expenses.
//
// WHAT IS BORROWED AND WHAT IS NOT:
//
// `localDay` and `firstParam` are RE-EXPORTED from the greeter scorecard's
// format module rather than reimplemented. Both encode a decision that has to
// hold site-wide and not per-page: a business date is computed in
// America/New_York and never via toISOString() (which rolls over at 8pm Eastern
// and would put an evening entry in tomorrow), and a searchParams entry is
// unwrapped the same way on every admin page.
//
// `money` is deliberately NOT reused. It renders "$1,234.56" and a bare minus
// for negatives, which is right for sales figures and wrong for both of the
// money columns here — see accounting() and signedMoney() below, which differ
// from it and from each other on purpose.
//
// Everything else here is expense-specific and would be noise in the greeter
// module: months (the expense log's unit of time — the greeter page works in
// arbitrary date ranges and has no concept of a period) and the accounting
// conventions of the workbook's three header rows.
//
// THE NULL RULE ON THIS PAGE IS SHARPER THAN "NULL IS UNKNOWN". There are three
// distinct blanks in the rollup and conflating any two of them produces a
// number that is wrong rather than merely missing:
//
//   budget_amount NULL   nobody ever set a budget for this category. NOT zero.
//                        Coalescing it to 0 turns every unbudgeted column into
//                        a 100% overspend, which on a site that only budgets
//                        chemicals is eleven fictional overruns.
//   actual_amount 0.00   never null. "No purchases" is a KNOWN zero and the
//                        workbook's MTD row reads 0 for an untouched column, so
//                        this renders "$0.00" and not a dash.
//   variance      NULL   follows budget_amount exactly: with no ceiling there
//                        is nothing to be under or over.
//
// The components at the bottom exist so those three rules live in one place and
// each carries the tooltip that explains itself to the reader.

export { firstParam, localDay } from "../../greeters/_lib/format";

import { localDay } from "../../greeters/_lib/format";

/* ============================================================
 * Months
 * ============================================================ */

/**
 * Normalise anything month-shaped to the first of that month, "YYYY-MM-01".
 *
 * Accepts "YYYY-MM" (what <input type="month"> submits) and "YYYY-MM-DD" (what
 * the URL carries and what the worker wants). Returns null for anything else,
 * so a hand-edited query string falls back to the current month instead of
 * being forwarded to the worker as a 400.
 *
 * STRING MATH, NOT Date. `new Date("2026-08-01")` is parsed as UTC midnight,
 * which is 8pm on July 31st in site local time — every month boundary would be
 * off by one for anybody looking after dinner. There is nothing to parse here
 * that four characters and two characters can't answer directly.
 */
export function monthStart(raw: string): string | null {
  const m = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(raw.trim());
  if (!m) return null;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return `${m[1]}-${m[2]}-01`;
}

/** The month containing today, in SITE local time. See localDay for why. */
export function currentMonthStart(): string {
  return `${localDay(Date.now()).slice(0, 7)}-01`;
}

/**
 * Move a "YYYY-MM-01" by whole months. delta -1 is last month, +1 next.
 *
 * Integer arithmetic on the year/month pair for the same reason monthStart
 * avoids Date: adding "30 days" to a date is not adding a month, and doing it
 * through a Date object drags the timezone back in.
 */
export function shiftMonth(monthIso: string, delta: number): string {
  const year = Number(monthIso.slice(0, 4));
  const month = Number(monthIso.slice(5, 7));
  // Zero-based month index makes the carry a single modulo instead of four
  // special cases around December.
  const idx = year * 12 + (month - 1) + delta;
  const y = Math.floor(idx / 12);
  const m = idx - y * 12 + 1;
  return `${y}-${String(m).padStart(2, "0")}-01`;
}

/** "2026-08-01" -> "August 2026". Parsed at UTC noon so the label can't slip. */
export function monthLabel(monthIso: string): string {
  const d = new Date(`${monthIso.slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return monthIso;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "long",
    year: "numeric"
  }).format(d);
}

/** "2026-08-20" -> "Aug 20". The grid's entry table is already inside a month
 *  heading, so repeating the year on forty rows is noise. */
export function entryDayLabel(iso: string): string {
  const d = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric"
  }).format(d);
}

/* ============================================================
 * Money, with the workbook's sign conventions
 * ============================================================ */

/** Absolute dollars, always two places. Callers own the sign presentation. */
function abs2(value: number): string {
  return Math.abs(value).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

/**
 * Accounting format: a negative is parenthesised, not minus-signed.
 *
 * This is the workbook's convention for the "AMOUNT UNDER (OVER) BUDGET" row
 * and the reason that row is titled the way it is — the parentheses ARE the
 * "(OVER)". A minus sign in a column of dollar figures is easy to miss at a
 * glance and easy to lose entirely in a printout.
 */
export function accounting(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return value < 0 ? `($${abs2(value)})` : `$${abs2(value)}`;
}

/**
 * A signed entry amount, minus sign in front of the dollar sign.
 *
 * NOT the accounting format above, on purpose. On the entry table a negative
 * amount is a refund or credit memo the user deliberately typed, and "-$150.00"
 * says that plainly; "($150.00)" is a variance convention and reading it as one
 * on a purchase row would be a genuine misread. The two formats sit on the same
 * page precisely because they mean different things.
 */
export function signedMoney(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return value < 0 ? `-$${abs2(value)}` : `$${abs2(value)}`;
}

/* ============================================================
 * The three grid rows, as cells
 * ============================================================ */

/**
 * The BUDGET row. NULL is a dash, and the dash is titled — a reader who sees a
 * blank where they expected a number needs to know whether the budget is zero
 * or absent, and those two states are one pixel apart otherwise.
 */
export function BudgetCell({ amount }: { amount: number | null }) {
  if (amount === null) {
    return (
      <span
        className="text-splash-navy/40"
        title="No budget has been set for this category this month. This is not a budget of zero — nothing is being compared, so there is no variance below."
      >
        —
      </span>
    );
  }
  return <span className="text-splash-navy/80">{accounting(amount)}</span>;
}

/**
 * The MTD TOTAL row. Never a dash: `actual_amount` is never null, and $0.00 is
 * the honest rendering of a category nobody bought anything in this month.
 *
 * A negative total is possible and is not an error — a month whose only entry
 * in a column was a refund nets below zero. It is tinted so it can't be read as
 * spend at a glance.
 */
export function ActualCell({
  amount,
  entryCount
}: {
  amount: number;
  entryCount: number;
}) {
  const label = `${entryCount} ${entryCount === 1 ? "entry" : "entries"}`;
  return (
    <span
      className={`font-semibold ${amount < 0 ? "text-splash-success" : "text-splash-navy"}`}
      title={
        entryCount === 0
          ? "No entries logged in this category this month."
          : `${label} this month. Voided entries are excluded.`
      }
    >
      {signedMoney(amount)}
    </span>
  );
}

/**
 * The UNDER/(OVER) row. Variance is BUDGET MINUS ACTUAL, so POSITIVE IS UNDER
 * BUDGET — the sign convention is the opposite way round from most variance
 * columns and is the single easiest thing on this page to get backwards.
 *
 * Null passes straight through to a dash rather than being computed from the
 * actual: a category with no ceiling is not "over by everything you spent".
 */
export function VarianceCell({ variance }: { variance: number | null }) {
  if (variance === null) {
    return (
      <span
        className="text-splash-navy/40"
        title="No budget set, so there is nothing to be under or over."
      >
        —
      </span>
    );
  }
  const over = variance < 0;
  return (
    <span
      className={`font-bold ${over ? "text-splash-deny" : "text-splash-success"}`}
      title={
        over
          ? `Over budget by $${abs2(variance)}.`
          : `Under budget by $${abs2(variance)}.`
      }
    >
      {accounting(variance)}
    </span>
  );
}
