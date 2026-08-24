// Labor budget -> per-day / per-week spending allowance for the scheduler.
//
// The grid already prices what a week COSTS (hours x rate, plus a flat weekly
// baseline for salaried staff). This module supplies the other half: what the
// week is ALLOWED to cost, so a manager can see an overage while the schedule
// is still editable instead of at month end.
//
// WHERE THE NUMBER COMES FROM. `site_monthly_targets.labor_budget` — a flat
// dollar figure for one site for one whole calendar month, defined in
// supabase/greeter-labor-revenue-14.sql. It is the same figure the greeter
// performance report grades `location_daily.labor_trend` against, and reusing
// it rather than inventing a scheduler-specific budget is deliberate: two
// numbers both called "the labor budget" that disagree is worse than no number
// at all.
//
// PRORATION IS EVEN BY CALENDAR DAY. allowance(day) = labor_budget / days in
// that day's month. Chosen over weighting weekends heavier because the weights
// would be guesswork until there is per-weekday volume data, and over dividing
// by "open days" because nothing in the schema records which days a site is
// closed. A 31-day month is therefore automatically a little stricter per day
// than a 28-day one, which is the correct direction.
//
// NOTE THIS IS A NEW RULE, NOT A PORTED ONE. performance-worker never divides
// the monthly budget by anything — it compares a projected month-end labor
// figure against the whole month, and the report explicitly refuses to sum
// budgets across days (seven days of a $24,000 budget is $24,000, not
// $168,000). So there was no existing proration to match, and nothing
// downstream can contradict this one.
//
// A WEEK THAT STRADDLES TWO MONTHS is summed day by day, each day drawing on
// its own month's budget. Mon Aug 31 uses August's daily rate and Tue Sep 1
// uses September's. If one of those months was never configured, its days
// contribute nothing and `unbudgetedDays` says how many — the week total is a
// floor, never a silent understatement of the allowance.

import { getMonthlyTargetSnapshot, type SupabaseClient } from "@splash/db-supabase";

/* ============================================================
 * Calendar helpers (pure string math, no Date-in-local-tz traps)
 * ============================================================ */

/** First of the month for a "YYYY-MM-DD" ET date: "2026-08-24" -> "2026-08-01".
 *  String slicing, not Date arithmetic — the input is already a calendar date
 *  in ET and round-tripping it through a Date is how a day gets lost. */
export function monthStartOf(dateStr: string): string {
  return `${dateStr.slice(0, 7)}-01`;
}

/** Number of days in the month containing a "YYYY-MM-DD" date.
 *  Day 0 of month m+1 is the last day of month m, and Date.UTC takes a 0-based
 *  month, so passing the 1-based month straight through lands on the right
 *  rollover. Leap years fall out of this for free. */
export function daysInMonth(dateStr: string): number {
  const [y, m] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y!, m!, 0)).getUTCDate();
}

/* ============================================================
 * location_code -> site_number
 * ============================================================ */

/**
 * Resolve the Splash `location_code` the scheduler speaks to the `site_number`
 * the budget table is keyed by.
 *
 * WHY THIS HOP EXISTS. `site_monthly_targets` carries BOTH `site_number` and
 * `location_code`, and querying it by the latter would skip this entirely. It
 * deliberately does not: the unique index is on `(site_number, month)` and the
 * DDL comments call `location_code` a scoping/display copy. A site whose code
 * is ever re-lettered would leave old target rows stamped with the old string,
 * and a budget lookup that silently returned nothing is exactly the kind of
 * failure that reads as "$0 budgeted" instead of as an error.
 *
 * `pricing_simple` is the only table that carries both keys. Its `site` column
 * is `site_number` denormalised as TEXT by a trigger, and the padding is NOT
 * consistent across rows — "147" and "0147" both occur. parseInt handles that
 * asymmetry in the direction we need (both parse to 147); the greeter code
 * going the other way has to probe three padded candidates instead.
 *
 * Its primary key is composite `(location_code, pkg)`, so a location has one
 * row per package and any of them answers this question. Returns null when the
 * code is unknown, which callers must render as "no budget configured" rather
 * than as a zero allowance.
 */
