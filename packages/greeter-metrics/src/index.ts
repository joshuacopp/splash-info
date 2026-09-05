// Rolling site-day rows up into totals.
//
// MOVED HERE FROM apps/web/app/admin/greeters/report/_lib/aggregate.ts, and the
// move is the whole reason this package exists. The weekly digest email is
// assembled inside performance-worker, which cannot import from apps/web — but
// the digest and the report must agree to the decimal, because the same manager
// reads one on Monday and opens the other on Tuesday. A second copy of this
// arithmetic living in the worker would drift, quietly, and the first symptom
// would be somebody trusting the wrong one.
//
// NOTHING IN THIS PACKAGE MAY IMPORT REACT, NEXT, OR ANY BROWSER OR NODE API.
// It runs inside the Cloudflare Workers runtime as well as in a Next server
// component. Pure functions over plain rows, one type-only import, and it stays
// that way.
//
// THE ONE RULE THAT MATTERS: every rate is recomputed from summed numerators
// and summed denominators. Never average a column of percentages. A site that
// sold 4 cars on a dead Tuesday and 400 on Saturday would otherwise have its
// Tuesday count as heavily as its Saturday, and the company number would stop
// matching the sum of the rows underneath it — which is the single fastest way
// to lose a room's trust in a report.
//
// Goals are collapsed by the SAME weighting as the metric they grade — see
// weightedGoal(). They can't be summed (they're already rates), but averaging
// them flat would grade a volume-weighted actual against a target no site
// actually carries. A window that straddles a goal change shows the blend,
// which is the honest answer.
//
// The other rule: `total_members` is a LEVEL, not a flow. Summing it across
// days would count the same member once per day. It's read at each location's
// latest day in the window and only then added across locations. `net_members`
// (sign ups plus reactivations minus cancellations) is the summable one.
//
// THE LABOR AND REVENUE FIGURES ARE LEVELS TOO, and they are the reason to read
// that paragraph twice. Every other dollar column here is a day's worth of
// something; those four are a MONTH's, recorded on a day because that is when
// somebody read them off the internal reports. Seven days of a $24,000 budget is
// $24,000. They go through trendLevels(), which is memberLevel()'s treatment
// applied to a whole block — latest day per location, never a sum across days
// and never an average.
//
// `reactivations` is summed and reported, and that is ALL it does here. It is
// deliberately NOT in capture_pct's numerator — a returning member was never a
// new capture opportunity — so do not "fix" that by adding it in.
//
// `google_reviews` is the same deal: a COUNT of reviews collected, summed for a
// window total and nothing else. Not a star rating, not in any rate.
//
// `churn_pct` is ABSENT FROM Totals ON PURPOSE, and that absence is the point.
// It arrives already divided, and the row carries neither its numerator nor its
// denominator, so there is no way to recompute it over a range. The only thing
// that could be built here is a flat average of daily percentages — precisely
// the mistake the weighting rule at the top of this file exists to prevent, and
// the same one that makes the greeter workbooks disagree with this report.
// Churn is day-grain only: the site-day tables render each row's own figure.

import type { LocationPeriodRow } from "@splash/types/greeter";

/**
 * The month's labor and revenue picture as of the latest day in a window.
 *
 * Split out from Totals as its own bag because these six travel together and
 * must be resolved together: the two percentages are GENERATED in Postgres from
 * the four dollars ON THE SAME ROW, so a budget taken from one day and a trend
 * taken from another would produce a pair that no percentage on this interface
 * describes. trendLevels() is the only thing that should ever build one.
 *
 * LABOR OVER 100% IS BAD (projected to overspend the budget), REVENUE OVER 100%
 * IS GOOD (projected to beat the goal). Same arithmetic, opposite readings —
 * anything that colours or sorts these carries the direction explicitly. See
 * trendTier() in apps/web/app/admin/greeters/_lib/grading.
 */
