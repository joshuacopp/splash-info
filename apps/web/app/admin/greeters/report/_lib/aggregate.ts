// Rolling site-day rows up into the shapes the report renders.
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

export interface Totals {
  days: number;
  total_cars: number;
  wash_sales: number;
  rewashes: number;
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
  /** Null when the window sold no wash sales: no denominator, not zero. */
  capture_pct: number | null;
  dob: number | null;
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
 * The actual is volume-weighted (summed sign ups over summed wash sales), so a
 * flat mean of the goal column would grade it against a target no site has: a
 * 400-car site's 32% goal would count exactly as much as a 40-car site's 22%,
 * and a site that reported seven days would count seven times. Weighting the
 * goal by wash sales puts both sides of the comparison on the same footing.
 *
 * Falls back to a flat mean when the window sold nothing — with no volume there
 * are no weights, and the plain average is the only answer available.
 */
function weightedGoal(
  rows: LocationPeriodRow[],
  pick: (r: LocationPeriodRow) => number | null
): number | null {
  let num = 0;
  let den = 0;
  for (const r of rows) {
    const g = pick(r);
    if (g === null || g === undefined) continue;
    const w = n(r.wash_sales);
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
    dob_goal: null
  };

  for (const r of rows) {
    t.total_cars += n(r.total_cars);
    t.wash_sales += n(r.wash_sales);
    t.rewashes += n(r.rewashes);
    t.package_dollars += n(r.package_dollars);
    t.extras_dollars += n(r.extras_dollars);
    t.sign_ups += n(r.sign_ups);
    t.reactivations += n(r.reactivations);
    t.google_reviews += n(r.google_reviews);
    t.cancellations += n(r.cancellations);
    t.net_members += n(r.net_members);
    t.scanned_wash_sales += r.scanned_wash_sales;
  }

  if (t.wash_sales > 0) {
    t.capture_pct = round((t.sign_ups * 100) / t.wash_sales, 1);
    t.dob = round((t.package_dollars + t.extras_dollars) / t.wash_sales, 2);
    t.scanned_pct = round((t.scanned_wash_sales * 100) / t.wash_sales, 1);
  }

  const cg = weightedGoal(rows, (r) => r.capture_goal_pct);
  const dg = weightedGoal(rows, (r) => r.dob_goal);
  t.capture_goal_pct = cg === null ? null : round(cg, 2);
  t.dob_goal = dg === null ? null : round(dg, 2);
  t.total_members = memberLevel(rows);

  return t;
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