export async function resolveSiteNumber(
  sb: SupabaseClient,
  locationCode: string
): Promise<number | null> {
  const { data, error } = await sb
    .from("pricing_simple")
    .select("site")
    .eq("location_code", locationCode)
    .limit(1);
  if (error) throw error;

  const raw = ((data ?? [])[0] as { site?: unknown } | undefined)?.site;
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Number.parseInt(String(raw), 10);
  return Number.isFinite(n) ? n : null;
}

/* ============================================================
 * Week allowance
 * ============================================================ */

/** One day's slice of its month's labor budget. */
export interface DayAllowance {
  /** ET calendar date, "YYYY-MM-DD" — matches ShiftView.startDate so the grid
   *  can key off it directly. */
  date: string;
  /** First of this day's month, "YYYY-MM-01". */
  month: string;
  /**
   * Dollars this day may spend on labor, or null when the month has no budget
   * configured. NEVER 0 for an unconfigured month: zero is a real and different
   * claim ("this site is allowed no labor"), and a grid that treated the two
   * alike would paint every unbudgeted day as catastrophically over.
   */
  allowance: number | null;
}

/** One month touched by the visible week, kept alongside the days so the UI can
 *  explain a null allowance instead of just omitting it. */
export interface MonthBudget {
  /** "YYYY-MM-01". */
  month: string;
  /** Whole-month labor budget in dollars, null when never configured. */
  laborBudget: number | null;
  /** Divisor used for this month's daily allowance. */
  daysInMonth: number;
}

export interface WeekBudget {
  /** Resolved site key, null when the location_code has no pricing_simple row.
   *  A null here makes every day's allowance null too. */
  siteNumber: number | null;
  /** Seven entries, Monday-first, in calendar order. */
  days: DayAllowance[];
  /**
   * Sum of the non-null day allowances, or null when not one day in the week
   * has a budget. A PARTIAL week returns a number, not null — the operator
   * asked for the straddle to be summed day by day, so a week with only August
   * configured reports August's share and flags the rest via `unbudgetedDays`.
   */
  weekAllowance: number | null;
  /** How many of the seven days fell in a month with no budget set. Non-zero
   *  means `weekAllowance` is a floor and must be labelled as incomplete. */
  unbudgetedDays: number;
  /** The one or two months the week touches. */
  months: MonthBudget[];
}

/**
 * Build the allowance for a run of ET calendar dates (the grid passes its seven
 * Monday-anchored days).
 *
 * One RPC per DISTINCT MONTH, not per day — a week touches at most two, so this
 * is one or two round trips regardless of how many dates are passed. The RPC
 * (`site_monthly_target_for`) takes any business date and resolves it to that
 * date's month itself, which is why the month-start string can be handed
 * straight to it.
 *
 * Throws only on a genuine database error. An unresolvable location or an
 * unconfigured month are both normal states and come back as nulls.
 */
export async function buildWeekBudget(
  sb: SupabaseClient,
  locationCode: string,
  dates: string[]
): Promise<WeekBudget> {
  const siteNumber = await resolveSiteNumber(sb, locationCode);
  const monthKeys = [...new Set(dates.map(monthStartOf))].sort();

  const months: MonthBudget[] = [];
  const budgetByMonth = new Map<string, number | null>();

  for (const month of monthKeys) {
    // A site we could not resolve gets nulls rather than a skipped lookup, so
    // the shape of the response does not depend on why the budget is missing.
    const laborBudget =
      siteNumber === null
        ? null
        : (await getMonthlyTargetSnapshot(sb, siteNumber, month)).labor_budget;
    budgetByMonth.set(month, laborBudget);
    months.push({ month, laborBudget, daysInMonth: daysInMonth(month) });
  }

  let weekAllowance = 0;
  let budgetedDays = 0;
  let unbudgetedDays = 0;

  const days: DayAllowance[] = dates.map((date) => {
    const month = monthStartOf(date);
    const laborBudget = budgetByMonth.get(month) ?? null;
    if (laborBudget === null) {
      unbudgetedDays += 1;
      return { date, month, allowance: null };
    }
    const allowance = laborBudget / daysInMonth(month);
    weekAllowance += allowance;
    budgetedDays += 1;
    return { date, month, allowance };
  });

  return {
    siteNumber,
    days,
    weekAllowance: budgetedDays > 0 ? weekAllowance : null,
    unbudgetedDays,
    months
  };
}
