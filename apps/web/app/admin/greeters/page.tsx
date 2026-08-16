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
//   5. Summary table (per-greeter rollup for the filtered range).
//   6. Daily rows table.
//   7. Site-wide day rows table, including Scanned %.
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
import { GreeterDayForm } from "./_components/GreeterDayForm";
import { LocationMetricFields } from "./_components/MetricFields";
import { SavingButton } from "./_components/SavingButton";
import { SubmitPanels } from "./_components/SubmitPanels";
import {
  createGoalAction,
  submitGreeterDayAction,
  submitLocationDayAction
} from "./actions";

/** Shape of the two `*_goal` snapshot columns, on every row of both tables. */
interface GoalSnapshot {
  capture_goal_pct: number | null;
  dob_goal: number | null;
}

interface DayRow extends GoalSnapshot {
  id: string;
  business_date: string;
  location_id: number;
  site_number: number;
  location_code: string;
  beekeeper_user_id?: string;
  greeter_name?: string;
  wash_sales: number | null;
  rewashes: number | null;
  package_dollars: number | null;
  extras_dollars: number | null;
  sign_ups: number | null;
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
interface LocationDayRow extends GoalSnapshot {
  id: string;
  business_date: string;
  location_id: number;
  site_number: number;
  location_code: string;
  total_cars: number | null;
  wash_sales: number | null;
  rewashes: number | null;
  package_dollars: number | null;
  extras_dollars: number | null;
  sign_ups: number | null;
  cancellations: number | null;
  /** Active members as of that day — a level. Never sum this across rows. */
  total_members: number | null;
  net_members: number | null;
  member_goal_month_end: number | null;
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

const SUCCESS_COPY: Record<string, string> = {
  day: "Greeter day saved.",
  location: "Site-wide day saved.",
  goal: "Goal window saved."
};

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

  const actionError = firstParam(sp.action_error).trim() || null;
  const successKey = firstParam(sp.success).trim();
  const successMessage = SUCCESS_COPY[successKey] ?? null;

  const qs = new URLSearchParams();
  if (dateFrom) qs.set("date_from", dateFrom);
  if (dateTo) qs.set("date_to", dateTo);
  if (locationIdNum !== undefined) qs.set("location_id", String(locationIdNum));
  if (greeter) qs.set("greeter", greeter);
  if (rd) qs.set("rd", rd);
  if (rm) qs.set("rm", rm);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";

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
  // Initialised rather than left null because fetchManagerRosters() never
  // throws or resolves null — a roster outage arrives here as EMPTY_ROSTERS, so
  // the dropdowns render empty and disabled instead of taking the page down or
  // needing a null check at every use.
  let rosters: ManagerRosters = EMPTY_ROSTERS;
  let fetchError: string | null = null;