export interface TrendLevels {
  /** Dollars budgeted for the whole MONTH, not the window. Never summed. */
  labor_budget: number | null;
  /** Projected month-end labor spend, as of the latest day. Never summed. */
  labor_trend: number | null;
  /** labor_trend / labor_budget * 100, straight off the row. OVER 100 IS BAD. */
  labor_trend_pct: number | null;
  /** Dollars of revenue targeted for the whole MONTH. Never summed. */
  revenue_goal: number | null;
  /** Projected month-end revenue, as of the latest day. Never summed. */
  revenue_trend: number | null;
  /** revenue_trend / revenue_goal * 100, off the row. OVER 100 IS GOOD. */
  revenue_trend_pct: number | null;
}

export interface Totals extends TrendLevels {
  days: number;
  total_cars: number;
  wash_sales: number;
  /**
   * Summed and reported, and ALSO subtracted from scanned_pct's denominator
   * alongside house_accounts. Nobody can scan a card for a rewash.
   */
  rewashes: number;
  /** Site-only. Same deal as rewashes: a real wash sale, but unscannable. */
  house_accounts: number;
  package_dollars: number;
  extras_dollars: number;
  sign_ups: number;
  /** Plain total. Feeds net_members only — never capture_pct. See the note above. */
  reactivations: number;
  /** Plain total. A review is not a capture — see the note above. */
  google_reviews: number;
  cancellations: number;
  net_members: number;
  scanned_wash_sales: number;
  /** Member roll at the latest day in the window. A level — see the note above. */
  total_members: number | null;
  /**
   * Null only when the window had no wash sales AND no sign ups: nothing
   * happened, so there is no denominator. A window of pure sign ups is 100%,
   * not null.
   */
  capture_pct: number | null;
  dob: number | null;
  /**
   * Scanned over SCANNABLE — a different denominator from the two above, which
   * is the whole point. See the divisions in totals().
   */
  scanned_pct: number | null;
  capture_goal_pct: number | null;
  dob_goal: number | null;
}

function n(v: number | null | undefined): number {
  return v ?? 0;
}

/** Mean of the non-null values, or null when there are none. */
function meanOrNull(values: (number | null)[]): number | null {
  const present = values.filter((v): v is number => v !== null && v !== undefined);
  if (present.length === 0) return null;
  return present.reduce((a, b) => a + b, 0) / present.length;
}

/**
 * A goal column collapsed the SAME WAY as the actual it will be graded against.
 *
 * The actual is volume-weighted, so a flat mean of the goal column would grade
 * it against a target no site has: a 400-car site's 32% goal would count exactly
 * as much as a 40-car site's 22%, and a site that reported seven days would
 * count seven times. Weighting the goal by volume puts both sides of the
 * comparison on the same footing.
 *
 * THE WEIGHT MUST BE THE ACTUAL'S DENOMINATOR, which is why callers pass it in
 * rather than it being hard-coded here. Capture is sign ups over wash sales PLUS
 * SIGN UPS, so its goal weights by that same sum; dob is dollars over wash sales
 * alone, so its goal weights by wash sales alone. Weighting the capture goal by
 * wash sales would quietly under-count exactly the days a greeter converted
 * best — the days with the fewest wash sales left over.
 *
 * Falls back to a flat mean when the window sold nothing — with no volume there
 * are no weights, and the plain average is the only answer available.
 */
function weightedGoal(
  rows: LocationPeriodRow[],
  pick: (r: LocationPeriodRow) => number | null,
  weigh: (r: LocationPeriodRow) => number
): number | null {
  let num = 0;
  let den = 0;
  for (const r of rows) {
    const g = pick(r);
    if (g === null || g === undefined) continue;
    const w = weigh(r);
    num += g * w;
    den += w;
  }
  if (den > 0) return num / den;
  return meanOrNull(rows.map(pick));
}

function round(value: number, places: number): number {
  const f = 10 ** places;
  return Math.round(value * f) / f;
}

/**
 * Collapse any set of site-days into one total.
 *
 * Works at every level of the drill-through — company, one site, one day —
 * because it's the same arithmetic each time. Using one function for all three
 * is what guarantees the levels reconcile.
 */
