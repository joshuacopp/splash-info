// Greeter scorecard (/admin/greeters).
//
// The database version of the per-greeter monthly spreadsheet: one row per
// greeter per day, plus a parallel site-wide row, filterable by date range,
// location, and person.
//
// This is NOT the visit-based Performance Tracker at /admin/performance. That
// one logs a manager's visit (who was on site, one capture rate). This one logs
// a full day's sales numbers for one greeter. They share the "pertrack" grant
// and the same worker, and nothing else.
//
// Sections (top -> bottom):
//   1. Action-error / success banners.
//   2. Filter bar — date range, location, greeter-name substring, Regional
//      Director, Regional Manager.
//   3. "Add data" button row — opens each submission form in a modal.
//   4. Insight panels (last 7 days, ignoring the date/location/greeter filters
//      on purpose but honouring the manager filter): "No submissions" then
//      "Underreported".
//   5. Goal windows table — every goal set, which one is grading today, and a
//      delete per row.
//   6. Monthly targets table — each site's labor budget and revenue goal per
//      calendar month, with a delete per row. Its own table rather than more
//      columns on (5) because the two are keyed differently and resolve
//      differently; see MonthlyTargetsCard.
//   7. Summary table (per-greeter rollup for the filtered range).
//   8. Daily rows table.
//   9. Site-wide day rows table, including Scanned %.
//
// GOAL WINDOWS MAY OVERLAP, and the shortest window covering a day is the one
// that grades it — a promo week laid over a standing monthly baseline. The
// database decides that in greeter_goal_for(); inForceGoalIds below is this
// page's mirror of it, and exists only to label the table. Nothing here may
// become a second source of truth for which goal applies.
//
// THE TWO INSIGHTS ARE SEPARATE ON PURPOSE. "Nobody reported" and "reported but
// only scanned 60% of the cars" are different failures with different owners,
// and a day nobody reported has no scan rate to grade at all — greeter_scan_
// rates() is driven from location_daily, so a skipped day is absent there
// rather than 0%. Folding no-shows into the percentage would both hide the
// sites that are genuinely scanning badly and misattribute the cause.
//
// THE THREE DATA TABLES (7-9) ARE GROUPED BY SITE, one collapsible <details>
// and one <table> per site, with the header row and the leading one or two
// columns pinned. They run 13 to 17 columns wide and hundreds of rows long: in
// one piece they lost their header on the first scroll down, lost track of
// whose row you were on at the first scroll right, and parked the horizontal
// scrollbar three screens below wherever you were reading. The Site column is
// gone from all three because the group heading IS the site. The pieces that
// have to move together are groupBySite and SiteGroupBlock (both now in
// _lib/site-groups, shared with the report view) and TableWrap's `scrollBox` —
// and `scrollBox` is opt-in precisely because tables (5) and (6) share
// TableWrap, are short, and are deliberately left ungrouped and unpinned.
//
// The three submission forms used to be stacked cards below the tables, which
// made the page a long scroll of forms nobody was using at that moment. They're
// now behind buttons (SubmitPanels), sitting above the tables where they're
// reachable without scrolling. The forms themselves are unchanged and still
// server-rendered — see the note in SubmitPanels.tsx.
//
// DERIVED COLUMNS: capture %, D.O.B., hours worked and wash sales per hour all
// arrive computed from Postgres and are rendered as-is. Do not recompute them
// here — the rollup's versions come from summed numerators and denominators, so
// a client-side recompute over the displayed columns would disagree with the
// summary for any multi-day range.
//
// Auth posture: performanceGetJson collapses 401/403 to null -> no-access card,
// same as the performance page. A location admin's rows are scoped worker-side.

import type { ReactNode } from "react";
import Link from "next/link";
import { performanceGetJson } from "../performance/_lib/worker-fetch";
import { LocationPicker } from "../performance/_components/LocationPicker";
import {
  EMPTY_ROSTERS,
  fetchManagerRosters,
  ManagerFilters,
  type ManagerRosters
} from "./_components/ManagerFilters";
import {
  DAY_MS,
  dobCell,
  firstParam,
  goalNum,
  goalSuffix,
  hours,
  localDay,
  money,
  num,
  pct
} from "./_lib/format";
import {
  CAPTURE_TIER_CLASSES,
  CaptureCell,
  CaptureLegend,
  SCAN_TARGET_PCT,
  scanTier
} from "./_lib/grading";
import { SUCCESS_COPY } from "./_lib/copy";
// The grouping helpers moved to _lib when the report view was collapsed the
// same way — see the note at the top of that file for why they're shared.
import {
  compareCaptureDesc,
  groupBySite,
  nameKey,
  SiteGroupBlock
} from "./_lib/site-groups";
import {
  RedirectForm,
  type RedirectResult
} from "../_components/RedirectForm";
import { DeleteGoalButton } from "./_components/DeleteGoalButton";
import { GreeterDayForm } from "./_components/GreeterDayForm";
import { LocationMetricFields } from "./_components/MetricFields";
import { RowActionButton } from "./_components/RowActionButton";
import { SavingButton } from "./_components/SavingButton";
import { SubmitPanels } from "./_components/SubmitPanels";
import type {
  GreeterGoalRow,
  SiteMonthlyTargetRow,
  VoidState
} from "@splash/types/greeter";
import {
  createGoalAction,
  deleteGoalAction,
  deleteMonthlyTargetAction,
  restoreDayAction,
  restoreLocationDayAction,
  setMonthlyTargetAction,
  submitGreeterDayAction,
  submitLocationDayAction,
  voidDayAction,
  voidLocationDayAction
} from "./actions";

/** Shape of the two `*_goal` snapshot columns, on every row of both tables. */
interface GoalSnapshot {
  capture_goal_pct: number | null;
  dob_goal: number | null;
}

/**
 * Both day tables carry the void columns, and this page is one of the very few
 * reads that asks for struck-out rows at all (`include_voided=1` below) — the
 * correction screen has to be able to SEE a voided day, or restoring it would
 * be unreachable.
 *
 * NOTHING ON THIS PAGE SUMS A DAY ROW, which is what makes that safe. The
 * per-greeter summary, the scan rates and the two insight panels are all
 * separate reads that go through the _live views in SQL and cannot see a voided
 * row whatever this page asks for. If a total is ever computed here from
 * `dayList` or `locationDayList`, it must filter on voided_at first.
 */
interface DayRow extends GoalSnapshot, VoidState {
  id: string;
  business_date: string;
  location_id: number;
  site_number: number;
  location_code: string;
  /** Always selected — the two were optional here for no reason, and an edit
   *  form can't seed its people picker from a maybe. */
  beekeeper_user_id: string;
  greeter_name: string;
  wash_sales: number | null;
  rewashes: number | null;
  package_dollars: number | null;
  extras_dollars: number | null;
  sign_ups: number | null;
  /** Informational only. Not in capture_pct, not graded — see MetricFields. */
  reactivations: number | null;
  /** A COUNT of reviews collected, not a star rating. Informational. */
  google_reviews: number | null;
  /** 24-hour "HH:MM:SS" from Postgres `time`, or null when no shift was logged. */
  shift_start: string | null;
  shift_end: string | null;
  hours_worked: number | null;
  wash_sales_per_hour: number | null;
  capture_pct: number | null;
  dob: number | null;
  comments: string | null;
  created_by_email: string | null;
  updated_by_email: string | null;
}

/** Site-wide day. Deliberately NOT the same shape as DayRow — see MetricFields. */
interface LocationDayRow extends GoalSnapshot, VoidState {
  id: string;
  business_date: string;
  location_id: number;
  site_number: number;
  location_code: string;
  total_cars: number | null;
  wash_sales: number | null;
  /** Unscannable, like rewashes. Out of the scan rate, in capture % and D.O.B. */
  house_accounts: number | null;
  rewashes: number | null;
  package_dollars: number | null;
  extras_dollars: number | null;
  sign_ups: number | null;
  reactivations: number | null;
  cancellations: number | null;
  /** Active members as of that day — a level. Never sum this across rows. */
  total_members: number | null;
  net_members: number | null;
  member_goal_month_end: number | null;
  /**
   * Self-reported percentage, site only. Day-grain ONLY: it arrives already
   * divided, with neither numerator nor denominator on the row, so there is no
   * honest way to combine it across days. Never sum it, never average it —
   * display the day's own figure or nothing.
   */
  churn_pct: number | null;
  /** A COUNT of reviews collected, not a star rating. Informational. */
  google_reviews: number | null;
  /**
   * The two typed trending dollars. Carried here ONLY so the edit form can seed
   * itself — this page renders neither, because both are MONTH-TO-DATE
   * projections and the tables below are day-grain: a column of them would put
   * the same $24,000 on thirty rows and invite somebody to total it. The report
   * is where they belong, and it reads them as levels.
   *
   * Their denominators and the two percentages are deliberately absent: nothing
   * on this page needs them, and a labor_budget in scope here is one edit away
   * from being rendered as though a site spent it that day.
   */
  labor_trend: number | null;
  revenue_trend: number | null;
  capture_pct: number | null;
  dob: number | null;
  comments: string | null;
  created_by_email: string | null;
  updated_by_email: string | null;
}

interface RollupRow extends GoalSnapshot {
  beekeeper_user_id: string;
  greeter_name: string;
  site_number: number;
  location_code: string;
  first_date: string;
  last_date: string;
  days_logged: number;
  wash_sales: number | null;
  rewashes: number | null;
  package_dollars: number | null;
  extras_dollars: number | null;
  sign_ups: number | null;
  reactivations: number | null;
  /** Plain total across the window. A review is not a capture. */
  google_reviews: number | null;
  hours_worked: number | null;
  wash_sales_per_hour: number | null;
  capture_pct: number | null;
  dob: number | null;
}

/**
 * One site-day from greeter_scan_rates(): how much of the location's own
 * a-la-carte volume its greeters actually scanned for.
 *
 * The two nullables mean different things and must not be collapsed:
 *   scanned_pct === null      the site sold no ALC cars that day — no
 *                             denominator, so no rate. Not "scanned nothing".
 *   ever_submitted === false  the location has never logged a greeter day at
 *                             all: not onboarded, rather than slipping.
 */
interface ScanRateRow {
  business_date: string;
  location_id: number;
  site_number: number;
  location_code: string;
  site_wash_sales: number | null;
  house_accounts: number | null;
  rewashes: number | null;
  /**
   * site_wash_sales minus house accounts and rewashes, floored at 0 — and the
   * denominator scanned_pct is actually built from. site_wash_sales is still
   * returned because it's the figure a site recognises off its own report.
   */
  scannable_wash_sales: number;
  scanned_wash_sales: number;
  greeters_logged: number;
  scanned_pct: number | null;
  ever_submitted: boolean;
}

/**
 * One location-day inside the watch window where a submission is MISSING.
 * Only gaps come back — a complete day produces no row.
 *
 * A full day is two separate submissions, and either can be absent on its own:
 *   has_site_row === false   nobody logged the site's own numbers.
 *   greeters_logged === 0    no greeter logged their day.
 */
interface MissingDayRow {
  business_date: string;
  location_id: number;
  site_number: number;
  location_code: string;
  has_site_row: boolean;
  greeters_logged: number;
}

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

// num / money / pct / dobCell / hours / goalNum / goalSuffix / localDay /
// firstParam now live in ./_lib/format — shared with the report view so a null
// renders the same way on both.

/** "HH:MM:SS" (Postgres `time`) -> "8:00 AM". Anything unparseable renders raw. */
function clockLabel(value: string): string {
  const m = /^(\d{1,2}):(\d{2})/.exec(value);
  if (!m) return value;
  const h24 = Number(m[1]);
  const meridiem = h24 < 12 ? "AM" : "PM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${m[2]} ${meridiem}`;
}

/**
 * The shift window as one cell. Both-or-neither is enforced at three layers
 * below this, so a half-filled pair shouldn't reach here — but render whichever
 * end exists rather than swallowing it, so a bad row is visible instead of
 * silently blank.
 */
function shiftCell(start: string | null, end: string | null): string {
  if (!start && !end) return "—";
  if (start && end) return `${clockLabel(start)} – ${clockLabel(end)}`;
  return clockLabel((start ?? end) as string);
}

// SUCCESS_COPY now lives in _lib/copy.ts (imported at the top of this file).
// It moved when the report page grew its own void buttons: both screens render
// a banner off the same `success` key, and two copies of the sentence drifted
// apart within a day of existing.

/**
 * The re-grading tail on the goal banners: "… 12 greeter days and 3 site days
 * were re-graded."
 *
 * WHY THIS IS SAID AT ALL. Goals are copied onto each day as it is submitted,
 * so adding or removing a window that reaches into the past changes how days
 * ALREADY ENTERED are graded. The database does that re-stamp; without this
 * sentence the numbers on the tables below would simply be different from what
 * they were a moment ago, with nothing to connect the two.
 *
 * THE TWO COUNTS ARE NOT ADDED. Four greeter rows and one site row is one day
 * at a four-greeter site; "5 rows re-graded" would be summing people-days with
 * site-days. They are named separately or not at all.
 *
 * ABSENT PARAMS MEAN "NOT MENTIONED", NOT ZERO. The action omits rg/rl entirely
 * when both are zero, so a redirect that predates this feature and a goal that
 * needed no re-grading both land here as nulls and get no tail — which is the
 * right outcome for both.
 */
function restampTail(rg: string, rl: string, successKey: string): string {
  const g = /^\d+$/.test(rg) ? Number.parseInt(rg, 10) : 0;
  const l = /^\d+$/.test(rl) ? Number.parseInt(rl, 10) : 0;
  if (g === 0 && l === 0) return "";

  const parts: string[] = [];
  if (g > 0) parts.push(`${g} greeter ${g === 1 ? "day" : "days"}`);
  if (l > 0) parts.push(`${l} site ${l === 1 ? "day" : "days"}`);
  const subject = parts.join(" and ");
  // "the new goal" is only true on the insert path. After a delete there is no
  // new goal — the days fell back to whatever window is left covering them, or
  // to no goal at all, and saying otherwise would send someone looking for a
  // goal that was never created.
  const against =
    successKey === "goal_deleted"
      ? "re-graded against whatever goal is left covering them"
      : "re-graded against the new goal";
  return ` ${subject} already submitted ${
    g + l === 1 ? "was" : "were"
  } ${against}.`;
}

