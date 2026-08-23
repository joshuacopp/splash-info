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
//   6. Summary table (per-greeter rollup for the filtered range).
//   7. Daily rows table.
//   8. Site-wide day rows table, including Scanned %.
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
import type { GreeterGoalRow, VoidState } from "@splash/types/greeter";
import {
  createGoalAction,
  deleteGoalAction,
  restoreDayAction,
  restoreLocationDayAction,
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

  const actionError = firstParam(sp.action_error).trim() || null;
  const successKey = firstParam(sp.success).trim();
  const successBase = SUCCESS_COPY[successKey] ?? null;
  // Only the two goal outcomes carry a re-grading tail. Appending it to the
  // day banners would be meaningless — submitting a day doesn't re-stamp
  // anything — and the params are never set on those redirects anyway.
  const successMessage = successBase
    ? `${successBase}${restampTail(
        firstParam(sp.rg),
        firstParam(sp.rl),
        successKey
      )}`
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
  // Initialised rather than left null because fetchManagerRosters() never
  // throws or resolves null — a roster outage arrives here as EMPTY_ROSTERS, so
  // the dropdowns render empty and disabled instead of taking the page down or
  // needing a null check at every use.
  let rosters: ManagerRosters = EMPTY_ROSTERS;
  let fetchError: string | null = null;

  try {
    // Parallel: eight independent reads. Sequential awaits would multiply the
    // page's time-to-first-byte for no benefit.
    [
      days,
      rollup,
      locationDays,
      scanRates,
      watchRates,
      missingDays,
      goals,
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

  /** The current filters plus one edit key. Filters are preserved so cancelling
   *  an edit puts the user back on the list they were looking at. */
  function editHref(key: "edit_day" | "edit_location_day", id: string): string {
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

      {/* Summary */}
      <Card
        title="By greeter"
        subtitle="Totals for the filtered range. Capture % and D.O.B. are recomputed from the summed numbers, not averaged across days."
      >
        {rollupList.length === 0 ? (
          <EmptyNote>No greeter days match these filters.</EmptyNote>
        ) : (
          <TableWrap>
            <thead className={THEAD_CLS}>
              <tr>
                <th className="px-4 py-3">Greeter</th>
                <th className="px-4 py-3">Site</th>
                <th className="px-4 py-3">Days</th>
                <th className="px-4 py-3">Hours</th>
                <th className="px-4 py-3">Wash sales</th>
                <th className="px-4 py-3">WS / hr</th>
                <th className="px-4 py-3">Rewashes</th>
                <th className="px-4 py-3">Package $</th>
                <th className="px-4 py-3">Extras $</th>
                <th className="px-4 py-3">D.O.B.</th>
                <th className="px-4 py-3">Sign ups</th>
                <th className="px-4 py-3">Reacts</th>
                <th className="px-4 py-3">Reviews</th>
                <th className="px-4 py-3">Capture %</th>
              </tr>
            </thead>
            <tbody className={TBODY_CLS}>
              {rollupList.map((r) => (
                <tr key={`${r.beekeeper_user_id}-${r.site_number}`}>
                  <td className="px-4 py-3 font-semibold">{r.greeter_name}</td>
                  <td className="px-4 py-3 text-splash-navy/80">
                    <div>{r.location_code}</div>
                    <div className="font-mono text-xs text-splash-navy/60">
                      {r.site_number}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-splash-navy/80">
                    {r.days_logged}
                  </td>
                  {/* Only days with a shift window logged contribute here, so
                      this can be blank while Days is not. */}
                  <td className="px-4 py-3 text-splash-navy/80">
                    {hours(r.hours_worked)}
                  </td>
                  <td className="px-4 py-3 text-splash-navy/80">
                    {num(r.wash_sales)}
                  </td>
                  <td className="px-4 py-3 text-splash-navy/80">
                    {hours(r.wash_sales_per_hour)}
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
                  {/* Reactivations. Sits next to sign ups because that is where
                      a reader looks for it, NOT because it is part of the same
                      number — capture % counts sign ups only. */}
                  <td className="px-4 py-3 text-splash-navy/80">
                    {num(r.reactivations)}
                  </td>
                  {/* A count of reviews collected, not a rating. Summed and
                      shown; it grades nothing. */}
                  <td className="px-4 py-3 text-splash-navy/80">
                    {num(r.google_reviews)}
                  </td>
                  <td className="px-4 py-3">
                    <CaptureCell
                      value={r.capture_pct}
                      goal={r.capture_goal_pct}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Card>

      {/* Daily rows */}
      <Card title="Daily rows">
        {dayList.length === 0 ? (
          <EmptyNote>Nothing logged for these filters yet.</EmptyNote>
        ) : (
          <TableWrap>
            <thead className={THEAD_CLS}>
              <tr>
                <th className="px-4 py-3">Date</th>
                <th className="px-4 py-3">Greeter</th>
                <th className="px-4 py-3">Site</th>
                <th className="px-4 py-3">Shift</th>
                <th className="px-4 py-3">Hours</th>
                <th className="px-4 py-3">Wash sales</th>
                <th className="px-4 py-3">WS / hr</th>
                <th className="px-4 py-3">Rewashes</th>
                <th className="px-4 py-3">Package $</th>
                <th className="px-4 py-3">Extras $</th>
                <th className="px-4 py-3">D.O.B.</th>
                <th className="px-4 py-3">Sign ups</th>
                <th className="px-4 py-3">Reacts</th>
                <th className="px-4 py-3">Reviews</th>
                <th className="px-4 py-3">Capture %</th>
                <th className="px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody className={TBODY_CLS}>
              {dayList.map((r) => (
                // Tinted rather than faded for a voided row. `opacity` on the
                // <tr> would take the Restore button down with the numbers, and
                // that button is the only way back.
                <tr
                  key={r.id}
                  className={r.voided_at ? "bg-splash-deny/[0.04]" : undefined}
                >
                  <td className="px-4 py-3 font-mono text-xs text-splash-navy/80">
                    <span className={r.voided_at ? "line-through" : undefined}>
                      {r.business_date}
                    </span>
                    {r.voided_at ? (
                      <VoidedBadge email={r.voided_by_email} />
                    ) : null}
                  </td>
                  <td className="px-4 py-3 font-semibold">
                    {r.greeter_name ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-splash-navy/80">
                    <div>{r.location_code}</div>
                    <div className="font-mono text-xs text-splash-navy/60">
                      {r.site_number}
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-xs text-splash-navy/80">
                    {shiftCell(r.shift_start, r.shift_end)}
                  </td>
                  <td className="px-4 py-3 text-splash-navy/80">
                    {hours(r.hours_worked)}
                  </td>
                  <td className="px-4 py-3 text-splash-navy/80">
                    {num(r.wash_sales)}
                  </td>
                  <td className="px-4 py-3 text-splash-navy/80">
                    {hours(r.wash_sales_per_hour)}
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
                  {/* Reactivations. Sits next to sign ups because that is where
                      a reader looks for it, NOT because it is part of the same
                      number — capture % counts sign ups only. */}
                  <td className="px-4 py-3 text-splash-navy/80">
                    {num(r.reactivations)}
                  </td>
                  {/* A count of reviews collected, not a rating. Displayed and
                      nothing more. */}
                  <td className="px-4 py-3 text-splash-navy/80">
                    {num(r.google_reviews)}
                  </td>
                  <td className="px-4 py-3">
                    <CaptureCell
                      value={r.capture_pct}
                      goal={r.capture_goal_pct}
                    />
                  </td>
                  <td className="whitespace-nowrap px-4 py-3">
                    <DayRowActions
                      id={r.id}
                      editHref={editHref("edit_day", r.id)}
                      voided={r.voided_at !== null}
                      voidAction={voidDayAction}
                      restoreAction={restoreDayAction}
                      returnTo={returnPath}
                      // The missing-list clause is CONDITIONAL and says so.
                      // greeter_missing_days() flags a day only when the site
                      // has no live greeter rows left for it, so voiding one of
                      // three greeters changes nothing there. Stating it flatly
                      // would be a consequence the feature doesn't carry, and
                      // people stop reading confirms that overstate.
                      confirmText={`Void ${r.greeter_name}'s day at ${r.location_code} on ${r.business_date}?\n\nThe row is kept but struck out: it drops out of every report and rollup. If it was the last greeter logged for that site's day, the day goes back onto the missing-submissions list until someone logs it again. You can restore it from this table.`}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
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
          <TableWrap>
            <thead className={THEAD_CLS}>
              <tr>
                <th className="px-4 py-3">Date</th>
                <th className="px-4 py-3">Site</th>
                <th className="px-4 py-3">Total cars</th>
                <th className="px-4 py-3">Wash sales</th>
                <th className="px-4 py-3">Scanned %</th>
                {/* Both unscannable-car columns sit immediately right of the
                    rate they reduce, so the arithmetic is legible across the
                    row instead of needing an explanation. */}
                <th className="px-4 py-3">House acct</th>
                <th className="px-4 py-3">Rewashes</th>
                <th className="px-4 py-3">Package $</th>
                <th className="px-4 py-3">Extras $</th>
                <th className="px-4 py-3">D.O.B.</th>
                <th className="px-4 py-3">Sign ups</th>
                <th className="px-4 py-3">Reacts</th>
                <th className="px-4 py-3">Reviews</th>
                <th className="px-4 py-3">Cancels</th>
                <th className="px-4 py-3">Net</th>
                <th className="px-4 py-3">Members</th>
                <th className="px-4 py-3">Capture %</th>
                {/* Churn sits AFTER the graded pair on purpose. Put it beside
                    Members and the next person to touch this table will give it
                    a goal to match its neighbours; it has none, and shouldn't. */}
                <th className="px-4 py-3">Churn %</th>
                <th className="px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody className={TBODY_CLS}>
              {locationDayList.map((r) => (
                <tr
                  key={r.id}
                  className={r.voided_at ? "bg-splash-deny/[0.04]" : undefined}
                >
                  <td className="px-4 py-3 font-mono text-xs text-splash-navy/80">
                    <span className={r.voided_at ? "line-through" : undefined}>
                      {r.business_date}
                    </span>
                    {r.voided_at ? (
                      <VoidedBadge email={r.voided_by_email} />
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-splash-navy/80">
                    <div>{r.location_code}</div>
                    <div className="font-mono text-xs text-splash-navy/60">
                      {r.site_number}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-splash-navy/80">
                    {num(r.total_cars)}
                  </td>
                  <td className="px-4 py-3 text-splash-navy/80">
                    {num(r.wash_sales)}
                  </td>
                  <td className="px-4 py-3">
                    <ScanCell
                      row={scanByDay.get(`${r.business_date}|${r.location_id}`)}
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
                  {/* Reactivations. Sits next to sign ups because that is where
                      a reader looks for it, NOT because it is part of the same
                      number — capture % counts sign ups only. */}
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
                  {/* sign ups plus reactivations minus cancellations, computed
                      in Postgres. All three inputs are columns above. */}
                  <td className="px-4 py-3 text-splash-navy/80">
                    {num(r.net_members)}
                  </td>
                  {/* A level, not a daily amount — the member roll as of this
                      day, graded against the month-end goal. */}
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
                  {/* Self-reported, ungraded, and DAY-GRAIN ONLY. It appears
                      here and on the report's site-day table, and nowhere that
                      covers more than one day — the row carries no numerator or
                      denominator, so it can't be re-derived over a range, and a
                      flat average of daily percentages would be a lie. */}
                  <td className="px-4 py-3 text-splash-navy/80">
                    {pct(r.churn_pct)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3">
                    <DayRowActions
                      id={r.id}
                      editHref={editHref("edit_location_day", r.id)}
                      voided={r.voided_at !== null}
                      voidAction={voidLocationDayAction}
                      restoreAction={restoreLocationDayAction}
                      returnTo={returnPath}
                      confirmText={`Void the site-wide totals for ${r.location_code} on ${r.business_date}?\n\nThe row is kept but struck out: it drops out of every report, the Scanned % for that day loses its denominator, and the day goes back onto the missing-submissions list. The greeters' own rows for that day are NOT affected. You can restore it from this table.`}
                    />
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

function TableWrap({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
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
 * Edit + Void, or Restore, for one day row.
 *
 * Shared by both tables because the two grains differ in nothing but which pair
 * of actions they post to — and two copies would be two places to forget the
 * hidden id.
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