export function totals(rows: LocationPeriodRow[]): Totals {
  const t: Totals = {
    days: rows.length,
    total_cars: 0,
    wash_sales: 0,
    rewashes: 0,
    house_accounts: 0,
    package_dollars: 0,
    extras_dollars: 0,
    sign_ups: 0,
    reactivations: 0,
    google_reviews: 0,
    cancellations: 0,
    net_members: 0,
    scanned_wash_sales: 0,
    total_members: null,
    capture_pct: null,
    dob: null,
    scanned_pct: null,
    capture_goal_pct: null,
    dob_goal: null,
    // Resolved at the foot of this function, like total_members, and for the
    // same reason: nothing about them accumulates in the loop below.
    labor_budget: null,
    labor_trend: null,
    labor_trend_pct: null,
    revenue_goal: null,
    revenue_trend: null,
    revenue_trend_pct: null
  };

  // scanned_pct's denominator, accumulated PER DAY and floored per day, exactly
  // as greeter_scan_rates() does it in SQL. Deriving it afterwards from the
  // three totals (wash_sales - house_accounts - rewashes) would be off whenever
  // a single day's unscannable cars exceeded its wash sales — that day floors
  // to zero in SQL but would go negative here and silently credit the window
  // with denominator it never had. Not on Totals: nothing outside this division
  // wants it, and a second wash-sale-ish number on the interface is an
  // invitation to divide by the wrong one.
  let scannable = 0;

  for (const r of rows) {
    scannable += Math.max(
      0,
      n(r.wash_sales) - n(r.house_accounts) - n(r.rewashes)
    );
    t.total_cars += n(r.total_cars);
    t.wash_sales += n(r.wash_sales);
    t.rewashes += n(r.rewashes);
    t.house_accounts += n(r.house_accounts);
    t.package_dollars += n(r.package_dollars);
    t.extras_dollars += n(r.extras_dollars);
    t.sign_ups += n(r.sign_ups);
    t.reactivations += n(r.reactivations);
    t.google_reviews += n(r.google_reviews);
    t.cancellations += n(r.cancellations);
    t.net_members += n(r.net_members);
    t.scanned_wash_sales += r.scanned_wash_sales;
  }

  // THREE RATES, THREE DENOMINATORS, ON PURPOSE.
  //
  // THESE MUST MATCH THE SQL EXACTLY. This is the only place in the app that
  // recomputes a rate in TypeScript — it exists because the KPI tiles at the
  // top of the report roll several already-aggregated rows into one figure,
  // which SQL has no chance to do. It sits directly above tables whose numbers
  // come straight out of Postgres, so any drift between the two reads as a
  // bug to whoever is looking at the screen. The counterparts are the
  // generated columns in greeter-scorecard-tables.sql and the summed
  // recomputes in greeter_rollup / greeter_period_report.
  //
  // capture_pct divides by wash sales PLUS sign-ups: a customer either bought
  // a single wash or joined the plan, so both outcomes are opportunities and
  // the rate is bounded at 100. Changed 2026-08-22 along with the SQL; it used
  // to divide by wash sales alone, which put 400% on the scorecard. See
  // supabase/greeter-capture-13.sql.
  //
  // dob divides by wash sales. Unchanged, and deliberately not "made
  // consistent" with capture — dollars over base is a per-wash average.
  //
  // Neither nets house accounts or rewashes off its denominator. Those are
  // real wash sales and company policy counts them, even though nobody could
  // buy a membership against one.
  //
  // scanned_pct divides by SCANNABLE. It asks a different question: of the cars
  // a greeter COULD have scanned a card for, how many got attributed? Grading
  // that against gross would penalise a site for cars no card exists for.
  //
  // ROUNDING: capture to 1dp here, 2dp in SQL. The tile is a headline figure
  // and 1dp is what fits; the difference is display-only and never compared.
  const opportunities = t.wash_sales + t.sign_ups;
  if (opportunities > 0) {
    t.capture_pct = round((t.sign_ups * 100) / opportunities, 1);
  }
  if (t.wash_sales > 0) {
    t.dob = round((t.package_dollars + t.extras_dollars) / t.wash_sales, 2);
  }
  if (scannable > 0) {
    t.scanned_pct = round((t.scanned_wash_sales * 100) / scannable, 1);
  }

  // Each goal weights by its own actual's denominator — see weightedGoal.
  const cg = weightedGoal(
    rows,
    (r) => r.capture_goal_pct,
    (r) => n(r.wash_sales) + n(r.sign_ups)
  );
  const dg = weightedGoal(rows, (r) => r.dob_goal, (r) => n(r.wash_sales));
  t.capture_goal_pct = cg === null ? null : round(cg, 2);
  t.dob_goal = dg === null ? null : round(dg, 2);
  t.total_members = memberLevel(rows);

  // Assigned as a block, from one call. Picking the six off individually would
  // let a future edit resolve a budget from one day and a trend from another,
  // which is the one way to produce a percentage that describes no real row.
  return { ...t, ...trendLevels(rows) };
}