/**
 * The re-stamping tail on the three monthly-target banners: "… 12 site days
 * already logged in that month were re-stamped with the new figures."
 *
 * SEPARATE FROM restampTail ABOVE RATHER THAN SHARED, because the two sentences
 * are making different claims. A goal re-stamp changes how a day is GRADED; a
 * target re-stamp changes the denominator under a percentage the site reads
 * aloud on the Morning call, and it moves site days only — greeter_daily has no
 * labor or revenue columns, so there is no second grain and no "and 4 greeter
 * days" clause to write.
 *
 * SAYING THE COUNT IS THE POINT. Correcting a budget mid-month silently rewrites
 * days that are already on screen; a number that changes with nothing to explain
 * it is how people stop believing the report. A zero is omitted by the action
 * rather than sent, so "nothing needed re-stamping" and "this redirect predates
 * the feature" both land here as no tail, which is right for both.
 */
function targetRestampTail(rt: string, successKey: string): string {
  const n = /^\d+$/.test(rt) ? Number.parseInt(rt, 10) : 0;
  if (n === 0) return "";

  const days = `${n} site ${n === 1 ? "day" : "days"}`;
  // Past tense on both branches so the sentence needs no verb agreement, and
  // worded differently because a delete leaves NO budget rather than a new one —
  // telling someone their days were "re-stamped with the new figures" after a
  // delete would send them looking for figures that no longer exist.
  const what =
    successKey === "target_deleted"
      ? "lost the budget and goal they were quoting, so their labor and revenue percentages are blank"
      : "were re-stamped with the new figures, so their labor and revenue percentages have moved";
  return ` ${days} already logged in that month ${what}.`;
}

/**
 * The goal window in force TODAY, per site — the page's copy of what
 * greeter_goal_for() decides in the database.
 *
 * MIRRORS THE RESOLVER'S ORDER BY EXACTLY, and must keep mirroring it. The rule
 * is NOT the labor-rate page's "newest effective date wins": goal windows may
 * overlap on purpose (a promo week laid over a standing monthly baseline) and
 * the SHORTEST window covering a day is the one that grades it. A newest-wins
 * answer here would label a month-long baseline as in force on days the promo
 * is actually grading, which is the one thing this table exists to be right
 * about.
 *
 * Ties break the same way the SQL does: open-ended windows lose to bounded
 * ones, then shortest span, then latest start, then most recently created, then
 * lowest id. The last two are unreachable in practice — the unique index makes
 * (site, from, to) unique — but they are the resolver's terms, so they are
 * this function's terms.
 *
 * Spans are compared as raw millisecond differences off Date.parse of the two
 * ISO strings, which is UTC midnight at both ends — the offset cancels in the
 * subtraction, so this never touches the timezone question. Only the ORDER of
 * the numbers matters, never their units.
 *
 * An open-ended window is Infinity rather than a date, which is also why the
 * SQL can't express this as arithmetic: Postgres refuses to subtract
 * 'infinity'::date, so greeter_goal_for() sorts on `(effective_to IS NULL)`
 * first instead. Same ranking, different spelling.
 */
function windowSpanMs(row: GreeterGoalRow): number {
  if (!row.effective_to) return Number.POSITIVE_INFINITY;
  return Date.parse(row.effective_to) - Date.parse(row.effective_from);
}

function inForceGoalIds(rows: GreeterGoalRow[], today: string): Set<string> {
  const best = new Map<number, GreeterGoalRow>();
  for (const r of rows) {
    if (r.effective_from > today) continue;
    if (r.effective_to && r.effective_to < today) continue;

    const current = best.get(r.site_number);
    if (!current || beats(r, current)) best.set(r.site_number, r);
  }
  return new Set([...best.values()].map((r) => r.id));
}

function beats(candidate: GreeterGoalRow, incumbent: GreeterGoalRow): boolean {
  const a = windowSpanMs(candidate);
  const b = windowSpanMs(incumbent);
  if (a !== b) return a < b;
  if (candidate.effective_from !== incumbent.effective_from) {
    return candidate.effective_from > incumbent.effective_from;
  }
  if (candidate.created_at !== incumbent.created_at) {
    return candidate.created_at > incumbent.created_at;
  }
  // The resolver's last ORDER BY term, `g.id` with no direction — so ASC, so
  // the LOWER id wins, which is the opposite direction from the two tiebreaks
  // above it. Unreachable while idx_greeter_goals_unique_window stands (two
  // rows can't share a site, a start AND an end), and here anyway because the
  // point of this function is to be the same ranking as the SQL; a mirror that
  // stops one term short is one somebody eventually has to re-derive.
  return candidate.id < incumbent.id;
}

/**
 * "Sep 1, 2026" — deliberately NOT _lib/format's dayLabel.
 *
 * dayLabel renders "Tue 09-01", which is right for a daily row inside a range
 * the reader already picked, and wrong here: a goal window is often months long
 * and can cross a year boundary, so the year is load-bearing and the weekday is
 * noise. Parsed at UTC noon for the same reason dayLabel is — so no offset can
 * push the label onto the day before.
 */
function goalDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    year: "numeric"
  }).format(d);
}

/** "Sep 1, 2026 – Sep 30, 2026", or "From Sep 1, 2026" when open-ended. */
function windowLabel(row: GreeterGoalRow): string {
  if (!row.effective_to) return `From ${goalDate(row.effective_from)}`;
  return `${goalDate(row.effective_from)} – ${goalDate(row.effective_to)}`;
}

/**
 * "2026-09-01" -> "September 2026".
 *
 * NO DAY IN THE OUTPUT, and that is the whole reason this isn't goalDate. The
 * stored value is always the 1st because the column says so, not because
 * anything happens on that date — rendering "Sep 1, 2026" would read as a start
 * date and invite someone to look for the matching end. A month's target covers
 * the month.
 *
 * Parsed at UTC noon for the same reason goalDate is: no offset can drag the
 * label back into the previous month.
 */
function monthLabel(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "long",
    year: "numeric"
  }).format(d);
}