  try {
    // Parallel: seven independent reads. Sequential awaits would multiply the
    // page's time-to-first-byte for no benefit.
    [days, rollup, locationDays, scanRates, watchRates, missingDays, rosters] =
      await Promise.all([
        performanceGetJson<DayRow[]>(`/pertrack/api/greeter/days${suffix}`),
        performanceGetJson<RollupRow[]>(`/pertrack/api/greeter/rollup${suffix}`),
        performanceGetJson<LocationDayRow[]>(
          `/pertrack/api/greeter/location-days${suffix}`
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
        fetchManagerRosters()
      ]);
  } catch (err) {
    fetchError =
      err instanceof Error ? err.message : "Unknown error loading the scorecard.";
  }

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
              <form
                action={submitLocationDayAction}
                className="flex flex-col gap-4"
              >
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
              </form>
            )
          },
          {
            key: "goal",
            label: "Set goals for a site",
            title: "Set goals for a site",
            description:
              "Goals apply to a location for a date range and are copied onto each day as it's logged — changing them later won't re-grade days already submitted. Leave the end date blank for an open-ended goal. Ranges for one site can't overlap.",
            form: (
              <form action={createGoalAction} className="flex flex-col gap-4">
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
              </form>
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
                <th className="px-4 py-3">Capture %</th>
              </tr>
            </thead>
            <tbody className={TBODY_CLS}>
              {dayList.map((r) => (
                <tr key={r.id}>
                  <td className="px-4 py-3 font-mono text-xs text-splash-navy/80">
                    {r.business_date}
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
                <th className="px-4 py-3">Rewashes</th>
                <th className="px-4 py-3">Package $</th>
                <th className="px-4 py-3">Extras $</th>
                <th className="px-4 py-3">D.O.B.</th>
                <th className="px-4 py-3">Sign ups</th>
                <th className="px-4 py-3">Cancels</th>
                <th className="px-4 py-3">Net</th>
                <th className="px-4 py-3">Members</th>
                <th className="px-4 py-3">Capture %</th>
              </tr>
            </thead>
            <tbody className={TBODY_CLS}>
              {locationDayList.map((r) => (
                <tr key={r.id}>
                  <td className="px-4 py-3 font-mono text-xs text-splash-navy/80">
                    {r.business_date}
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
                  <td className="px-4 py-3 text-splash-navy/80">
                    {num(r.cancellations)}
                  </td>
                  {/* sign ups minus cancellations, computed in Postgres. */}
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
      title={`${row.scanned_wash_sales.toLocaleString()} of ${(row.site_wash_sales ?? 0).toLocaleString()} wash sales scanned · ${greeters}`}
    >
      {pct(row.scanned_pct)}
    </span>
  );
}

interface UnderreportedRow {
  location_id: number;
  site_number: number;
  location_code: string;
  site_wash_sales: number;
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
 *   greeters_logged === 0   Nobody logged a greeter day. That is a missing
 *                           submission, not a scanning failure, and it belongs
 *                           to the "No submissions" panel above.
 *   !ever_submitted         The location has never logged a greeter day at all
 *                           — not onboarded rather than slipping.
 *   site_wash_sales <= 0    No a-a-la-carte cars sold, so neither side of the
 *                           ratio has anything to contribute.
 */
function summarizeUnderreported(rows: ScanRateRow[]): UnderreportedRow[] {
  const byLocation = new Map<number, UnderreportedRow>();

  for (const r of rows) {
    if (!r.ever_submitted) continue;
    if (r.greeters_logged === 0) continue;
    const site = r.site_wash_sales ?? 0;
    if (site <= 0) continue;

    const existing = byLocation.get(r.location_id);
    if (existing) {
      existing.site_wash_sales += site;
      existing.scanned_wash_sales += r.scanned_wash_sales;
      existing.days += 1;
    } else {
      byLocation.set(r.location_id, {
        location_id: r.location_id,
        site_number: r.site_number,
        location_code: r.location_code,
        site_wash_sales: site,
        scanned_wash_sales: r.scanned_wash_sales,
        days: 1,
        scanned_pct: 0
      });
    }
  }

  const out: UnderreportedRow[] = [];
  for (const row of byLocation.values()) {
    row.scanned_pct =
      Math.round((row.scanned_wash_sales * 1000) / row.site_wash_sales) / 10;
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
          {SCAN_TARGET_PCT}% of its wash sales over {range}. Days with no
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
          Last 7 days ({range}). Share of each site&rsquo;s wash sales that a
          greeter scanned for, counting only days somebody actually logged. A low
          number means cars went unattributed, so every per-greeter figure for
          those days is understated. Days with no submission are a different
          problem and are listed separately above.
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-light text-sm">
          <thead className={THEAD_CLS}>
            <tr>
              <th className="px-4 py-2.5">Site</th>
              <th className="px-4 py-2.5">Scanned %</th>
              <th className="px-4 py-2.5">Scanned</th>
              <th className="px-4 py-2.5">Site wash sales</th>
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
                  {num(r.site_wash_sales)}
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