/**
 * The member roll across a set of site-days.
 *
 * Per location, take the LATEST day in the window and use that day's count;
 * then add across locations. Summing the column outright would count every
 * member once per day in the window, turning a 3,000-member company into
 * 21,000 over a week.
 *
 * Null when no row in the window carries a count at all — an unreported level
 * is unknown, not zero.
 */
export function memberLevel(rows: LocationPeriodRow[]): number | null {
  const latest = new Map<number, LocationPeriodRow>();
  for (const r of rows) {
    if (r.total_members === null) continue;
    const prev = latest.get(r.location_id);
    if (!prev || r.business_date > prev.business_date) latest.set(r.location_id, r);
  }
  if (latest.size === 0) return null;
  let sum = 0;
  for (const r of latest.values()) sum += n(r.total_members);
  return sum;
}

/**
 * The labor and revenue block across a set of site-days. memberLevel()'s rule,
 * applied to six columns instead of one.
 *
 * Per location, per SIDE, take the LATEST day that carries anything for that
 * side and read all three of its columns off that one row. Summing the columns
 * would add a month's budget to itself once per day in the window and turn a
 * $24,000 budget into $168,000; averaging would report a number the site was
 * never given.
 *
 * PER SIDE, not per row, because labor and revenue are typed independently: a
 * manager who reads the labor number off the reports on Monday and the revenue
 * number on Wednesday leaves Wednesday's row carrying only half the picture, and
 * taking both sides off the newest row would blank Monday's labor figure back
 * out. Within a side the three columns still come from a single row — the
 * percentage is generated in Postgres from the two dollars beside it, so mixing
 * days inside a side would print a percentage that isn't the division of the
 * numbers next to it.
 *
 * THE PERCENTAGES ARE CARRIED, NEVER RECOMPUTED, and they are dropped outright
 * once more than one location contributes. Two sites' budgets add up fine, but
 * the percentage of a summed budget is a number this codebase has nowhere agreed
 * to produce — the generated columns are per row, and the schema is explicit
 * that they must not be re-derived from aggregated dollars. Nothing renders a
 * company-level trend % today; if a KPI tile ever wants one, that decision gets
 * made here, in the open, rather than arriving as a side effect of a sum.
 *
 * Null throughout when no row carries a figure at all — an unread trend is
 * unknown, not zero, and a zero would claim the site is trending at nothing.
 */