export default async function GreetersPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const dateFrom = firstParam(sp.date_from).trim();
  const dateTo = firstParam(sp.date_to).trim();
  const locationIdRaw = firstParam(sp.location_id).trim();
  const locationIdNum =
    locationIdRaw && /^\d+$/.test(locationIdRaw)
      ? Number.parseInt(locationIdRaw, 10)
      : undefined;
  const greeter = firstParam(sp.greeter).trim();
  // Manager emails, not names — see ManagerFilters for why. These narrow every
  // read on the page, including the two insight panels below, which no other
  // filter here does.
  const rd = firstParam(sp.rd).trim();
  const rm = firstParam(sp.rm).trim();

  // Which row, if any, is being corrected. Kept in the URL rather than in
  // component state so the edit form is a plain server render of a row this page
  // already fetched — no second lookup, and the back button leaves the edit.
  //
  // DELIBERATELY NOT IN `qs` BELOW. The filter suffix is what the fetches and
  // the "Reset" link are built from, and carrying an edit id into either one
  // would re-open the form on every filter change.
  const editDayId = firstParam(sp.edit_day).trim();
  const editLocationDayId = firstParam(sp.edit_location_day).trim();

  // And which row, if any, has its Edit / Void chooser open. Same reasoning as
  // the two above and same exclusion from `qs`: the chooser is a URL, not client
  // state, so a row's date cell can link to it from a server-rendered table and
  // Cancel is a plain navigation back to the filtered list.
  const actionsDayId = firstParam(sp.actions_day).trim();
  const actionsLocationDayId = firstParam(sp.actions_location_day).trim();

  const actionError = firstParam(sp.action_error).trim() || null;
  const successKey = firstParam(sp.success).trim();
  const successBase = SUCCESS_COPY[successKey] ?? null;
  // Only the two goal outcomes carry a re-grading tail, and only the three
  // target outcomes carry a re-stamping one. Appending either to the day banners
  // would be meaningless — submitting a day doesn't re-stamp anything — and the
  // params are never set on those redirects anyway.
  //
  // BOTH TAILS ARE APPENDED, NEVER ONE OR THE OTHER BY BRANCH: they read
  // different params (rg/rl vs rt), no action ever sets both, and each returns ""
  // when its own are absent. A branch here would be a third place that has to
  // know which action produced which key.
  const successMessage = successBase
    ? `${successBase}${restampTail(
        firstParam(sp.rg),
        firstParam(sp.rl),
        successKey
      )}${targetRestampTail(firstParam(sp.rt), successKey)}`
    : null;

  const qs = new URLSearchParams();
  if (dateFrom) qs.set("date_from", dateFrom);
  if (dateTo) qs.set("date_to", dateTo);
  if (locationIdNum !== undefined) qs.set("location_id", String(locationIdNum));
  if (greeter) qs.set("greeter", greeter);
  if (rd) qs.set("rd", rd);
  if (rm) qs.set("rm", rm);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";

  // THE TWO FLAT DAY LISTS ASK FOR VOIDED ROWS; nothing else on this page does.
  //
  // This is the correction screen, and a struck-out day has to be visible here
  // or there is no way to reach the Restore button. Every other read below —
  // the rollup, the scan rates, the missing-days watchlist — goes through a SQL
  // function that reads greeter_daily_live / location_daily_live and cannot see
  // a voided row at all, which is exactly why this flag is confined to the two
  // reads that render individual rows rather than totals.
  const dayQs = new URLSearchParams(qs);
  dayQs.set("include_voided", "1");
  const daySuffix = `?${dayQs.toString()}`;

  // Trailing seven days for the two insight panels, ENDING YESTERDAY.
  //
  // Today is excluded on purpose: a day is logged after it's over, so a
  // partially-entered (or not-yet-entered) today would put every site on the
  // list every morning.
  //
  // Computed in SITE LOCAL TIME, not UTC. toISOString() would roll the date
  // over at 8pm Eastern, so from every evening onward "yesterday" would
  // silently mean today — flagging numbers nobody has had a chance to enter,
  // which is exactly what excluding today is meant to prevent.
  const nowMs = Date.now();
  const watchTo = localDay(nowMs - DAY_MS);
  const watchFrom = localDay(nowMs - 7 * DAY_MS);
  // Deliberately unscoped by the page's DATE/SITE/GREETER filters — this is a
  // standing watchlist of every site the caller can see, not a view of the
  // current query. Worker-side location scoping still applies, so a location
  // admin sees only theirs.
  //
  // THE MANAGER FILTER IS THE ONE EXCEPTION and rides along. It answers "whose
  // sites am I responsible for", not "what am I looking at right now" — a
  // Regional Director who has narrowed the page to their region does not want
  // the watchlist naming other people's sites they cannot act on.
  const mgrQs = `${rd ? `&rd=${encodeURIComponent(rd)}` : ""}${
    rm ? `&rm=${encodeURIComponent(rm)}` : ""
  }`;
  const watchSuffix = `?date_from=${watchFrom}&date_to=${watchTo}${mgrQs}`;

  let days: DayRow[] | null = null;
  let rollup: RollupRow[] | null = null;
  let locationDays: LocationDayRow[] | null = null;
  let scanRates: ScanRateRow[] | null = null;
  let watchRates: ScanRateRow[] | null = null;
  let missingDays: MissingDayRow[] | null = null;
  let goals: GreeterGoalRow[] | null = null;
  let targets: SiteMonthlyTargetRow[] | null = null;
  // Initialised rather than left null because fetchManagerRosters() never
  // throws or resolves null — a roster outage arrives here as EMPTY_ROSTERS, so
  // the dropdowns render empty and disabled instead of taking the page down or
  // needing a null check at every use.
  let rosters: ManagerRosters = EMPTY_ROSTERS;
  let fetchError: string | null = null;

  try {
    // Parallel: nine independent reads. Sequential awaits would multiply the
    // page's time-to-first-byte for no benefit.
    [
      days,
      rollup,
      locationDays,
      scanRates,
      watchRates,
      missingDays,
      goals,
      targets,
      rosters
    ] = await Promise.all([
      performanceGetJson<DayRow[]>(`/pertrack/api/greeter/days${daySuffix}`),
      performanceGetJson<RollupRow[]>(`/pertrack/api/greeter/rollup${suffix}`),
      performanceGetJson<LocationDayRow[]>(
        `/pertrack/api/greeter/location-days${daySuffix}`
      ),
      // Same filter set as the site-wide table so the two line up row for
      // row. The greeter-name filter rides along in the suffix but the
      // endpoint ignores it — filtering the numerator would understate
      // every site.
      performanceGetJson<ScanRateRow[]>(
        `/pertrack/api/greeter/scan-rates${suffix}`
      ),
      performanceGetJson<ScanRateRow[]>(
        `/pertrack/api/greeter/scan-rates${watchSuffix}`
      ),
      performanceGetJson<MissingDayRow[]>(
        `/pertrack/api/greeter/missing-days${watchSuffix}`
      ),
      // DELIBERATELY UNFILTERED. Every window for every site the caller can
      // see, because which one is in force today is decided by comparing a
      // site's windows AGAINST EACH OTHER — hand this list a date-filtered
      // subset and the shortest-window rule would be resolving against
      // whichever windows happened to survive the filter. The page's location
      // filter is applied below, after that comparison, and only to what is
      // displayed. Worker-side location scoping still applies.
      performanceGetJson<GreeterGoalRow[]>("/pertrack/api/greeter/goals"),
      // ALSO UNFILTERED, but for a different reason than the goals above it,
      // and the difference matters if either read is ever revisited. Goals must
      // be fetched whole because the shortest-window rule resolves a site's
      // windows against EACH OTHER. Targets have nothing to resolve — one row
      // per site per month — so they are unfiltered only because the endpoint
      // filters on site_number and this page holds a location_id, which cannot
      // be turned into a site number until some row comes back carrying both.
      // The location filter is applied below, to the display alone.
      //
      // No month bounds either: the card's job is "every month this site has
      // ever been given", and the table is one row per site per month rather
      // than per site per category per month, so an unbounded read is small.
      performanceGetJson<SiteMonthlyTargetRow[]>(
        "/pertrack/api/greeter/monthly-targets"
      ),
      fetchManagerRosters()
    ]);
  } catch (err) {
    fetchError =
      err instanceof Error ? err.message : "Unknown error loading the scorecard.";
  }

  // This page as the user currently has it filtered. Two jobs: where to send
  // them back after a login, and the `return_to` on every form and row button
  // below — a correction that dropped the date range and site filter would
  // succeed and then navigate away from the row it just corrected. The server
  // allow-lists the value before redirecting to it.
  const returnPath = `/admin/greeters${suffix}`;

  if (days === null && !fetchError) {
    return (
      <section className="mx-auto w-full max-w-[1200px] px-5 py-9">
        <PageBanner mgrQs={mgrQs} />
        <div className="rounded-splash-lg border border-gray-light bg-white p-6 shadow-splash-card">
          <p className="mb-4 text-splash-deny">
            You don&rsquo;t have access to the greeter scorecard. Contact your
            administrator if this is unexpected.
          </p>
          <Link
            href={`/login?return=${encodeURIComponent(returnPath)}`}
            className="inline-flex items-center gap-1.5 rounded-splash-sm bg-splash-blue px-5 py-2.5 text-sm font-bold text-white shadow-splash-btn transition-colors hover:bg-splash-blue-dark"
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
        <PageBanner mgrQs={mgrQs} />
        <div className="rounded-splash-lg border border-gray-light bg-white p-6 shadow-splash-card">
          <h2 className="mb-2 text-lg font-bold text-splash-deny">
            Could not load the scorecard
          </h2>
          <p className="text-sm text-splash-navy/80">{fetchError}</p>
          <p className="mt-2 text-sm text-splash-navy/60">
            Reload the page to retry.
          </p>
        </div>
      </section>
    );
  }

  const dayList = days ?? [];
  const rollupList = rollup ?? [];
  const locationDayList = locationDays ?? [];

  // Keyed by site-day so the site-wide table can look its scan rate up in O(1)
  // rather than scanning the array per row. location_id, not location_code:
  // the code has been observed to diverge between tables for the same site.
  const scanByDay = new Map<string, ScanRateRow>();
  for (const r of scanRates ?? []) {
    scanByDay.set(`${r.business_date}|${r.location_id}`, r);
  }

  const underreported = summarizeUnderreported(watchRates ?? []);
  const missing = summarizeMissing(missingDays ?? []);

  // Label for the filter's LocationPicker on round-trip. Derived from a row in
  // the result set; falls back to the raw id when the filter excludes every row.
  let filterLocationLabel: string | undefined;
  if (locationIdNum !== undefined) {
    const match =
      dayList.find((r) => r.location_id === locationIdNum) ??
      locationDayList.find((r) => r.location_id === locationIdNum);
    filterLocationLabel = match
      ? `${match.location_code} · ${match.site_number}`
      : `ID ${locationIdNum}`;
  }

  // Today in YYYY-MM-DD, for the forms' default date. Local, not UTC — a
  // greeter filling this in at 9pm should get today, not tomorrow.
  const today = localDay(Date.now());

  /* ----------------------------------------------------------
   * Corrections
   * ---------------------------------------------------------- */

  /** The current filters plus one row key. Filters are preserved so cancelling
   *  an edit or a chooser puts the user back on the list they were looking at. */
  function rowHref(
    key:
      | "edit_day"
      | "edit_location_day"
      | "actions_day"
      | "actions_location_day",
    id: string
  ): string {
    const p = new URLSearchParams(qs);
    p.set(key, id);
    return `/admin/greeters?${p.toString()}`;
  }

  // The row being corrected, found in what the page already fetched rather than
  // re-requested by id. An id that isn't in the current result set — because the
  // filters exclude it, or because someone pasted a stale link — yields
  // undefined and simply renders no edit form, which is the honest outcome: the
  // alternative is a form seeded from a row the user can't see on the page.
  const editDay = editDayId
    ? dayList.find((r) => r.id === editDayId)
    : undefined;
  const editLocationDay = editLocationDayId
    ? locationDayList.find((r) => r.id === editLocationDayId)
    : undefined;

  // The chooser resolves against the same two lists for the same reason, with
  // one difference in the outcome: a miss here renders NOTHING at all. An edit
  // form that can't find its row says so, because the user pressed Edit and is
  // owed an answer; an unmatched chooser id is a stale or hand-edited URL with
  // no row behind it, and an empty modal offering to void something the page
  // can't show would be worse than no modal.
  const actionsDay = actionsDayId
    ? dayList.find((r) => r.id === actionsDayId)
    : undefined;
  const actionsLocationDay = actionsLocationDayId
    ? locationDayList.find((r) => r.id === actionsLocationDayId)
    : undefined;

  /** "BINGHAMTON · 7042" — LocationPicker needs a label to show a preselection,
   *  and the row carries a site_number rather than the name the typeahead renders. */
  const editDayLocationLabel = editDay
    ? `${editDay.location_code} · ${editDay.site_number}`
    : undefined;

  // In force is decided over ALL windows, then the display is narrowed. Doing
  // it the other way round would let the page's location filter change which
  // window it calls current.
  const goalList = goals ?? [];
  const inForceGoals = inForceGoalIds(goalList, today);
  // The filter is by SITE NUMBER, resolved from a row already on the page,
  // because greeter_goals carries site_number and location_code but not
  // location_id. When no row in the filtered result set can supply it — a site
  // with goals set but no days logged yet — the goal table stays unfiltered
  // rather than going empty, and its subtitle says so.
  const filterSiteNumber =
    locationIdNum === undefined
      ? undefined
      : (
          dayList.find((r) => r.location_id === locationIdNum) ??
          locationDayList.find((r) => r.location_id === locationIdNum)
        )?.site_number;
  const shownGoals =
    filterSiteNumber === undefined
      ? goalList
      : goalList.filter((g) => g.site_number === filterSiteNumber);

  // The targets table narrows on the same resolved site number, and falls back
  // to showing everything for the same reason: a site with a budget set but no
  // day logged yet can't be identified from the rows on this page, and an empty
  // table would read as "no budget" rather than "couldn't tell which site".
  const targetList = targets ?? [];
  const shownTargets =
    filterSiteNumber === undefined
      ? targetList
      : targetList.filter((t) => t.site_number === filterSiteNumber);

  // The first of the current month, in the same form the rows carry, so the card
  // can mark which target is the one being spent against right now. Derived from
  // `today` (site-local) rather than from a UTC date, or on the last evening of
  // the month every site would be told next month's budget is already live.
  const thisMonth = `${today.slice(0, 7)}-01`;

  /* ----------------------------------------------------------
   * Table grouping
   * ---------------------------------------------------------- */

  /**
   * Each greeter's capture % FOR THE WHOLE FILTERED RANGE, keyed exactly the way
   * the rollup is keyed: person plus site. A greeter who covers two sites gets
   * two figures and is ranked separately inside each site's block, which is the
   * only reason the site is in the key.
   *
   * "Daily rows" needs this because a day row carries only that day's capture %,
   * and ordering a greeter's whole block by one arbitrary day of it would move
   * people around every time the date filter changed. Both lists come back from
   * the same request with the same filters, so a day row with no entry here
   * means the two result sets disagreed — that greeter sorts last rather than
   * throwing, same as a greeter with no measurable rate.
   */
  const captureByGreeterSite = new Map<string, number | null>();
  for (const r of rollupList) {
    captureByGreeterSite.set(
      `${r.beekeeper_user_id}|${r.site_number}`,
      r.capture_pct
    );
  }

  const rollupGroups = groupBySite(rollupList, (a, b) => {
    const byCapture = compareCaptureDesc(a.capture_pct, b.capture_pct);
    if (byCapture !== 0) return byCapture;
    return nameKey(a.greeter_name).localeCompare(nameKey(b.greeter_name));
  });

  const dayGroups = groupBySite(dayList, (a, b) => {
    const byCapture = compareCaptureDesc(
      captureByGreeterSite.get(`${a.beekeeper_user_id}|${a.site_number}`) ??
        null,
      captureByGreeterSite.get(`${b.beekeeper_user_id}|${b.site_number}`) ?? null
    );
    if (byCapture !== 0) return byCapture;
    // THE IDENTITY TIEBREAK IS LOAD-BEARING, not cosmetic. Two greeters can tie
    // on capture % — and every ungraded greeter at a site ties at null — after
    // which the date sort below would shuffle their days into one
    // undifferentiated list with no way to tell whose is whose.
    if (a.beekeeper_user_id !== b.beekeeper_user_id) {
      return (
        nameKey(a.greeter_name).localeCompare(nameKey(b.greeter_name)) ||
        a.beekeeper_user_id.localeCompare(b.beekeeper_user_id)
      );
    }
    return b.business_date.localeCompare(a.business_date);
  });

  // No greeter tier here: a site-wide row IS the site, so newest day first is
  // the whole ordering.
  const locationDayGroups = groupBySite(locationDayList, (a, b) =>
    b.business_date.localeCompare(a.business_date)
  );

  return (
    <section className="mx-auto w-full max-w-[1200px] px-5 py-9">
      <ActionAlert message={actionError} />
      {successMessage ? <SuccessBanner message={successMessage} /> : null}
      <PageBanner mgrQs={mgrQs} />

      {/* Filter bar */}
      <form
        method="GET"
        action="/admin/greeters"
        className="mb-5 rounded-splash-lg border border-gray-light bg-white p-5 shadow-splash-card"
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <label className="flex flex-col gap-1">
            <span className={LABEL_CLS}>Date from</span>
            <input
              type="date"
              name="date_from"
              defaultValue={dateFrom}
              className={INPUT_CLS}
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className={LABEL_CLS}>Date to</span>
            <input
              type="date"
              name="date_to"
              defaultValue={dateTo}
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
            <span className={LABEL_CLS}>Greeter</span>
            <input
              type="text"
              name="greeter"
              defaultValue={greeter}
              placeholder="Name contains…"
              className={INPUT_CLS}
            />
          </label>

          <ManagerFilters rosters={rosters} rd={rd} rm={rm} />
        </div>

        <div className="mt-4 flex items-center gap-3">
          <button
            type="submit"
            className="inline-flex items-center gap-1.5 rounded-splash-sm bg-splash-blue px-5 py-2.5 text-sm font-bold text-white shadow-splash-btn transition-colors hover:bg-splash-blue-dark"
          >
            Apply filters
          </button>
          <Link
            href="/admin/greeters"
            className="text-sm font-semibold text-splash-blue hover:text-splash-blue-dark"
          >
            Reset
          </Link>
        </div>
      </form>

      {/* Corrections.
          A card in the page body rather than a fourth modal panel. SubmitPanels
          keeps its open/closed state on the client and is deliberately
          mounted-but-hidden so half-typed input survives a close, which is
          exactly wrong for a prefilled form: it would either fail to open on a
          client-side navigation or keep the previous row's numbers on screen.
          An edit is addressed by the URL, so it belongs where a server render
          can key it on the row id.

          KEYED ON THE ROW ID, and that is load-bearing. Both forms seed
          themselves from `defaultValue` / initial useState, neither of which is
          re-read on a re-render. Without the key, going from editing one row to
          editing another would leave the first row's numbers in every box while
          the hidden id pointed at the second. */}
      {editDayId && !editDay ? (
        <EditNotFoundNote
          what="greeter day"
          backHref={`/admin/greeters${suffix}`}
        />
      ) : null}
      {editDay ? (
        <Card
          title={`Editing ${editDay.greeter_name} — ${editDay.business_date}`}
          subtitle="Every field is editable, including the date, the site and the person: this updates the row in place rather than adding a second one. Goals are re-applied from whichever window covers the date you save, so moving a day re-grades it."
        >
          <div className="px-5 py-5">
            <GreeterDayForm
              key={editDay.id}
              action={submitGreeterDayAction}
              defaultDate={today}
              row={editDay}
              locationLabel={editDayLocationLabel}
              returnTo={returnPath}
            />
            <CancelEditLink href={`/admin/greeters${suffix}`} />
          </div>
        </Card>
      ) : null}

      {editLocationDayId && !editLocationDay ? (
        <EditNotFoundNote
          what="site-wide day"
          backHref={`/admin/greeters${suffix}`}
        />
      ) : null}
      {editLocationDay ? (
        <Card
          title={`Editing ${editLocationDay.location_code} — ${editLocationDay.business_date}`}
          subtitle="The whole location's day. Changing the date or the site moves the row rather than copying it, and the goal snapshot is re-applied from whichever window covers the date you save."
        >
          <div className="px-5 py-5">
            <RedirectForm
              key={editLocationDay.id}
              action={submitLocationDayAction}
              className="flex flex-col gap-4"
            >
              {/* The whole of edit mode, as far as the worker is concerned. */}
              <input type="hidden" name="id" value={editLocationDay.id} />
              {/* See GreeterDayForm's returnTo doc — this is the same field,
                  and it is what keeps the save from throwing away the filters
                  that were used to find this row in the first place. */}
              <input type="hidden" name="return_to" value={returnPath} />
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="flex flex-col gap-1">
                  <span className={LABEL_CLS}>Date *</span>
                  <input
                    type="date"
                    name="business_date"
                    required
                    defaultValue={editLocationDay.business_date}
                    className={INPUT_CLS}
                  />
                </label>
                <div className="flex flex-col gap-1">
                  <span className={LABEL_CLS}>Location *</span>
                  <LocationPicker
                    name="location_id"
                    required
                    placeholder="Search by site number, name, or code…"
                    defaultValue={editLocationDay.location_id}
                    defaultLabel={`${editLocationDay.location_code} · ${editLocationDay.site_number}`}
                  />
                </div>
              </div>
              <LocationMetricFields row={editLocationDay} />
              <div className="mt-1">
                <SavingButton>Save changes</SavingButton>
              </div>
            </RedirectForm>
            <CancelEditLink href={`/admin/greeters${suffix}`} />
          </div>
        </Card>
      ) : null}

      {/* The row chooser, opened from a row's date cell. It lives here with the
          edit forms because it is the same kind of thing — a row addressed by
          the URL, resolved out of what the page already fetched — and being
          `fixed`, where it sits in the markup changes nothing on screen.

          NEITHER OF THESE HAS A "not found" NOTE, unlike the two edit forms
          above. See where actionsDay is resolved. */}
      {actionsDay ? (
        <RowActionsModal
          title={`${actionsDay.greeter_name} — ${actionsDay.business_date}`}
          subtitle={`${actionsDay.location_code} · ${actionsDay.site_number}`}
          id={actionsDay.id}
          editHref={rowHref("edit_day", actionsDay.id)}
          voided={actionsDay.voided_at !== null}
          voidAction={voidDayAction}
          restoreAction={restoreDayAction}
          returnTo={returnPath}
          closeHref={`/admin/greeters${suffix}`}
          // The missing-list clause is CONDITIONAL and says so.
          // greeter_missing_days() flags a day only when the site has no live
          // greeter rows left for it, so voiding one of three greeters changes
          // nothing there. Stating it flatly would be a consequence the feature
          // doesn't carry, and people stop reading confirms that overstate.
          confirmText={`Void ${actionsDay.greeter_name}'s day at ${actionsDay.location_code} on ${actionsDay.business_date}?\n\nThe row is kept but struck out: it drops out of every report and rollup. If it was the last greeter logged for that site's day, the day goes back onto the missing-submissions list until someone logs it again. You can restore it from this table.`}
        />
      ) : null}

      {actionsLocationDay ? (
        <RowActionsModal
          title={`${actionsLocationDay.location_code} — ${actionsLocationDay.business_date}`}
          subtitle={`Site-wide totals · ${actionsLocationDay.site_number}`}
          id={actionsLocationDay.id}
          editHref={rowHref("edit_location_day", actionsLocationDay.id)}
          voided={actionsLocationDay.voided_at !== null}
          voidAction={voidLocationDayAction}
          restoreAction={restoreLocationDayAction}
          returnTo={returnPath}
          closeHref={`/admin/greeters${suffix}`}
          confirmText={`Void the site-wide totals for ${actionsLocationDay.location_code} on ${actionsLocationDay.business_date}?\n\nThe row is kept but struck out: it drops out of every report, the Scanned % for that day loses its denominator, and the day goes back onto the missing-submissions list. The greeters' own rows for that day are NOT affected. You can restore it from this table.`}
        />
      ) : null}

      {/* Submissions. Buttons, not stacked cards — see the note up top. The
          forms are built here (server components) and handed down as props. */}
      <SubmitPanels
        panels={[
          {
            key: "greeter-day",
            label: "Log a greeter's day",
            title: "Log a greeter's day",
            description:
              "One row per greeter per day. Submitting the same greeter and date again updates that row rather than adding a second one. D.O.B. and capture % are calculated for you.",
            form: (
              <GreeterDayForm
                action={submitGreeterDayAction}
                defaultDate={today}
                returnTo={returnPath}
              />
            )
          },
          {
            key: "location-day",
            label: "Log site-wide numbers",
            title: "Log site-wide numbers",
            description:
              "The whole location's day, not attributed to anyone. Total cars, cancellations and the member count live here only — they belong to the site, not to a person.",
            form: (
              <RedirectForm
                action={submitLocationDayAction}
                className="flex flex-col gap-4"
              >
                <input type="hidden" name="return_to" value={returnPath} />
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <label className="flex flex-col gap-1">
                    <span className={LABEL_CLS}>Date *</span>
                    <input
                      type="date"
                      name="business_date"
                      required
                      defaultValue={today}
                      className={INPUT_CLS}
                    />
                  </label>
                  <div className="flex flex-col gap-1">
                    <span className={LABEL_CLS}>Location *</span>
                    <LocationPicker
                      name="location_id"
                      required
                      placeholder="Search by site number, name, or code…"
                    />
                  </div>
                </div>
                <LocationMetricFields />
                <div className="mt-1">
                  <SavingButton>Save site-wide day</SavingButton>
                </div>
              </RedirectForm>
            )
          },
          {
            key: "goal",
            label: "Set goals for a site",
            title: "Set goals for a site",
            description:
              "Goals apply to a location for a date range. Ranges may overlap on purpose — set a baseline for the month, then lay a promo week over it, and the shorter window grades its own days. Leave the end date blank for an open-ended goal. Days already submitted inside the new window are re-graded when you save, and the confirmation says how many.",
            form: (
              <RedirectForm
                action={createGoalAction}
                className="flex flex-col gap-4"
              >
                <input type="hidden" name="return_to" value={returnPath} />
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  <div className="flex flex-col gap-1">
                    <span className={LABEL_CLS}>Location *</span>
                    <LocationPicker
                      name="location_id"
                      required
                      placeholder="Search by site number, name, or code…"
                    />
                  </div>
                  <label className="flex flex-col gap-1">
                    <span className={LABEL_CLS}>Effective from *</span>
                    <input
                      type="date"
                      name="effective_from"
                      required
                      className={INPUT_CLS}
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className={LABEL_CLS}>Effective to</span>
                    <input
                      type="date"
                      name="effective_to"
                      className={INPUT_CLS}
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className={LABEL_CLS}>Capture % goal *</span>
                    {/* A percentage, not a count: 30 means 30%. The worker
                        rejects anything outside 0–100. */}
                    <input
                      type="number"
                      name="capture_goal_pct"
                      min="0"
                      max="100"
                      step="0.01"
                      required
                      placeholder="30"
                      className={INPUT_CLS}
                    />
                    <span className={HINT_CLS}>
                      Sign ups as a share of wash sales. Enter 30 for 30%.
                    </span>
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className={LABEL_CLS}>D.O.B. goal ($) *</span>
                    <input
                      type="number"
                      name="dob_goal"
                      min="0"
                      step="0.01"
                      required
                      placeholder="0.00"
                      className={INPUT_CLS}
                    />
                    <span className={HINT_CLS}>
                      Dollars per car: package $ plus extras $ over wash sales.
                    </span>
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className={LABEL_CLS}>Member goal (month end)</span>
                    <input
                      type="number"
                      name="member_goal_month_end"
                      min="0"
                      step="1"
                      placeholder="Optional"
                      className={INPUT_CLS}
                    />
                    <span className={HINT_CLS}>
                      Total active members to reach — a level, not the month&rsquo;s
                      adds.
                    </span>
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className={LABEL_CLS}>Note</span>
                    <input
                      type="text"
                      name="note"
                      maxLength={500}
                      placeholder="Optional"
                      className={INPUT_CLS}
                    />
                  </label>
                </div>
                <div className="mt-1">
                  <SavingButton>Save goal</SavingButton>
                </div>
              </RedirectForm>
            )
          },
          {
            key: "monthly-target",
            label: "Set a month's budget and goal",
            title: "Set a month's labor budget and revenue goal",
            // WHAT THIS DESCRIPTION HAS TO CARRY, because nothing else on the
            // panel can: that both dollars are whole-MONTH figures, that one of
            // them is enough, that clearing both is spelled "delete", and that
            // saving over an existing month rewrites days already logged. The
            // last one is the reason the panel says anything at all about
            // correction — a user who thinks they are adding a target and is in
            // fact replacing one has just moved every percentage that month.
            description:
              "One target per site per calendar month. Both figures are for the WHOLE month, not a day or a week — they're the numbers the site's labor and revenue trending dollars get measured against. Fill in either one or both; if you want a month to have no target at all, delete it from the table below rather than saving it blank. Saving a month that already has a target replaces it and re-measures the days already logged in it, and the confirmation says how many moved.",
            form: (
              <RedirectForm
                action={setMonthlyTargetAction}
                className="flex flex-col gap-4"
              >
                <input type="hidden" name="return_to" value={returnPath} />
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  <div className="flex flex-col gap-1">
                    <span className={LABEL_CLS}>Location *</span>
                    <LocationPicker
                      name="location_id"
                      required
                      placeholder="Search by site number, name, or code…"
                    />
                  </div>
                  <label className="flex flex-col gap-1">
                    <span className={LABEL_CLS}>Month *</span>
                    {/* type="month" submits "YYYY-MM", which the worker accepts
                        and normalises to the 1st. A date picker would have
                        offered a day the column then throws away, and a reader
                        who picked the 15th would reasonably expect it to mean
                        something. */}
                    <input
                      type="month"
                      name="month"
                      required
                      className={INPUT_CLS}
                    />
                    <span className={HINT_CLS}>
                      The whole calendar month this budget covers.
                    </span>
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className={LABEL_CLS}>Labor budget ($)</span>
                    <input
                      type="number"
                      name="labor_budget"
                      min="0"
                      step="0.01"
                      placeholder="0.00"
                      className={INPUT_CLS}
                    />
                    {/* Says which direction is bad. Labor and revenue share a
                        row, share the arithmetic, and mean opposite things —
                        the two hints are worded to be read together. */}
                    <span className={HINT_CLS}>
                      Total labor dollars planned for the month. Trending{" "}
                      <strong>over</strong> 100% means projected to overspend.
                    </span>
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className={LABEL_CLS}>Revenue goal ($)</span>
                    <input
                      type="number"
                      name="revenue_goal"
                      min="0"
                      step="0.01"
                      placeholder="0.00"
                      className={INPUT_CLS}
                    />
                    <span className={HINT_CLS}>
                      Total revenue targeted for the month. Trending{" "}
                      <strong>over</strong> 100% is the good one — projected to
                      beat it.
                    </span>
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className={LABEL_CLS}>Note</span>
                    <input
                      type="text"
                      name="note"
                      maxLength={500}
                      placeholder="Optional"
                      className={INPUT_CLS}
                    />
                  </label>
                </div>
                {/* NEITHER DOLLAR IS `required` AND NEITHER IS CHECKED HERE.
                    "At least one of two" isn't expressible as an input
                    attribute, and the rule already exists twice — as the
                    site_monthly_targets_not_empty CHECK and as the worker's
                    400, which is a full sentence telling the user to delete the
                    month instead. That sentence lands in the error banner
                    unchanged. A third copy in this file would be a third place
                    for it to drift out of step with the constraint. */}
                <div className="mt-1">
                  <SavingButton>Save monthly target</SavingButton>
                </div>
              </RedirectForm>
            )
          }
        ]}
      />

      {/* Two insights, deliberately not one. "Didn't report" and "reported but
          scanned badly" are different failures with different owners, and a day
          nobody reported has no scan rate to grade in the first place. */}
      <MissingSubmissionsPanel
        rows={missing}
        dateFrom={watchFrom}
        dateTo={watchTo}
      />

      <UnderreportedPanel
        rows={underreported}
        dateFrom={watchFrom}
        dateTo={watchTo}
      />

      <CaptureLegend />

      <GoalWindowsCard
        rows={shownGoals}
        inForce={inForceGoals}
        today={today}
        narrowedTo={
          locationIdNum !== undefined && filterSiteNumber === undefined
            ? filterLocationLabel ?? null
            : null
        }
        returnTo={returnPath}
      />

      {/* Directly under the goal windows because they are the same kind of
          thing — a target somebody sets, against which days are graded — and a
          reader looking for "what is this site supposed to hit" should find both
          without hunting. They are two tables rather than one because they are
          keyed differently: a goal is a date RANGE and ranges may overlap, a
          target is a calendar MONTH and there is exactly one. */}
      <MonthlyTargetsCard
        rows={shownTargets}
        thisMonth={thisMonth}
        narrowedTo={
          locationIdNum !== undefined && filterSiteNumber === undefined
            ? filterLocationLabel ?? null
            : null
        }
        returnTo={returnPath}
      />

      {/* Summary */}
      <Card
        title="By greeter"
        subtitle="Totals for the filtered range. Capture % is sign ups over wash sales plus sign ups, so it tops out at 100%. Capture % and D.O.B. are recomputed from the summed numbers, not averaged across days."
      >
        {rollupList.length === 0 ? (
          <EmptyNote>No greeter days match these filters.</EmptyNote>
        ) : (
          rollupGroups.map((group) => (
            <SiteGroupBlock
              key={group.siteNumber}
              group={group}
              open={rollupGroups.length === 1}
            >
              <TableWrap scrollBox>
                <thead className={THEAD_CLS}>
                  <tr>
                    {/* Greeter alone is frozen. Freezing two here would take
                        Days with it, and Days is a column nobody navigates by. */}
                    <FrozenTh left="left-0" width="w-[112px]" edge>
                      Greeter
                    </FrozenTh>
                    <th className={TH_CLS}>Days</th>
                    <th className={TH_CLS}>Hours</th>
                    {/* The two graded columns lead, because they are what this
                        table is read for. Everything right of them is the
                        arithmetic behind them, in the order it is spoken. */}
                    <th className={TH_CLS}>Capture %</th>
                    <th className={TH_CLS}>D.O.B.</th>
                    <th className={TH_CLS}>Sign ups</th>
                    <th className={TH_CLS}>Reacts</th>
                    <th className={TH_CLS}>Wash sales</th>
                    <th className={TH_CLS}>WS / hr</th>
                    <th className={TH_CLS}>Package $</th>
                    <th className={TH_CLS}>Extras $</th>
                    <th className={TH_CLS}>Reviews</th>
                    <th className={TH_CLS}>Rewashes</th>
                  </tr>
                </thead>
                <tbody className={TBODY_CLS}>
                  {group.rows.map((r) => (
                    <tr key={`${r.beekeeper_user_id}-${r.site_number}`}>
                      <FrozenTd
                        left="left-0"
                        width="w-[112px]"
                        edge
                        extra="font-semibold"
                      >
                        {r.greeter_name}
                      </FrozenTd>
                      <td className="px-4 py-3 text-splash-navy/80">
                        {r.days_logged}
                      </td>
                      {/* Only days with a shift window logged contribute here,
                          so this can be blank while Days is not. */}
                      <td className="px-4 py-3 text-splash-navy/80">
                        {hours(r.hours_worked)}
                      </td>
                      <td className="px-4 py-3">
                        <CaptureCell
                          value={r.capture_pct}
                          goal={r.capture_goal_pct}
                        />
                      </td>
                      <td className="px-4 py-3 font-semibold">
                        {dobCell(r.dob)}
                        {goalSuffix(r.dob_goal)}
                      </td>
                      <td className="px-4 py-3 text-splash-navy/80">
                        {num(r.sign_ups)}
                      </td>
                      {/* Reactivations. Sits next to sign ups because that is
                          where a reader looks for it, NOT because it is part of
                          the same number — capture % counts sign ups only. */}
                      <td className="px-4 py-3 text-splash-navy/80">
                        {num(r.reactivations)}
                      </td>
                      <td className="px-4 py-3 text-splash-navy/80">
                        {num(r.wash_sales)}
                      </td>
                      <td className="px-4 py-3 text-splash-navy/80">
                        {hours(r.wash_sales_per_hour)}
                      </td>
                      <td className="px-4 py-3 text-splash-navy/80">
                        {money(r.package_dollars)}
                      </td>
                      <td className="px-4 py-3 text-splash-navy/80">
                        {money(r.extras_dollars)}
                      </td>
                      {/* A count of reviews collected, not a rating. Summed and
                          shown; it grades nothing. */}
                      <td className="px-4 py-3 text-splash-navy/80">
                        {num(r.google_reviews)}
                      </td>
                      <td className="px-4 py-3 text-splash-navy/80">
                        {num(r.rewashes)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </TableWrap>
            </SiteGroupBlock>
          ))
        )}
      </Card>

      {/* Daily rows */}
      <Card title="Daily rows">
        {dayList.length === 0 ? (
          <EmptyNote>Nothing logged for these filters yet.</EmptyNote>
        ) : (
          dayGroups.map((group) => (
            <SiteGroupBlock
              key={group.siteNumber}
              group={group}
              open={dayGroups.length === 1}
            >
              <TableWrap scrollBox>
                <thead className={THEAD_CLS}>
                  <tr>
                    {/* Date and Greeter are both frozen: this table is read by
                        scrolling right to a metric, and either one alone leaves
                        the other question ("whose? when?") unanswered. The
                        w-[80px] here plus px-2 either side is what left-[96px]
                        below is measured against — see the geometry block above
                        FrozenTh before changing either. */}
                    <FrozenTh left="left-0" width="w-[80px]">
                      Date
                    </FrozenTh>
                    <FrozenTh left="left-[96px]" width="w-[112px]" edge>
                      Greeter
                    </FrozenTh>
                    {/* The two graded columns lead, then their inputs. Shift is
                        last on purpose: it is the column people scroll past, not
                        the one they scroll to. */}
                    <th className={TH_CLS}>Hours</th>
                    <th className={TH_CLS}>Capture %</th>
                    <th className={TH_CLS}>D.O.B.</th>
                    <th className={TH_CLS}>Sign ups</th>
                    <th className={TH_CLS}>Reacts</th>
                    <th className={TH_CLS}>Wash sales</th>
                    <th className={TH_CLS}>WS / hr</th>
                    <th className={TH_CLS}>Package $</th>
                    <th className={TH_CLS}>Extras $</th>
                    <th className={TH_CLS}>Reviews</th>
                    <th className={TH_CLS}>Rewashes</th>
                    <th className={TH_CLS}>Shift</th>
                  </tr>
                </thead>
                <tbody className={TBODY_CLS}>
                  {group.rows.map((r) => (
                    // Tinted rather than faded for a voided row. `opacity` on
                    // the <tr> would take the date link down with the numbers,
                    // and that link is the only route to Restore.
                    //
                    // The tint is on the <tr>, so the FROZEN cells have to
                    // repaint it as an opaque hex themselves — a translucent
                    // sticky cell lets the scrolling columns show through it.
                    <tr
                      key={r.id}
                      className={
                        r.voided_at ? "bg-splash-deny/[0.04]" : undefined
                      }
                    >
                      <FrozenTd
                        left="left-0"
                        width="w-[80px]"
                        voided={r.voided_at !== null}
                        extra="font-mono text-xs"
                      >
                        <RowActionsLink
                          href={rowHref("actions_day", r.id)}
                          label={`Edit or void ${r.greeter_name} on ${r.business_date}`}
                        >
                          <span
                            className={r.voided_at ? "line-through" : undefined}
                          >
                            {r.business_date}
                          </span>
                          {r.voided_at ? (
                            <VoidedBadge email={r.voided_by_email} />
                          ) : null}
                        </RowActionsLink>
                      </FrozenTd>
                      <FrozenTd
                        left="left-[96px]"
                        width="w-[112px]"
                        edge
                        voided={r.voided_at !== null}
                        extra="font-semibold"
                      >
                        {r.greeter_name ?? "—"}
                      </FrozenTd>
                      <td className="px-4 py-3 text-splash-navy/80">
                        {hours(r.hours_worked)}
                      </td>
                      <td className="px-4 py-3">
                        <CaptureCell
                          value={r.capture_pct}
                          goal={r.capture_goal_pct}
                        />
                      </td>
                      <td className="px-4 py-3 font-semibold">
                        {dobCell(r.dob)}
                        {goalSuffix(r.dob_goal)}
                      </td>
                      <td className="px-4 py-3 text-splash-navy/80">
                        {num(r.sign_ups)}
                      </td>
                      {/* Reactivations. Sits next to sign ups because that is
                          where a reader looks for it, NOT because it is part of
                          the same number — capture % counts sign ups only. */}
                      <td className="px-4 py-3 text-splash-navy/80">
                        {num(r.reactivations)}
                      </td>
                      <td className="px-4 py-3 text-splash-navy/80">
                        {num(r.wash_sales)}
                      </td>
                      <td className="px-4 py-3 text-splash-navy/80">
                        {hours(r.wash_sales_per_hour)}
                      </td>
                      <td className="px-4 py-3 text-splash-navy/80">
                        {money(r.package_dollars)}
                      </td>
                      <td className="px-4 py-3 text-splash-navy/80">
                        {money(r.extras_dollars)}
                      </td>
                      {/* A count of reviews collected, not a rating. Displayed
                          and nothing more. */}
                      <td className="px-4 py-3 text-splash-navy/80">
                        {num(r.google_reviews)}
                      </td>
                      <td className="px-4 py-3 text-splash-navy/80">
                        {num(r.rewashes)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-xs text-splash-navy/80">
                        {shiftCell(r.shift_start, r.shift_end)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </TableWrap>
            </SiteGroupBlock>
          ))
        )}
      </Card>

      {/* Site-wide rows */}
      <Card
        title="Site-wide days"
        subtitle="Full-day location totals, logged separately from the individual greeters. Scanned % is the share of that day's wash sales the site's greeters claimed — a data-quality signal, not a sales one."
      >
        {locationDayList.length === 0 ? (
          <EmptyNote>No site-wide days match these filters.</EmptyNote>
        ) : (
          locationDayGroups.map((group) => (
            <SiteGroupBlock
              key={group.siteNumber}
              group={group}
              open={locationDayGroups.length === 1}
            >
              <TableWrap scrollBox>
                <thead className={THEAD_CLS}>
                  <tr>
                    {/* Date alone. There is one row per day here, so the date
                        IS the row's identity — nothing else needs freezing. */}
                    <FrozenTh left="left-0" width="w-[80px]" edge>
                      Date
                    </FrozenTh>
                    <th className={TH_CLS}>Total cars</th>
                    <th className={TH_CLS}>Wash sales</th>
                    <th className={TH_CLS}>Scanned %</th>
                    {/* Both unscannable-car columns sit immediately right of the
                        rate they reduce, so the arithmetic is legible across the
                        row instead of needing an explanation. */}
                    <th className={TH_CLS}>House acct</th>
                    <th className={TH_CLS}>Rewashes</th>
                    <th className={TH_CLS}>Package $</th>
                    <th className={TH_CLS}>Extras $</th>
                    <th className={TH_CLS}>D.O.B.</th>
                    <th className={TH_CLS}>Sign ups</th>
                    <th className={TH_CLS}>Reacts</th>
                    <th className={TH_CLS}>Reviews</th>
                    <th className={TH_CLS}>Cancels</th>
                    <th className={TH_CLS}>Net</th>
                    <th className={TH_CLS}>Members</th>
                    <th className={TH_CLS}>Capture %</th>
                    {/* Churn sits AFTER the graded pair on purpose. Put it
                        beside Members and the next person to touch this table
                        will give it a goal to match its neighbours; it has
                        none, and shouldn't. */}
                    <th className={TH_CLS}>Churn %</th>
                  </tr>
                </thead>
                <tbody className={TBODY_CLS}>
                  {group.rows.map((r) => (
                    <tr
                      key={r.id}
                      className={
                        r.voided_at ? "bg-splash-deny/[0.04]" : undefined
                      }
                    >
                      <FrozenTd
                        left="left-0"
                        width="w-[80px]"
                        edge
                        voided={r.voided_at !== null}
                        extra="font-mono text-xs"
                      >
                        <RowActionsLink
                          href={rowHref("actions_location_day", r.id)}
                          label={`Edit or void ${r.location_code} on ${r.business_date}`}
                        >
                          <span
                            className={r.voided_at ? "line-through" : undefined}
                          >
                            {r.business_date}
                          </span>
                          {r.voided_at ? (
                            <VoidedBadge email={r.voided_by_email} />
                          ) : null}
                        </RowActionsLink>
                      </FrozenTd>
                      <td className="px-4 py-3 text-splash-navy/80">
                        {num(r.total_cars)}
                      </td>
                      <td className="px-4 py-3 text-splash-navy/80">
                        {num(r.wash_sales)}
                      </td>
                      <td className="px-4 py-3">
                        <ScanCell
                          row={scanByDay.get(
                            `${r.business_date}|${r.location_id}`
                          )}
                        />
                      </td>
                      <td className="px-4 py-3 text-splash-navy/80">
                        {num(r.house_accounts)}
                      </td>
                      <td className="px-4 py-3 text-splash-navy/80">
                        {num(r.rewashes)}
                      </td>
                      <td className="px-4 py-3 text-splash-navy/80">
                        {money(r.package_dollars)}
                      </td>
                      <td className="px-4 py-3 text-splash-navy/80">
                        {money(r.extras_dollars)}
                      </td>
                      <td className="px-4 py-3 font-semibold">
                        {dobCell(r.dob)}
                        {goalSuffix(r.dob_goal)}
                      </td>
                      <td className="px-4 py-3 text-splash-navy/80">
                        {num(r.sign_ups)}
                      </td>
                      {/* Reactivations. Sits next to sign ups because that is
                          where a reader looks for it, NOT because it is part of
                          the same number — capture % counts sign ups only. */}
                      <td className="px-4 py-3 text-splash-navy/80">
                        {num(r.reactivations)}
                      </td>
                      {/* A count of reviews collected, not a rating. */}
                      <td className="px-4 py-3 text-splash-navy/80">
                        {num(r.google_reviews)}
                      </td>
                      <td className="px-4 py-3 text-splash-navy/80">
                        {num(r.cancellations)}
                      </td>
                      {/* sign ups plus reactivations minus cancellations,
                          computed in Postgres. All three inputs are columns
                          above. */}
                      <td className="px-4 py-3 text-splash-navy/80">
                        {num(r.net_members)}
                      </td>
                      {/* A level, not a daily amount — the member roll as of
                          this day, graded against the month-end goal. */}
                      <td className="px-4 py-3 font-semibold">
                        {num(r.total_members)}
                        {goalSuffix(r.member_goal_month_end)}
                      </td>
                      <td className="px-4 py-3">
                        <CaptureCell
                          value={r.capture_pct}
                          goal={r.capture_goal_pct}
                        />
                      </td>
                      {/* Self-reported, ungraded, and DAY-GRAIN ONLY. It
                          appears here and on the report's site-day table, and
                          nowhere that covers more than one day — the row
                          carries no numerator or denominator, so it can't be
                          re-derived over a range, and a flat average of daily
                          percentages would be a lie. */}
                      <td className="px-4 py-3 text-splash-navy/80">
                        {pct(r.churn_pct)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </TableWrap>
            </SiteGroupBlock>
          ))
        )}
      </Card>

    </section>
  );
}

/* ============================================================
 * Shared classes + small presentational pieces
 * ============================================================ */

const LABEL_CLS =
  "text-xs font-semibold uppercase tracking-wider text-splash-navy/70";
const INPUT_CLS =
  "rounded-splash-sm border border-gray-light bg-white px-3 py-2 text-sm text-splash-navy placeholder:text-splash-navy/40 focus:border-splash-blue focus:outline-none";
const HINT_CLS = "text-[11px] text-splash-navy/60";
// Submit buttons are <SavingButton>, which owns its own classes — it needs the
// disabled variants too, and those only make sense next to the pending state.
const THEAD_CLS =
  "bg-splash-navy/5 text-left text-xs font-semibold uppercase tracking-wider text-splash-navy/70";
const TBODY_CLS = "divide-y divide-gray-light text-splash-navy";

// PINNED CELLS — HEADER ROW AND LEADING COLUMNS.
//
// Two pins with one shared set of hazards, so one shared block of constants.
//
// THERE IS NO PINNED ACTIONS COLUMN ANY MORE, and nothing should reinstate one.
// Edit and Void were the last cell of a 15- and an 18-column table, pinned
// right so they weren't a full screen-width past the edge — but pinned they
// cost a permanent right-hand strip that covered most of a row on a phone. The
// row's DATE CELL is the entry point now: it links to `?actions_day=` /
// `?actions_location_day=` and RowActionsModal renders over the page. That link
// is the ONLY way to reach Edit and Void; strip it out of the date cell and
// both verbs become unreachable from the table.
//
// WHY THE LEADING COLUMNS ARE PINNED. The same table from the other end:
// scrolling right far enough to read Capture % took Greeter and Date off the
// screen, so the number you were looking at belonged to nobody.
//
// WHY THE HEADER IS PINNED, AND WHAT IT COSTS. See TableWrap's `scrollBox`:
// sticky resolves against the nearest scrolling ancestor, so the header only
// stays put because the wrapper caps its own height. Un-cap it and every
// `top-0` below silently stops doing anything.
//
// THE BACKGROUNDS ARE FLATTENED HEXES, not the bg-splash-navy/5 and
// bg-splash-deny/[0.04] tints the same cells would otherwise inherit. A
// translucent sticky cell is see-through, so the columns sliding underneath
// read straight through it. #f4f3f6 is splash-navy at 5% over white; #fef6f6 is
// splash-deny at 4% over white. If either token moves in tailwind.base.cjs
// these have to be recomputed by hand — nothing checks them.
//
// THE RULES ARE INSET SHADOWS, NOT BORDERS. Tailwind's preflight sets
// border-collapse: collapse, and collapsed borders do not travel with a sticky
// cell in Chrome. Neither does the `divide-y` row rule on <tbody>, which is why
// every pinned cell paints its own bottom line — without it the frozen columns
// become one unbroken strip of text down a 400-row table, which defeats the
// point of freezing them. #dbdbdb is `gray-light`, hard-coded for the same
// reason the tints are.
//
// Z-ORDER. A cell pinned on ONE axis only has to clear the ordinary cells
// sliding under it: header 20, body 10. A cell pinned on BOTH — a corner, where
// the header row crosses a frozen column — has to clear both of those, hence
// 30. Give a corner the plain header value and the frozen body cells scroll
// over the top of it.

/** Ordinary header cell in a scroll-box table. */
const TH_CLS =
  "sticky top-0 z-20 bg-[#f4f3f6] px-4 py-3 shadow-[inset_0_-1px_0_#dbdbdb]";

// FROZEN COLUMN GEOMETRY — THE ONE INVARIANT ON THIS PAGE THAT NOTHING CHECKS.
//
// Column two's `left` must equal column one's TOTAL rendered width, padding
// included. Written out, because getting it wrong is what produced the bug this
// replaced (Greeter's header sitting on the tail of Date, with the third column
// sliding visibly through the gap between them):
//
//   FROZEN_PAD_X  = px-2      ->  8px a side, 16px per cell
//   FROZEN_DATE_W = w-[80px]  ->  fits "2026-08-24" in font-mono text-xs
//   FROZEN_NAME_W = w-[112px] ->  a greeter name wrapping to two lines
//
//   Date column    =  80 + 16 = 96px   ==  Greeter's left-[96px]
//   Greeter column = 112 + 16 = 128px
//   Frozen block   = 224px, which is what a 375px phone gives up to it.
//
// Widen Date and left-[96px] moves by the same number of pixels, or the two
// columns overlap again. Nothing fails, no test catches it, it just looks
// wrong — which is why it shipped twice.
//
// THE WIDTH GOES ON AN INNER <div>, NOT ON THE CELL. That is the fix, not a
// style choice: under `table-layout: auto` a width on a <td> is only a
// suggestion — the browser sizes the column to its content and the space going
// spare — and `max-width` on a table cell is ignored outright. A block child
// with a definite width leaves the column nothing to negotiate. Move the width
// back onto the cell and the overlap comes straight back.
//
// The widths still assume these tables stay WIDER than their scroll box, which
// at 13-17 columns they are. If one is ever narrowed until it fits, auto layout
// hands the leftover width out to every column including the frozen ones, and
// the offset drifts by however much it handed the first one.

/**
 * A frozen leading column, header half.
 *
 * `edge` marks the OUTER column of the frozen block — the only one that draws a
 * vertical divider, so a two-column freeze reads as one pinned unit rather than
 * as a little table of its own.
 *
 * `width` arrives as a whole literal class string from the call site rather
 * than assembled here: Tailwind scans source text, and a class built from a
 * variable is a class that gets purged.
 */
function FrozenTh({
  left,
  width,
  edge,
  children
}: {
  left: string;
  width: string;
  edge?: boolean;
  children: ReactNode;
}) {
  return (
    <th
      className={[
        "sticky top-0 z-30 bg-[#f4f3f6] px-2 py-3",
        left,
        edge
          ? "shadow-[inset_-1px_0_0_#dbdbdb,inset_0_-1px_0_#dbdbdb]"
          : "shadow-[inset_0_-1px_0_#dbdbdb]"
      ].join(" ")}
    >
      <div className={width}>{children}</div>
    </th>
  );
}

/** Body half of FrozenTh — same offsets and width, opaque background, z-10. */
function FrozenTd({
  left,
  width,
  edge,
  voided,
  extra,
  children
}: {
  left: string;
  width: string;
  edge?: boolean;
  voided?: boolean;
  /** Type styling the unfrozen version of this cell used to carry. */
  extra?: string;
  children: ReactNode;
}) {
  return (
    <td
      className={[
        // py-3 matches every unfrozen cell so the row heights still line up;
        // only the horizontal padding is tightened.
        "sticky z-10 px-2 py-3",
        left,
        voided ? "bg-[#fef6f6]" : "bg-white",
        edge
          ? "shadow-[inset_-1px_0_0_#dbdbdb,inset_0_-1px_0_#dbdbdb]"
          : "shadow-[inset_0_-1px_0_#dbdbdb]",
        extra ?? ""
      ].join(" ")}
    >
      {/* break-words on the width-carrying element, or a name longer than the
          column blows the column back out and takes the offset with it. */}
      <div className={`${width} break-words`}>{children}</div>
    </td>
  );
}

/* ------------------------------------------------------------
 * Grouping the tables by site
 *
 * groupBySite, compareCaptureDesc, nameKey and SiteGroupBlock moved to
 * ./_lib/site-groups when the report view's greeter table was collapsed the
 * same way — imported at the top of this file. They are shared rather than
 * copied because the A-Z / capture-descending ordering is a rule the operators
 * asked for, and the two pages disagreeing about where a greeter sits would
 * make both look wrong.
 * ------------------------------------------------------------ */

function Card({
  title,
  subtitle,
  children
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <div className="mb-6 overflow-hidden rounded-splash-lg border border-gray-light bg-white shadow-splash-card">
      <div className="border-b border-gray-light px-5 py-4">
        <h2 className="text-lg font-bold text-splash-navy">{title}</h2>
        {subtitle ? (
          <p className="mt-1 text-xs text-splash-navy/60">{subtitle}</p>
        ) : null}
      </div>
      {children}
    </div>
  );
}

/* ------------------------------------------------------------
 * Goal windows
 * ------------------------------------------------------------ */

/**
 * Every goal window, with the one grading TODAY marked, and a delete per row.
 *
 * WHY THIS TABLE EXISTS AT ALL. Windows may overlap, so "what is this site's
 * capture goal?" stopped being answerable by looking at the newest row. Without
 * somewhere to see the whole stack, a promo week quietly laid over a monthly
 * baseline is invisible until the grading looks wrong, and the only way to
 * remove a mistake would be to write SQL.
 *
 * A NAMED STATE PER ROW, NOT A BOLDED CURRENT ONE — the same treatment as the
 * labor-rate screen, for the same reason: every non-current state reads as
 * "old" if it isn't named, and they mean different things. FOUR states here
 * rather than that screen's three, because overlap adds one: a window can cover
 * today and still not be grading it.
 *
 *   In force    a day logged today at this site is graded against this.
 *   Scheduled   starts in the future. Real, saved, grading nothing yet.
 *   Expired     ended. Still the correct explanation of the days inside it.
 *   Superseded  covers today, but a shorter window at this site also does and
 *               wins. Comes BACK into force the day the shorter one ends, which
 *               is the behaviour, not a glitch.
 *
 * SORTED BY SITE, THEN LATEST START FIRST, which is the order the worker's
 * SELECT already returns. Not re-sorted here into span order even though span
 * is what decides the winner — a reader scanning for "what did we do in
 * September" wants chronology, and the badge already answers the other
 * question.
 */
function GoalWindowsCard({
  rows,
  inForce,
  today,
  narrowedTo,
  returnTo
}: {
  rows: GreeterGoalRow[];
  inForce: Set<string>;
  today: string;
  /**
   * Set only when the page's location filter could NOT be resolved to a site
   * number, meaning this table is showing every site while the rest of the page
   * shows one. Named in the subtitle rather than silently ignored.
   */
  narrowedTo: string | null;
  /**
   * The page with its current filters, posted as `return_to` on the delete.
   * Passed down rather than rebuilt here because this card doesn't see the
   * search params, and a delete that returned to the unfiltered list would
   * answer "remove this window" by throwing away the reader's view of it.
   */
  returnTo: string;
}) {
  return (
    <Card
      title="Goal windows"
      subtitle={
        narrowedTo
          ? `Showing every site — no logged day in the current filter identifies ${narrowedTo}, so its goals can't be picked out. Overlapping windows are allowed; the shortest one covering a day is the one that grades it.`
          : "Overlapping windows are allowed: the shortest one covering a day is the one that grades it. Deleting a window re-grades the days inside it against whatever is left."
      }
    >
      {rows.length === 0 ? (
        <EmptyNote>
          No goals set. Days logged without a goal are stored and totalled, but
          nothing grades them — use &ldquo;Set goals for a site&rdquo; above.
        </EmptyNote>
      ) : (
        <TableWrap>
          <thead className={THEAD_CLS}>
            <tr>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Site</th>
              <th className="px-4 py-3">Window</th>
              <th className="px-4 py-3">Capture % goal</th>
              <th className="px-4 py-3">D.O.B. goal</th>
              <th className="px-4 py-3">Member goal</th>
              <th className="px-4 py-3">Note</th>
              <th className="px-4 py-3 text-right">Remove</th>
            </tr>
          </thead>
          <tbody className={TBODY_CLS}>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="whitespace-nowrap px-4 py-2.5">
                  <GoalStatusBadge
                    row={r}
                    today={today}
                    current={inForce.has(r.id)}
                  />
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 text-splash-navy/80">
                  <div className="font-semibold">{r.location_code}</div>
                  <div className="font-mono text-xs text-splash-navy/50">
                    {r.site_number}
                  </div>
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 text-splash-navy/80">
                  {windowLabel(r)}
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 font-mono">
                  {goalNum(r.capture_goal_pct)}%
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 font-mono">
                  ${goalNum(r.dob_goal)}
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 font-mono text-splash-navy/70">
                  {r.member_goal_month_end === null
                    ? "—"
                    : num(r.member_goal_month_end)}
                </td>
                <td className="max-w-[16rem] px-4 py-2.5 text-xs text-splash-navy/70">
                  {r.note || "—"}
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 text-right">
                  {/* RedirectForm, never redirect() — see its header. One form
                      per row so the hidden id can't be ambiguous, and so a
                      pending delete only disables its own button. */}
                  <RedirectForm action={deleteGoalAction}>
                    <input type="hidden" name="goal_id" value={r.id} />
                    <input type="hidden" name="return_to" value={returnTo} />
                    <DeleteGoalButton
                      confirmText={`Delete the ${r.location_code} goal for ${windowLabel(
                        r
                      )}?\n\nDays already submitted inside that window will be re-graded against whatever goal is left covering them — or left ungraded if none is.`}
                    />
                  </RedirectForm>
                </td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}
    </Card>
  );
}

/**
 * In force / Scheduled / Expired / Superseded — see GoalWindowsCard's header
 * for what each one means.
 *
 * `current` is computed once for the whole table by inForceGoalIds rather than
 * derived per row, because the answer depends on comparing a site's windows
 * against each other — a row cannot decide it alone, and a second copy of the
 * shortest-wins rule here would be a second place for it to drift from
 * greeter_goal_for().
 *
 * ORDER MATTERS IN THIS FUNCTION. `current` is checked first because an
 * in-force window is also, trivially, a window that covers today; the last
 * branch is reached only by a row that covers today and lost anyway, which is
 * exactly what "Superseded" is claiming.
 */
function GoalStatusBadge({
  row,
  today,
  current
}: {
  row: GreeterGoalRow;
  today: string;
  current: boolean;
}) {
  if (current) {
    return (
      <span
        className="rounded-full bg-splash-success/15 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-splash-success"
        title="A day logged today at this site is graded against this goal."
      >
        In force
      </span>
    );
  }
  if (row.effective_from > today) {
    return (
      <span
        className="rounded-full bg-splash-blue/15 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-splash-blue"
        title={`Starts ${goalDate(row.effective_from)}. Until then the site is graded against whatever is in force.`}
      >
        Scheduled
      </span>
    );
  }
  if (row.effective_to && row.effective_to < today) {
    return (
      <span
        className="rounded-full bg-splash-navy/10 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-splash-navy/60"
        title={`Ended ${goalDate(row.effective_to)}. Still the correct explanation of the days inside it.`}
      >
        Expired
      </span>
    );
  }
  return (
    <span
      className="rounded-full bg-splash-navy/10 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-splash-navy/60"
      title="Covers today, but a shorter window at this site covers it too and wins. This goal grades the days the shorter one doesn't."
    >
      Superseded
    </span>
  );
}

/* ------------------------------------------------------------
 * Monthly targets
 * ------------------------------------------------------------ */

/**
 * Every month's labor budget and revenue goal, with the current month marked and
 * a delete per row.
 *
 * A SEPARATE TABLE FROM GOAL WINDOWS, not a couple of extra columns on it, and
 * the difference is in the key rather than in the styling. A goal is a date
 * RANGE, ranges may overlap, and the shortest one covering a day wins. A target
 * is a calendar MONTH and there is exactly one — (site_number, month) is unique.
 * Filing budgets as goal windows would have handed them the overlap rule, and a
 * promo week laid over September would then have blanked September's budget for
 * seven days, because a shorter window that doesn't mention labor still wins.
 *
 * THREE STATES, NOT THE GOAL TABLE'S FOUR. "Superseded" cannot happen here for
 * the same uniqueness reason, so it isn't offered — an unreachable badge is a
 * reader wondering what would produce it.
 *
 *   In force    days logged today at this site are measured against this.
 *   Scheduled   a future month. Real, saved, measuring nothing yet.
 *   Past        the month is over. Still the correct explanation of its days.
 *
 * EITHER DOLLAR MAY BE BLANK and a blank one is not a gap to be filled: a site
 * that budgets labor but sets no revenue number is a normal, deliberate state,
 * and the row renders a dash rather than a zero so nobody reads it as "the goal
 * is nothing". Both blank is impossible — the DB refuses it and the worker says
 * so in a sentence pointing at this table's delete button.
 *
 * NO PERCENTAGES IN THIS TABLE even though the whole feature exists to produce
 * two. A percentage needs a trend to divide, trends are recorded per day, and
 * this row is a month; the Morning call report is where the division happens and
 * where the opposite readings (labor over 100% bad, revenue over 100% good) are
 * explained. Repeating them here would be a second place for that explanation to
 * drift.
 */
function MonthlyTargetsCard({
  rows,
  thisMonth,
  narrowedTo,
  returnTo
}: {
  rows: SiteMonthlyTargetRow[];
  /** "YYYY-MM-01" for the current month in site-local time — see where it's
   *  derived. Compared by string, which is safe because both sides are stored
   *  and built in that one zero-padded form. */
  thisMonth: string;
  /** Set only when the page's location filter could NOT be resolved to a site
   *  number — same fallback as GoalWindowsCard, same reason. */
  narrowedTo: string | null;
  /** The page with its current filters, posted as `return_to` on the delete.
   *  See GoalWindowsCard's copy of this prop for why it's passed down. */
  returnTo: string;
}) {
  return (
    <Card
      title="Monthly targets"
      subtitle={
        narrowedTo
          ? `Showing every site — no logged day in the current filter identifies ${narrowedTo}, so its targets can't be picked out. One target per site per month; saving a month that already has one replaces it.`
          : "One target per site per month. The labor and revenue figures typed on each day are measured against these, so saving over a month that already has a target re-stamps the days already logged in it — the confirmation says how many."
      }
    >
      {rows.length === 0 ? (
        <EmptyNote>
          No monthly targets set. Sites can still log labor and revenue trending
          dollars — they&rsquo;re stored, but with nothing to divide by, the
          Morning call shows the dollars and no percentage. Use &ldquo;Set a
          month&rsquo;s budget and goal&rdquo; above.
        </EmptyNote>
      ) : (
        <TableWrap>
          <thead className={THEAD_CLS}>
            <tr>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Site</th>
              <th className="px-4 py-3">Month</th>
              <th className="px-4 py-3">Labor budget</th>
              <th className="px-4 py-3">Revenue goal</th>
              <th className="px-4 py-3">Note</th>
              <th className="px-4 py-3 text-right">Remove</th>
            </tr>
          </thead>
          <tbody className={TBODY_CLS}>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="whitespace-nowrap px-4 py-2.5">
                  <MonthlyTargetStatusBadge
                    month={r.month}
                    thisMonth={thisMonth}
                  />
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 text-splash-navy/80">
                  <div className="font-semibold">{r.location_code}</div>
                  <div className="font-mono text-xs text-splash-navy/50">
                    {r.site_number}
                  </div>
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 text-splash-navy/80">
                  {monthLabel(r.month)}
                </td>
                {/* money() renders null as a dash, which is what a site that
                    budgets one of the two and not the other should show. A 0
                    here would be a claim, not a blank. */}
                <td className="whitespace-nowrap px-4 py-2.5 font-mono">
                  {money(r.labor_budget)}
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 font-mono">
                  {money(r.revenue_goal)}
                </td>
                <td className="max-w-[16rem] px-4 py-2.5 text-xs text-splash-navy/70">
                  {r.note || "—"}
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 text-right">
                  {/* RedirectForm, never redirect() — see its header. One form
                      per row, as in the goals table, so the hidden id can't be
                      ambiguous.

                      The confirm text names the consequence the button can't
                      show: deleting doesn't just remove a row, it re-stamps the
                      days already logged in that month so their percentages go
                      blank. Deleting the CURRENT month is the dangerous one and
                      the sentence says so first. */}
                  <RedirectForm action={deleteMonthlyTargetAction}>
                    <input type="hidden" name="target_id" value={r.id} />
                    <input type="hidden" name="return_to" value={returnTo} />
                    <DeleteGoalButton
                      confirmText={`Delete the ${r.location_code} target for ${monthLabel(
                        r.month
                      )}?\n\nDays already logged in that month lose the budget and goal they were measured against, so their labor and revenue percentages go blank on the Morning call. The trending dollars themselves are kept.`}
                    />
                  </RedirectForm>
                </td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}
    </Card>
  );
}

/**
 * In force / Scheduled / Past — see MonthlyTargetsCard's header for why there
 * are three of these and four goal states.
 *
 * Compared as strings rather than as Dates on purpose: both sides are
 * "YYYY-MM-01", zero-padded, so lexical order is calendar order, and parsing
 * either one would reintroduce the timezone question that thisMonth was derived
 * site-locally to avoid.
 *
 * The classes are written out in full on each branch rather than composed from
 * a colour variable — Tailwind scans this file as text and a built-up class name
 * would be absent from the stylesheet, so the badge would render unstyled.
 */
function MonthlyTargetStatusBadge({
  month,
  thisMonth
}: {
  month: string;
  thisMonth: string;
}) {
  if (month === thisMonth) {
    return (
      <span
        className="rounded-full bg-splash-success/15 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-splash-success"
        title="Days logged today at this site are measured against this budget and goal."
      >
        In force
      </span>
    );
  }
  if (month > thisMonth) {
    return (
      <span
        className="rounded-full bg-splash-blue/15 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-splash-blue"
        title={`Starts ${monthLabel(month)}. Nothing is measured against it until then.`}
      >
        Scheduled
      </span>
    );
  }
  return (
    <span
      className="rounded-full bg-splash-navy/10 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-splash-navy/60"
      title={`${monthLabel(month)} is over. Still the correct explanation of the days inside it.`}
    >
      Past
    </span>
  );
}

/* ------------------------------------------------------------
 * Scan rate (attribution / data quality)
 *
 * The thresholds and the CaptureCell/CaptureLegend pieces moved to
 * ./_lib/grading when the report view was added. They're shared rather than
 * copied because the same site showing amber here and red there would destroy
 * trust in both pages.
 * ------------------------------------------------------------ */

/**
 * The scanned share for one site-day.
 *
 * Three separate blank states, which look identical to a reader but must not be
 * conflated in code:
 *   no row      the scan-rate query and the site-wide list disagreed (row
 *               limits differ). Rare; render blank rather than a wrong 0%.
 *   pct null    the site sold no a-la-carte cars, so there was nothing to
 *               scan. No denominator, no rate.
 *   never       the location has never logged a greeter day. Not onboarded, so
 *               flagging it at 0% would just be noise.
 */
function ScanCell({ row }: { row: ScanRateRow | undefined }) {
  if (!row) return <span className="text-splash-navy/40">—</span>;

  if (!row.ever_submitted) {
    return (
      <span
        className="text-splash-navy/40"
        title="This location has never logged a greeter day — no greeters onboarded to the scorecard yet."
      >
        —
      </span>
    );
  }
  if (row.scanned_pct === null) {
    return (
      <span
        className="text-splash-navy/40"
        title="No a-la-carte cars sold that day, so there was nothing to scan."
      >
        —
      </span>
    );
  }

  const tier = scanTier(row.scanned_pct);
  const greeters = `${row.greeters_logged} greeter${row.greeters_logged === 1 ? "" : "s"} logged`;
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-bold ${CAPTURE_TIER_CLASSES[tier]}`}
      title={`${row.scanned_wash_sales.toLocaleString()} of ${row.scannable_wash_sales.toLocaleString()} scannable cars · ${(row.site_wash_sales ?? 0).toLocaleString()} wash sales less ${(row.house_accounts ?? 0).toLocaleString()} house / ${(row.rewashes ?? 0).toLocaleString()} rewash · ${greeters}`}
    >
      {pct(row.scanned_pct)}
    </span>
  );
}

interface UnderreportedRow {
  location_id: number;
  site_number: number;
  location_code: string;
  /**
   * The DENOMINATOR: wash sales less house accounts less rewashes, already
   * floored at 0 by greeter_scan_rates(). Gross wash sales is deliberately not
   * carried here — nothing in this panel divides by it, and keeping a second,
   * larger total in the row is how the wrong one ends up in the division.
   */
  scannable_wash_sales: number;
  scanned_wash_sales: number;
  days: number;
  scanned_pct: number;
}

/**
 * Collapse a window of site-days into one row per location, keeping only those
 * under the target.
 *
 * Weighted, not averaged: summed numerator over summed denominator. Averaging
 * the daily percentages would let a single 4-car Tuesday at 0% drag a site's
 * week down as hard as a 400-car Saturday.
 *
 * THREE kinds of day are dropped, all for the same reason — they are a
 * different question, and mixing them in would bury the sites that are actually
 * scanning badly:
 *
 *   greeters_logged === 0        Nobody logged a greeter day. That is a missing
 *                                submission, not a scanning failure, and it
 *                                belongs to the "No submissions" panel above.
 *   !ever_submitted              The location has never logged a greeter day at
 *                                all — not onboarded rather than slipping.
 *   scannable_wash_sales <= 0    Nothing was sold that a card COULD have been
 *                                scanned for, so neither side of the ratio has
 *                                anything to contribute. Note this now also
 *                                drops a day whose entire wash-sale count was
 *                                house accounts and rewashes — correctly, since
 *                                grading a greeter on cars nobody could scan is
 *                                the exact failure this deduction exists to fix.
 */
function summarizeUnderreported(rows: ScanRateRow[]): UnderreportedRow[] {
  const byLocation = new Map<number, UnderreportedRow>();

  for (const r of rows) {
    if (!r.ever_submitted) continue;
    if (r.greeters_logged === 0) continue;
    const scannable = r.scannable_wash_sales;
    if (scannable <= 0) continue;

    const existing = byLocation.get(r.location_id);
    if (existing) {
      existing.scannable_wash_sales += scannable;
      existing.scanned_wash_sales += r.scanned_wash_sales;
      existing.days += 1;
    } else {
      byLocation.set(r.location_id, {
        location_id: r.location_id,
        site_number: r.site_number,
        location_code: r.location_code,
        scannable_wash_sales: scannable,
        scanned_wash_sales: r.scanned_wash_sales,
        days: 1,
        scanned_pct: 0
      });
    }
  }

  const out: UnderreportedRow[] = [];
  for (const row of byLocation.values()) {
    row.scanned_pct =
      Math.round((row.scanned_wash_sales * 1000) / row.scannable_wash_sales) /
      10;
    if (row.scanned_pct < SCAN_TARGET_PCT) out.push(row);
  }
  // Worst first — the point of the panel is what to chase today.
  return out.sort((a, b) => a.scanned_pct - b.scanned_pct);
}

/**
 * Standing watchlist of sites whose greeters aren't scanning most of what the
 * site sold. Ignores the page's filters on purpose: it answers "who needs a
 * nudge right now", which shouldn't change because someone narrowed the table
 * below it to one location.
 */
function UnderreportedPanel({
  rows,
  dateFrom,
  dateTo
}: {
  rows: UnderreportedRow[];
  dateFrom: string;
  dateTo: string;
}) {
  const range = `${dateFrom} to ${dateTo}`;

  if (rows.length === 0) {
    return (
      <div className="mb-5 rounded-splash-lg border border-splash-success/40 bg-splash-success/10 px-5 py-4">
        <h2 className="text-sm font-bold text-splash-success">
          No underreported locations
        </h2>
        <p className="mt-1 text-xs text-splash-navy/70">
          Every location that logged greeter days scanned at least{" "}
          {SCAN_TARGET_PCT}% of its scannable cars over {range}. Days with no
          submission at all are counted in the panel above, not here.
        </p>
      </div>
    );
  }

  return (
    <div className="mb-5 overflow-hidden rounded-splash-lg border border-splash-deny/40 bg-splash-deny/5 shadow-splash-card">
      <div className="border-b border-splash-deny/20 px-5 py-4">
        <h2 className="text-sm font-bold text-splash-deny">
          Underreported · {rows.length} location{rows.length === 1 ? "" : "s"}{" "}
          under {SCAN_TARGET_PCT}%
        </h2>
        <p className="mt-1 text-xs text-splash-navy/70">
          Last 7 days ({range}). Share of each site&rsquo;s SCANNABLE cars that a
          greeter scanned for &mdash; wash sales less house accounts and rewashes,
          neither of which anyone can scan a card for &mdash; counting only days
          somebody actually logged. A low number means cars went unattributed, so
          every per-greeter figure for those days is understated. Days with no
          submission are a different problem and are listed separately above.
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-light text-sm">
          <thead className={THEAD_CLS}>
            <tr>
              <th className="px-4 py-2.5">Site</th>
              <th className="px-4 py-2.5">Scanned %</th>
              <th className="px-4 py-2.5">Scanned</th>
              <th className="px-4 py-2.5">Scannable</th>
              <th className="px-4 py-2.5">Days</th>
            </tr>
          </thead>
          <tbody className={TBODY_CLS}>
            {rows.map((r) => (
              <tr key={r.location_id}>
                <td className="px-4 py-2.5 text-splash-navy/80">
                  <div className="font-semibold">{r.location_code}</div>
                  <div className="font-mono text-xs text-splash-navy/60">
                    {r.site_number}
                  </div>
                </td>
                <td className="px-4 py-2.5">
                  <span
                    className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-bold ${CAPTURE_TIER_CLASSES[scanTier(r.scanned_pct)]}`}
                  >
                    {pct(r.scanned_pct)}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-splash-navy/80">
                  {num(r.scanned_wash_sales)}
                </td>
                <td className="px-4 py-2.5 text-splash-navy/80">
                  {num(r.scannable_wash_sales)}
                </td>
                <td className="px-4 py-2.5 text-splash-navy/80">{r.days}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------
 * Missing submissions
 * ------------------------------------------------------------ */

interface MissingSummaryRow {
  location_id: number;
  site_number: number;
  location_code: string;
  /** Days with neither half logged. The site simply didn't report. */
  nothing: string[];
  /** Days with greeter rows but no site-wide row. */
  noSiteRow: string[];
  /** Days with a site-wide row but nobody's greeter day. */
  noGreeters: string[];
}

/** Total days with any gap — what the list is sorted and headlined by. */
function missingTotal(r: MissingSummaryRow): number {
  return r.nothing.length + r.noSiteRow.length + r.noGreeters.length;
}

/**
 * Collapse the gap rows into one line per location, keeping the three kinds of
 * gap apart because they land on different people: the site-wide numbers are
 * usually the manager's to enter, the greeter days are the crew's. A site
 * missing only greeter rows is a different conversation from one that reported
 * nothing at all.
 *
 * Dates are kept, not just counted — "three days missing" isn't actionable
 * without knowing which three.
 */
function summarizeMissing(rows: MissingDayRow[]): MissingSummaryRow[] {
  const byLocation = new Map<number, MissingSummaryRow>();

  for (const r of rows) {
    let entry = byLocation.get(r.location_id);
    if (!entry) {
      entry = {
        location_id: r.location_id,
        site_number: r.site_number,
        location_code: r.location_code,
        nothing: [],
        noSiteRow: [],
        noGreeters: []
      };
      byLocation.set(r.location_id, entry);
    }
    const greeterless = r.greeters_logged === 0;
    if (!r.has_site_row && greeterless) entry.nothing.push(r.business_date);
    else if (!r.has_site_row) entry.noSiteRow.push(r.business_date);
    else entry.noGreeters.push(r.business_date);
  }

  // Most gaps first — the point of the panel is who to chase.
  return [...byLocation.values()].sort(
    (a, b) => missingTotal(b) - missingTotal(a)
  );
}

/** "08-11, 08-12" — the year is redundant inside a seven-day window. */
function dayLabels(dates: string[]): string {
  return [...dates]
    .sort()
    .map((d) => d.slice(5))
    .join(", ");
}

/**
 * Locations that didn't submit at all on one or more days in the window.
 *
 * Split out of the underreported panel: a day with no submission has no scan
 * rate — greeter_scan_rates() is driven from location_daily, so a skipped day
 * is absent there rather than 0%, and folding no-shows into a percentage would
 * hide the sites that are genuinely scanning badly.
 *
 * The universe is locations that have submitted before. A site never onboarded
 * to the scorecard is silent here on purpose — that's an onboarding task, not a
 * missed day.
 */
function MissingSubmissionsPanel({
  rows,
  dateFrom,
  dateTo
}: {
  rows: MissingSummaryRow[];
  dateFrom: string;
  dateTo: string;
}) {
  const range = `${dateFrom} to ${dateTo}`;

  if (rows.length === 0) {
    return (
      <div className="mb-5 rounded-splash-lg border border-splash-success/40 bg-splash-success/10 px-5 py-4">
        <h2 className="text-sm font-bold text-splash-success">
          No missing submissions
        </h2>
        <p className="mt-1 text-xs text-splash-navy/70">
          Every location that uses the scorecard logged both its site-wide
          numbers and at least one greeter day, every day over {range}.
        </p>
      </div>
    );
  }

  return (
    <div className="mb-5 overflow-hidden rounded-splash-lg border border-yellow-300 bg-yellow-50 shadow-splash-card">
      <div className="border-b border-yellow-200 px-5 py-4">
        <h2 className="text-sm font-bold text-yellow-900">
          No submissions · {rows.length} location{rows.length === 1 ? "" : "s"}
        </h2>
        <p className="mt-1 text-xs text-splash-navy/70">
          Last 7 days ({range}). Days where the site-wide numbers, the greeter
          days, or both were never entered. Locations that have never used the
          scorecard aren&rsquo;t listed — that&rsquo;s an onboarding task, not a
          missed day.
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-light text-sm">
          <thead className={THEAD_CLS}>
            <tr>
              <th className="px-4 py-2.5">Site</th>
              <th className="px-4 py-2.5">Days missing</th>
              <th className="px-4 py-2.5">Nothing logged</th>
              <th className="px-4 py-2.5">No site-wide row</th>
              <th className="px-4 py-2.5">No greeter days</th>
            </tr>
          </thead>
          <tbody className={TBODY_CLS}>
            {rows.map((r) => (
              <tr key={r.location_id}>
                <td className="px-4 py-2.5 text-splash-navy/80">
                  <div className="font-semibold">{r.location_code}</div>
                  <div className="font-mono text-xs text-splash-navy/60">
                    {r.site_number}
                  </div>
                </td>
                <td className="px-4 py-2.5 font-bold text-splash-navy">
                  {missingTotal(r)}
                </td>
                <td className="px-4 py-2.5 font-mono text-xs text-splash-navy/70">
                  {r.nothing.length ? dayLabels(r.nothing) : "—"}
                </td>
                <td className="px-4 py-2.5 font-mono text-xs text-splash-navy/70">
                  {r.noSiteRow.length ? dayLabels(r.noSiteRow) : "—"}
                </td>
                <td className="px-4 py-2.5 font-mono text-xs text-splash-navy/70">
                  {r.noGreeters.length ? dayLabels(r.noGreeters) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * `scrollBox` IS OPT-IN AND MUST STAY THAT WAY. It caps the height so the
 * wrapper becomes its own scroll box in BOTH axes, which is the only thing the
 * `top-0` header cells and the `left-0` frozen columns can resolve against —
 * position: sticky pins to the nearest scrolling ancestor, and with the page as
 * the scroller the header simply scrolls away with everything else. It also
 * drags the horizontal scrollbar up from the bottom of a 400-row table, three
 * screens below wherever you are, to the bottom of the visible card.
 *
 * The default is off because the goal-windows and monthly-targets tables share
 * this helper: they are a handful of rows with nothing sticky in them, and a
 * height cap would give them a scrollbar and a clipped card for nothing.
 */
function TableWrap({
  children,
  scrollBox = false
}: {
  children: ReactNode;
  scrollBox?: boolean;
}) {
  return (
    <div className={scrollBox ? "max-h-[70vh] overflow-auto" : "overflow-x-auto"}>
      <table className="min-w-full divide-y divide-gray-light text-sm">
        {children}
      </table>
    </div>
  );
}

function EmptyNote({ children }: { children: ReactNode }) {
  return <p className="px-5 py-6 text-sm text-splash-navy/70">{children}</p>;
}

/**
 * "Voided", next to the date of a struck-out row.
 *
 * WHO struck it out is in the tooltip rather than the cell because the tables
 * are already at the width of the viewport, and the answer only matters when
 * somebody is asking. The badge itself has to be visible without hovering —
 * a row that is silently excluded from every report while still showing its
 * numbers is the worst of both.
 */
function VoidedBadge({ email }: { email: string | null }) {
  return (
    <span
      title={email ? `Voided by ${email}` : "Voided"}
      className="ml-2 rounded-splash-sm bg-splash-deny/10 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-splash-deny"
    >
      Voided
    </span>
  );
}

/**
 * A row's date cell, as the way into its Edit / Void chooser.
 *
 * IT HAS TO READ AS A CONTROL. Since the Actions column came off both tables
 * this link is the only route to Edit, Void and Restore, and an underline is
 * the only thing telling a reader the date is more than a date. Take the
 * underline off and the verbs are still there and still unreachable.
 *
 * `block`, so the whole width of a narrow frozen cell is the hit target rather
 * than the ten characters of the date itself.
 */
function RowActionsLink({
  href,
  label,
  children
}: {
  href: string;
  /** Spelled out per row: "Edit or void Jane on 2026-08-24". A screen reader
   *  hitting forty links called "2026-08-24" learns nothing from any of them. */
  label: string;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      title={label}
      aria-label={label}
      className="block text-splash-blue underline decoration-dotted underline-offset-2 transition-colors hover:text-splash-blue-dark"
    >
      {children}
    </Link>
  );
}

/**
 * The Edit / Void chooser itself: one row's actions, over the page.
 *
 * URL-DRIVEN, NOT CLIENT STATE, and that is what makes it possible at all here
 * — this page is a server component. The row's date cell links to
 * `?actions_day=<id>`, the page resolves that id out of the list it already
 * fetched, and Cancel is a link back to the filtered list. No useState, no
 * dialog element to open imperatively, and the back button closes it.
 *
 * THE BACKDROP IS A LINK, not a click handler, for the same reason.
 *
 * `fixed` rather than absolute: the tables live inside an overflow-auto scroll
 * box and an `overflow-hidden` card, either of which would clip an absolutely
 * positioned panel. Fixed elements escape both — but only while no ancestor
 * grows a `transform`, `filter` or `contain`, any of which silently turns this
 * back into an absolutely positioned box and hides it inside the table.
 */
function RowActionsModal({
  title,
  subtitle,
  closeHref,
  ...actions
}: {
  title: string;
  subtitle: string;
  /** The filtered list, for Cancel and for the backdrop. */
  closeHref: string;
  id: string;
  editHref: string;
  voided: boolean;
  voidAction: (formData: FormData) => Promise<RedirectResult>;
  restoreAction: (formData: FormData) => Promise<RedirectResult>;
  confirmText: string;
  returnTo: string;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <Link
        href={closeHref}
        aria-label="Close"
        className="absolute inset-0 bg-splash-navy/40"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative w-full max-w-[360px] rounded-splash-lg border border-gray-light bg-white p-5 shadow-splash-card"
      >
        <h3 className="text-sm font-bold text-splash-navy">{title}</h3>
        <p className="mt-1 text-xs text-splash-navy/60">{subtitle}</p>
        <div className="mt-4">
          <DayRowActions {...actions} />
        </div>
        <p className="mt-4 text-xs text-splash-navy/60">
          <Link
            href={closeHref}
            className="font-semibold text-splash-blue hover:text-splash-blue-dark"
          >
            Cancel
          </Link>{" "}
          — leaves the row as it is.
        </p>
      </div>
    </div>
  );
}

/**
 * Edit + Void, or Restore, for one day row.
 *
 * Shared by both tables because the two grains differ in nothing but which pair
 * of actions they post to — and two copies would be two places to forget the
 * hidden id. It renders inside RowActionsModal now rather than in a pinned
 * Actions cell, which changed where it sits and nothing else: the verbs, the
 * hidden id and the confirm are the same, and there is still exactly one
 * voiding path on this page.
 *
 * NO EDIT LINK ON A VOIDED ROW, on purpose. update-by-id in the db layer is
 * guarded with `.is("voided_at", null)`, so an edit posted for a struck-out row
 * comes back as a 404 with a message about a day that "may have been voided" —
 * technically correct and completely useless as an explanation. Restore first,
 * then edit, and the button order says so.
 *
 * The two verbs go through <RedirectForm> rather than a plain <form> for the
 * usual reason: a redirect() inside the action would cost ~20 seconds under
 * OpenNext with the row already written the whole time.
 */
function DayRowActions({
  id,
  editHref,
  voided,
  voidAction,
  restoreAction,
  confirmText,
  returnTo
}: {
  id: string;
  editHref: string;
  voided: boolean;
  voidAction: (formData: FormData) => Promise<RedirectResult>;
  restoreAction: (formData: FormData) => Promise<RedirectResult>;
  /** Spelled out per row — see RowActionButton for why restore gets none. */
  confirmText: string;
  /**
   * This page with its current filters, so a void or restore returns to the
   * rows the user was looking at.
   *
   * Load-bearing for RESTORE in particular: a struck-out row is only visible
   * when the table is showing voided days, which is itself a filter. Dropping
   * the query string would put the row back and then navigate away from the
   * only view it appears in, so the undo would look like it failed.
   */
  returnTo: string;
}) {
  return (
    <div className="flex items-center gap-2">
      {voided ? null : (
        <Link
          href={editHref}
          className="rounded-splash-sm border border-splash-blue/40 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-splash-blue transition-colors hover:bg-splash-blue/10"
        >
          Edit
        </Link>
      )}
      <RedirectForm action={voided ? restoreAction : voidAction}>
        <input type="hidden" name="id" value={id} />
        <input type="hidden" name="return_to" value={returnTo} />
        <RowActionButton
          label={voided ? "Restore" : "Void"}
          pendingLabel={voided ? "Restoring…" : "Voiding…"}
          tone={voided ? "quiet" : "deny"}
          confirmText={voided ? undefined : confirmText}
        />
      </RedirectForm>
    </div>
  );
}

/**
 * The way out of an edit without saving.
 *
 * A LINK, NOT A BUTTON, and deliberately outside the <form>: an edit is a URL,
 * so leaving one is a navigation. A button inside the form would be a submit by
 * default, and a type="button" one would need client state to do anything at all.
 * Points back at the filtered list, so cancelling returns to the rows the user
 * was looking at rather than to an unfiltered page.
 */
function CancelEditLink({ href }: { href: string }) {
  return (
    <p className="mt-4 text-xs text-splash-navy/60">
      <Link
        href={href}
        className="font-semibold text-splash-blue hover:text-splash-blue-dark"
      >
        Cancel
      </Link>{" "}
      — leaves the row as it is.
    </p>
  );
}

/**
 * An `?edit_day=` id that matches nothing in the current result set.
 *
 * SAID OUT LOUD RATHER THAN IGNORED. The id can miss for two ordinary reasons —
 * the page's filters exclude the row, or the link is stale because the day was
 * already voided and re-entered — and in both cases a silently absent form
 * looks like the Edit button is broken.
 */
function EditNotFoundNote({
  what,
  backHref
}: {
  what: string;
  backHref: string;
}) {
  return (
    <div className="mb-6 rounded-splash-md border border-splash-navy/20 bg-splash-navy/[0.03] p-4 text-sm text-splash-navy/80">
      That {what} isn&rsquo;t in the rows below, so there&rsquo;s nothing to
      edit. It may be outside the current date range or site filter, or the link
      may be out of date.{" "}
      <Link
        href={backHref}
        className="font-semibold text-splash-blue hover:text-splash-blue-dark"
      >
        Back to the list
      </Link>
      .
    </div>
  );
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
        href="/admin/greeters"
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
        href="/admin/greeters"
        className="text-xs font-semibold underline underline-offset-2 hover:text-splash-success/80"
      >
        Dismiss
      </Link>
    </div>
  );
}

/**
 * The report link is the only navigation between the two pages, so it lives in
 * the banner rather than buried beside a table — this page is the row-level
 * record and /admin/greeters/report is the graded, charted view of the same
 * rows. Both pages link to each other so neither is a dead end.
 *
 * CARRIES rd/rm ACROSS, and only those. The date range, site and greeter are
 * this page's query; the report has its own presets and would fight them. The
 * manager filter is not a query — it says whose sites you are responsible for,
 * and a Regional Director who narrowed to their region should not land on a
 * company-wide report because they clicked a link.
 */
function PageBanner({ mgrQs }: { mgrQs: string }) {
  const reportHref = mgrQs
    ? `/admin/greeters/report?${mgrQs.replace(/^&/, "")}`
    : "/admin/greeters/report";
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-sudsy-blue">
          Internal Tools
        </p>
        <h1 className="text-2xl font-bold text-splash-navy">Greeter Scorecard</h1>
      </div>
      <Link
        href={reportHref}
        className="text-sm font-semibold text-splash-blue hover:text-splash-blue-dark"
      >
        Report &amp; charts →
      </Link>
    </div>
  );
}