export function trendLevels(rows: LocationPeriodRow[]): TrendLevels {
  const out: TrendLevels = {
    labor_budget: null,
    labor_trend: null,
    labor_trend_pct: null,
    revenue_goal: null,
    revenue_trend: null,
    revenue_trend_pct: null
  };

  const latestFor = (has: (r: LocationPeriodRow) => boolean) => {
    const latest = new Map<number, LocationPeriodRow>();
    for (const r of rows) {
      if (!has(r)) continue;
      const prev = latest.get(r.location_id);
      if (!prev || r.business_date > prev.business_date) {
        latest.set(r.location_id, r);
      }
    }
    return [...latest.values()];
  };

  // Added across locations only — never across days, which latestFor() has
  // already collapsed. Null rather than 0 when none of those rows carried the
  // column: a site whose month was never configured has no budget, and "$0.00
  // budgeted" is a different and much more alarming statement.
  const acrossSites = (
    list: LocationPeriodRow[],
    pick: (r: LocationPeriodRow) => number | null
  ): number | null => {
    let seen = false;
    let sum = 0;
    for (const r of list) {
      const v = pick(r);
      if (v === null || v === undefined) continue;
      seen = true;
      sum += v;
    }
    return seen ? sum : null;
  };

  const labor = latestFor(
    (r) => r.labor_budget !== null || r.labor_trend !== null
  );
  if (labor.length > 0) {
    out.labor_budget = acrossSites(labor, (r) => r.labor_budget);
    out.labor_trend = acrossSites(labor, (r) => r.labor_trend);
    out.labor_trend_pct =
      labor.length === 1 ? (labor[0]?.labor_trend_pct ?? null) : null;
  }

  const revenue = latestFor(
    (r) => r.revenue_goal !== null || r.revenue_trend !== null
  );
  if (revenue.length > 0) {
    out.revenue_goal = acrossSites(revenue, (r) => r.revenue_goal);
    out.revenue_trend = acrossSites(revenue, (r) => r.revenue_trend);
    out.revenue_trend_pct =
      revenue.length === 1 ? (revenue[0]?.revenue_trend_pct ?? null) : null;
  }

  return out;
}

export interface SiteTotals extends Totals {
  location_id: number;
  site_number: number;
  location_code: string;
  greeters_logged: number;
  first_date: string;
  last_date: string;
}

/** One row per location, for the morning call table and the ranking chart. */
export function bySite(rows: LocationPeriodRow[]): SiteTotals[] {
  const groups = new Map<number, LocationPeriodRow[]>();
  for (const r of rows) {
    const list = groups.get(r.location_id);
    if (list) list.push(r);
    else groups.set(r.location_id, [r]);
  }

  const out: SiteTotals[] = [];
  for (const [locationId, list] of groups) {
    // A group only exists because a row was pushed into it, so head is always
    // present — but noUncheckedIndexedAccess types list[0] as possibly
    // undefined and won't take a length check as proof.
    const head = list[0];
    if (!head) continue;
    const dates = list.map((r) => r.business_date).sort();
    out.push({
      ...totals(list),
      location_id: locationId,
      site_number: head.site_number,
      location_code: head.location_code,
      // Peak staffing seen on any one day, not a sum — the same greeter
      // working all seven days is one greeter, not seven.
      greeters_logged: Math.max(0, ...list.map((r) => r.greeters_logged)),
      first_date: dates[0] ?? head.business_date,
      last_date: dates[dates.length - 1] ?? head.business_date
    });
  }
  return out;
}

export interface DayTotals extends Totals {
  business_date: string;
}

/** One row per calendar day across every site in scope — the trend series. */
export function byDay(rows: LocationPeriodRow[]): DayTotals[] {
  const groups = new Map<string, LocationPeriodRow[]>();
  for (const r of rows) {
    const list = groups.get(r.business_date);
    if (list) list.push(r);
    else groups.set(r.business_date, [r]);
  }

  return [...groups.entries()]
    .map(([business_date, list]) => ({ ...totals(list), business_date }))
    .sort((a, b) => a.business_date.localeCompare(b.business_date));
}

/** Rows for one location, oldest first — the morning-call expansion. */
export function daysForSite(
  rows: LocationPeriodRow[],
  locationId: number
): LocationPeriodRow[] {
  return rows
    .filter((r) => r.location_id === locationId)
    .sort((a, b) => a.business_date.localeCompare(b.business_date));
}

/**
 * Change from the prior period, in the metric's own units.
 *
 * Percentages come back as POINTS (a 28% against a prior 25% is "+3.0 pts",
 * not "+12%"), because points is how the operators talk and a relative change
 * on a rate invites the reader to compare it against the goal gap, which is
 * also in points.
 *
 * Null when either side is missing — "no prior data" must not render as 0.0,
 * which reads as "flat".
 */
export function delta(
  current: number | null,
  prior: number | null
): number | null {
  if (current === null || prior === null) return null;
  return round(current - prior, 2);
}
