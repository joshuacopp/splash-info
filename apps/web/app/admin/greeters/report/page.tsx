// Greeter report (/admin/greeters/report).
//
// The read-only companion to /admin/greeters. That page is where numbers go in
// and where a single day gets checked; this is where a period gets read — four
// quick-filter buttons over the same two queries, an executive strip at the top,
// and drill-through from the company down to one greeter's day.
//
// Layout, top to bottom:
//   1. Preset buttons + filter bar (dates, location, greeter name).
//   2. KPI tiles with prior-period deltas.
//   3. Charts: capture trend, D.O.B. trend, site ranking, volume-vs-capture.
//   4. The view's table — greeters for three presets, sites for morning call.
//   5. Drill-through card, when a site or a greeter is selected.
//
// EVERYTHING IS IN THE URL. Presets, filters, and both drill-through selections
// are query parameters, so any state a manager reaches can be pasted into a
// message and opened by somebody else to exactly the same screen. Nothing here
// is a client component and there is no local state to lose.
//
// TWO QUERIES SERVE ALL FOUR PRESETS. greeter_period_report() and
// location_period_rows() return the whole window ungraded by any cut-off; the
// "top performers" and "underperformers" thresholds are applied here, in the
// page. That's deliberate — it means the row counts across views reconcile, and
// a fifth button costs no migration.
//
// LOW-SAMPLE GREETERS ARE NEVER DROPPED. A greeter with fewer than five graded
// days carries `low_sample` from Postgres, sorts to the BOTTOM of every list,
// and is labelled. Excluding them would hide exactly the people whose numbers
// nobody is watching; letting them top a list on a two-day sample would be
// noise. Both failures are avoided by sorting rather than filtering.
//
// WEIGHTING: every rate on this page is recomputed from summed numerators and
// denominators — see _lib/aggregate. Do not average a percentage column.
//
// Auth posture: performanceGetJson collapses 401/403 to null -> no-access card,
// same as /admin/greeters. Location scoping happens worker-side.

import { Fragment, type ReactNode } from "react";
import Link from "next/link";
import type {
  GreeterPeriodReportRow,
  LocationPeriodRow
} from "@splash/types/greeter";
import { performanceGetJson } from "../../performance/_lib/worker-fetch";
import { LocationPicker } from "../../performance/_components/LocationPicker";
import {
  DAY_MS,
  dayLabel,
  dobCell,
  firstParam,
  goalNum,
  hours,
  localDay,
  money,
  num,
  pct
} from "../_lib/format";
import {
  CAPTURE_TIER_CLASSES,
  CaptureCell,
  CaptureLegend,
  captureTier,
  dobTier,
  SCAN_TARGET_PCT,
  scanTier
} from "../_lib/grading";
import {
  ChartFrame,
  RankBars,
  TrendChart,
  VolumeScatter,
  type RankRow,
  type ScatterPoint,
  type TrendPoint
} from "./_components/Charts";
import {
  bySite,
  byDay,
  daysForSite,
  delta,
  totals,
  type DayTotals,
  type SiteTotals,
  type Totals
} from "./_lib/aggregate";
import {
  isoAdd,
  isoOrEmpty,
  isoSpan,
  LOW_SAMPLE_DAYS,
  normalizeView,
  PRESETS,
  priorWindow,
  TOP_PCT_OVER,
  UNDER_PCT_UNDER,
  VIEW_ORDER,
  type ViewKey
} from "./_lib/presets";

/** A greeter's individual days, for the deepest level of the drill-through. */
interface GreeterDayRow {
  id: string;
  business_date: string;
  location_code: string;
  site_number: number;
  greeter_name?: string;
  wash_sales: number | null;
  rewashes: number | null;
  package_dollars: number | null;
  extras_dollars: number | null;
  sign_ups: number | null;
  hours_worked: number | null;
  wash_sales_per_hour: number | null;
  capture_pct: number | null;
  dob: number | null;
  capture_goal_pct: number | null;
  dob_goal: number | null;
  comments: string | null;
}

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

export default async function GreeterReportPage({ searchParams }: PageProps) {
  const sp = await searchParams;

  const view = normalizeView(firstParam(sp.view).trim());
  const preset = PRESETS[view];

  // The window. An explicit date beats the preset's default, so a manager can
  // keep the "underperformers" threshold while changing the range — the preset
  // is a threshold plus a starting range, not a lock.
  //
  // Defaults END YESTERDAY. A day is logged after it's over, so including today
  // would put a half-entered (or not-yet-entered) day into every average and
  // drag the whole company's capture rate down every morning.
  const nowMs = Date.now();
  const rawTo = isoOrEmpty(firstParam(sp.date_to).trim()) || localDay(nowMs - DAY_MS);
  const rawFrom =
    isoOrEmpty(firstParam(sp.date_from).trim()) ||
    localDay(nowMs - preset.days * DAY_MS);

  // A reversed range is a typo, not an error worth a full-page failure: every
  // endpoint 400s on date_to < date_from, and performanceGetJson throws on a
  // 400, so the whole report would collapse into "could not load" because
  // someone picked the end date first. ISO dates compare correctly as strings.
  const [dateFrom, dateTo]: [string, string] =
    rawFrom <= rawTo ? [rawFrom, rawTo] : [rawTo, rawFrom];
  const spanDays = isoSpan(dateFrom, dateTo);
  const prior = priorWindow(dateFrom, dateTo);

  const locationIdRaw = firstParam(sp.location_id).trim();
  const locationIdNum = /^\d+$/.test(locationIdRaw)
    ? Number.parseInt(locationIdRaw, 10)
    : undefined;
  const greeter = firstParam(sp.greeter).trim();

  // Drill-through selections.
  const siteRaw = firstParam(sp.site).trim();
  const selectedSite = /^\d+$/.test(siteRaw) ? Number.parseInt(siteRaw, 10) : null;
  const selectedPerson = firstParam(sp.person).trim() || null;

  const base = new URLSearchParams();
  base.set("view", view);
  base.set("date_from", dateFrom);
  base.set("date_to", dateTo);
  if (locationIdNum !== undefined) base.set("location_id", String(locationIdNum));
  if (greeter) base.set("greeter", greeter);

  /** Current URL with some params changed; "" removes a param. */
  const link = (patch: Record<string, string>) => {
    const qs = new URLSearchParams(base);
    if (selectedSite !== null) qs.set("site", String(selectedSite));
    if (selectedPerson) qs.set("person", selectedPerson);
    for (const [k, v] of Object.entries(patch)) {
      if (v === "") qs.delete(k);
      else qs.set(k, v);
    }
    return `/admin/greeters/report?${qs.toString()}`;
  };

  const windowQs = `date_from=${dateFrom}&date_to=${dateTo}`;
  const locQs = locationIdNum === undefined ? "" : `&location_id=${locationIdNum}`;
  const priorQs = `date_from=${prior.date_from}&date_to=${prior.date_to}`;

  let siteRows: LocationPeriodRow[] | null = null;
  let priorRows: LocationPeriodRow[] | null = null;
  let greeterRows: GreeterPeriodReportRow[] | null = null;
  let missingRows: MissingDayRow[] | null = null;
  let personDays: GreeterDayRow[] | null = null;
  let fetchError: string | null = null;

  try {
    // Parallel: five independent reads. The last one is skipped entirely unless
    // a greeter is actually drilled into.
    [siteRows, priorRows, greeterRows, missingRows, personDays] =
      await Promise.all([
        performanceGetJson<LocationPeriodRow[]>(
          `/pertrack/api/greeter/location-rows?${windowQs}${locQs}`
        ),
        performanceGetJson<LocationPeriodRow[]>(
          `/pertrack/api/greeter/location-rows?${priorQs}${locQs}`
        ),
        performanceGetJson<GreeterPeriodReportRow[]>(
          `/pertrack/api/greeter/period-report?${windowQs}${locQs}${
            greeter ? `&greeter=${encodeURIComponent(greeter)}` : ""
          }`
        ),
        performanceGetJson<MissingDayRow[]>(
          `/pertrack/api/greeter/missing-days?${windowQs}${locQs}`
        ),
        selectedPerson
          ? performanceGetJson<GreeterDayRow[]>(
              `/pertrack/api/greeter/days?${windowQs}&beekeeper_user_id=${encodeURIComponent(
                selectedPerson
              )}`
            )
          : Promise.resolve(null)
      ]);
  } catch (err) {
    fetchError =
      err instanceof Error ? err.message : "Unknown error loading the report.";
  }

  if (siteRows === null && !fetchError) {
    return (
      <section className="mx-auto w-full max-w-[1200px] px-5 py-9">
        <ReportBanner />
        <div className="rounded-splash-lg border border-gray-light bg-white p-6 shadow-splash-card">
          <p className="mb-4 text-splash-deny">
            You don&rsquo;t have access to the greeter scorecard. Contact your
            administrator if this is unexpected.
          </p>
          <Link
            href={`/login?return=${encodeURIComponent("/admin/greeters/report")}`}
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
        <ReportBanner />
        <div className="rounded-splash-lg border border-gray-light bg-white p-6 shadow-splash-card">
          <h2 className="mb-2 text-lg font-bold text-splash-deny">
            Could not load the report
          </h2>
          <p className="text-sm text-splash-navy/80">{fetchError}</p>
          <p className="mt-2 text-sm text-splash-navy/60">
            Reload the page to retry. If this persists, the report SQL functions
            may not be installed yet.
          </p>
        </div>
      </section>
    );
  }

  const siteList = siteRows ?? [];
  const now = totals(siteList);
  const before = totals(priorRows ?? []);
  const sites = bySite(siteList);
  const days = byDay(siteList);
  const windowDays = fillWindow(days, dateFrom, dateTo);
  const missingCount = (missingRows ?? []).length;

  // Unfiltered, for the scatter — see the note at its call site.
  const allGreeters = sortGreeters(greeterRows ?? [], view);
  const graded = applyPreset(greeterRows ?? [], view);
  const ordered = sortGreeters(graded, view);
  const lowSampleCount = ordered.filter((r) => r.low_sample).length;

  // Hoisted: a `.length > 0` check doesn't narrow personDays[0] away from
  // undefined under noUncheckedIndexedAccess, but a nullable const does.
  const firstPersonDay = personDays?.[0] ?? null;

  // Worst capture first — the morning call exists to decide who gets a phone
  // call today, so the top of the list has to be the reason to make one.
  const sitesWorstFirst = [...sites].sort((a, b) => {
    const av = a.capture_pct;
    const bv = b.capture_pct;
    if (av === null && bv === null) return a.location_code.localeCompare(b.location_code);
    if (av === null) return 1;
    if (bv === null) return -1;
    return av - bv;
  });

  const selectedSiteRow =
    selectedSite === null
      ? null
      : (sites.find((s) => s.location_id === selectedSite) ?? null);

  // Label for the filter's LocationPicker on round-trip. Derived from a row in
  // the result set; falls back to the raw id when the filter matched nothing.
  let filterLocationLabel: string | undefined;
  if (locationIdNum !== undefined) {
    const match = siteList.find((r) => r.location_id === locationIdNum);
    filterLocationLabel = match
      ? `${match.location_code} · ${match.site_number}`
      : `ID ${locationIdNum}`;
  }

  return (
    <section className="mx-auto w-full max-w-[1200px] px-5 py-9">
      <ReportBanner />

      {/* Presets */}
      <div className="mb-4 flex flex-wrap gap-2">
        {VIEW_ORDER.map((k) => {
          const p = PRESETS[k];
          const active = k === view;
          // Switching preset resets the window to that preset's default and
          // drops both drill-through selections — a site expanded in the
          // morning call is meaningless once you're looking at 60 days of
          // greeters, and carrying it over would silently filter the new view.
          const qs = new URLSearchParams();
          qs.set("view", k);
          if (locationIdNum !== undefined) {
            qs.set("location_id", String(locationIdNum));
          }
          if (greeter) qs.set("greeter", greeter);
          return (
            <Link
              key={k}
              href={`/admin/greeters/report?${qs.toString()}`}
              className={
                active
                  ? "rounded-splash-sm bg-splash-blue px-4 py-2 text-sm font-bold text-white shadow-splash-btn"
                  : "rounded-splash-sm border border-gray-light bg-white px-4 py-2 text-sm font-semibold text-splash-navy transition-colors hover:border-splash-blue hover:text-splash-blue"
              }
            >
              {p.label}
            </Link>
          );
        })}
      </div>

      <p className="mb-5 text-xs text-splash-navy/70">
        {preset.blurb}{" "}
        <span className="font-semibold text-splash-navy">
          Showing {dateFrom} to {dateTo} ({spanDays} days).
        </span>
      </p>

      {/* Filter bar. Overrides the preset's window without losing its threshold. */}
      <form
        method="GET"
        action="/admin/greeters/report"
        className="mb-6 rounded-splash-lg border border-gray-light bg-white p-5 shadow-splash-card"
      >
        <input type="hidden" name="view" value={view} />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
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
            <span className="text-[11px] text-splash-navy/60">
              Filters the greeter tables only. Site figures stay whole.
            </span>
          </label>
        </div>
        <div className="mt-4 flex items-center gap-3">
          <button type="submit" className={BTN_CLS}>
            Apply filters
          </button>
          <Link
            href={`/admin/greeters/report?view=${view}`}
            className="text-sm font-semibold text-splash-blue hover:text-splash-blue-dark"
          >
            Reset to preset
          </Link>
        </div>
      </form>

      {/* KPI strip */}
      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi
          label="Capture rate"
          value={pct(now.capture_pct)}
          goal={
            now.capture_goal_pct === null
              ? null
              : `${goalNum(now.capture_goal_pct)}% goal`
          }
          delta={delta(now.capture_pct, before.capture_pct)}
          deltaUnit="pts"
          tone={toneFor(now.capture_pct, now.capture_goal_pct)}
          foot={`${num(now.sign_ups)} sign ups on ${num(now.wash_sales)} wash sales`}
        />
        <Kpi
          label="D.O.B."
          value={dobCell(now.dob)}
          goal={now.dob_goal === null ? null : `$${goalNum(now.dob_goal)} goal`}
          delta={delta(now.dob, before.dob)}
          deltaUnit="$"
          // dobTier, not toneFor: the capture band is three percentage POINTS,
          // and subtracting 3 from a $4 goal would paint a $1.05 D.O.B. amber.
          tone={
            now.dob === null || now.dob_goal === null
              ? null
              : dobTier(now.dob, now.dob_goal)
          }
          foot={`${money(now.package_dollars + now.extras_dollars)} of packages and extras`}
        />
        <Kpi
          label="Net members"
          value={num(now.net_members)}
          goal={
            now.total_members === null
              ? null
              : `${num(now.total_members)} on the books`
          }
          // net_members is a plain number, so an empty prior window totals to 0
          // and the delta would render this window's entire growth as if it
          // beat a real prior period. No prior days means no comparison.
          delta={before.days === 0 ? null : delta(now.net_members, before.net_members)}
          deltaUnit=""
          tone={now.net_members >= 0 ? "hit" : "miss"}
          foot={`${num(now.sign_ups)} sign ups less ${num(now.cancellations)} cancellations`}
        />
        {/* Data confidence, not a sales figure. It's a tile because every
            number to its left is only as good as this one: unscanned cars and
            unreported days both understate the greeters they belong to. */}
        <Kpi
          label="Data confidence"
          value={pct(now.scanned_pct)}
          goal={`${SCAN_TARGET_PCT}% scanned`}
          delta={delta(now.scanned_pct, before.scanned_pct)}
          deltaUnit="pts"
          tone={now.scanned_pct === null ? null : scanTier(now.scanned_pct)}
          foot={
            missingCount === 0
              ? "Every site reported every day."
              : `${missingCount} site-day${missingCount === 1 ? "" : "s"} with a missing submission`
          }
        />
      </div>

      <p className="mb-6 text-[11px] text-splash-navy/60">
        Deltas compare against {prior.date_from} to {prior.date_to} — the same
        number of days immediately before this window, so the weekday mix
        matches. Rates are recomputed from the summed numbers, never averaged
        across days.
      </p>

      {/* Charts */}
      <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartFrame
          title="Capture rate by day"
          caption="Company-wide, weighted by volume. The line breaks on days with no wash sales, and on days nobody reported, rather than being drawn through them."
        >
          <TrendChart
            points={trendPoints(windowDays, (d) => d.capture_pct, (d) =>
              `${num(d.sign_ups)} sign ups / ${num(d.wash_sales)} wash sales`
            )}
            goal={now.capture_goal_pct}
            unit="pct"
          />
        </ChartFrame>

        <ChartFrame
          title="D.O.B. by day"
          caption="Package and extras dollars per wash sale, company-wide."
        >
          <TrendChart
            points={trendPoints(windowDays, (d) => d.dob, (d) =>
              `${money(d.package_dollars + d.extras_dollars)} over ${num(d.wash_sales)} wash sales`
            )}
            goal={now.dob_goal}
            unit="money"
            colour="#3dbeee"
          />
        </ChartFrame>
      </div>

      <div className="mb-6 grid grid-cols-1 gap-4">
        <ChartFrame
          title="Capture rate by site"
          caption="Worst first. The vertical mark on each bar is that site's own goal — goal windows are per site, so a single shared line would grade everyone against whichever site came first. Click a bar to open the site."
        >
          <RankBars rows={rankRows(sitesWorstFirst, selectedSite, link)} unit="pct" />
        </ChartFrame>

        <ChartFrame
          title="Volume against capture rate"
          caption={`Each dot is one greeter for the period: wash sales across, capture rate up. Dots on the left are working small numbers — a low rate there is arithmetic, not performance. Hollow dots have fewer than ${LOW_SAMPLE_DAYS} graded days. Click a dot to open the greeter.`}
        >
          {/* EVERY greeter, not the preset's filtered set. The whole point of
              this chart is to separate "low capture because they're bad" from
              "low capture on nine cars", and on Top performers the filtered set
              contains nobody below the line to make that judgement about. */}
          <VolumeScatter
            points={scatterPoints(allGreeters, link)}
            goal={now.capture_goal_pct}
          />
        </ChartFrame>
      </div>

      <CaptureLegend />

      {/* The view's own table */}
      {preset.kind === "site" ? (
        <MorningCall
          sites={sitesWorstFirst}
          allRows={siteList}
          selectedSite={selectedSite}
          link={link}
        />
      ) : (
        <GreeterTable
          rows={ordered}
          view={view}
          lowSampleCount={lowSampleCount}
          selectedPerson={selectedPerson}
          link={link}
        />
      )}

      {/* Drill-through: one site's days, reachable from the ranking chart even
          when the greeter tables are showing. */}
      {preset.kind !== "site" && selectedSiteRow ? (
        <Card
          title={`${selectedSiteRow.location_code} · site ${selectedSiteRow.site_number}`}
          subtitle={`Every day in the window for this site. ${spanDays} days requested, ${selectedSiteRow.days} reported.`}
          action={{ href: link({ site: "" }), label: "Clear site" }}
        >
          <SiteDayTable rows={daysForSite(siteList, selectedSiteRow.location_id)} />
        </Card>
      ) : null}

      {/* Drill-through: one greeter's days. */}
      {selectedPerson ? (
        <Card
          title={
            firstPersonDay
              ? `${firstPersonDay.greeter_name ?? "Greeter"} · day by day`
              : "Greeter · day by day"
          }
          subtitle="Every shift this greeter logged inside the window, in date order."
          action={{ href: link({ person: "" }), label: "Clear greeter" }}
        >
          {!personDays || personDays.length === 0 ? (
            <EmptyNote>
              No days logged for this greeter inside {dateFrom} to {dateTo}.
            </EmptyNote>
          ) : (
            <PersonDayTable rows={personDays} />
          )}
        </Card>
      ) : null}
    </section>
  );
}

/* ============================================================
 * Preset filtering and ordering
 * ============================================================ */

/**
 * The threshold half of a preset.
 *
 * Rows with a null percentage (no graded days at all — every day either had no
 * wash sales or fell outside a goal window) are excluded from the two
 * threshold views. They can't be over or under a goal that never applied, and
 * putting them in either list would be an accusation the data can't support.
 * They still appear in "previous 7 days", flagged as low sample.
 */
function applyPreset(
  rows: GreeterPeriodReportRow[],
  view: ViewKey
): GreeterPeriodReportRow[] {
  if (view === "top") {
    return rows.filter(
      (r) => r.pct_days_over !== null && r.pct_days_over > TOP_PCT_OVER
    );
  }
  if (view === "under") {
    return rows.filter(
      (r) => r.pct_days_under !== null && r.pct_days_under > UNDER_PCT_UNDER
    );
  }
  return rows;
}

/**
 * Two-tier sort: everyone with a real sample first, low-sample greeters after.
 *
 * This is the whole low-sample rule. A greeter who beat goal on both of the two
 * days they worked would otherwise sit at 100% on top of the top-performers
 * list, above someone who did it 40 times out of 50. Sorting them below —
 * rather than filtering them out — keeps them visible and honest.
 */
function sortGreeters(
  rows: GreeterPeriodReportRow[],
  view: ViewKey
): GreeterPeriodReportRow[] {
  const key = (r: GreeterPeriodReportRow) =>
    (view === "under" ? r.pct_days_under : r.pct_days_over) ?? -1;
  return [...rows].sort((a, b) => {
    if (a.low_sample !== b.low_sample) return a.low_sample ? 1 : -1;
    const diff = key(b) - key(a);
    if (diff !== 0) return diff;
    return a.greeter_name.localeCompare(b.greeter_name);
  });
}

/* ============================================================
 * Chart data shaping
 * ============================================================ */

/**
 * Every calendar day in the window, whether or not anyone reported it.
 *
 * byDay() only builds groups from rows that exist, and TrendChart's x axis is
 * index-based, so a day where NO site submitted anything would otherwise vanish
 * and the line would be drawn straight across it. A company-wide reporting
 * outage is precisely the thing this scorecard exists to make visible, so it
 * has to render as a gap rather than disappear.
 */
interface WindowDay {
  iso: string;
  day: DayTotals | null;
}

function fillWindow(days: DayTotals[], from: string, to: string): WindowDay[] {
  const byDate = new Map(days.map((d) => [d.business_date, d]));
  const out: WindowDay[] = [];
  // Counted off isoSpan rather than walked until the date passes `to`: the
  // count is exact for any window, and isoSpan returns 1 on an unparseable
  // bound, so a malformed date yields one point instead of spinning forever
  // inside a server render. No arbitrary cap, so a long window is charted in
  // full rather than silently ending part way through.
  const span = isoSpan(from, to);
  for (let i = 0; i < span; i++) {
    const iso = isoAdd(from, i);
    out.push({ iso, day: byDate.get(iso) ?? null });
  }
  return out;
}

function trendPoints(
  series: WindowDay[],
  pick: (d: Totals) => number | null,
  note: (d: Totals) => string
): TrendPoint[] {
  return series.map(({ iso, day }) => ({
    date: iso,
    label: iso.slice(5),
    value: day === null ? null : pick(day),
    note: day === null ? "no site reported this day" : note(day)
  }));
}

function rankRows(
  sites: SiteTotals[],
  selected: number | null,
  link: (patch: Record<string, string>) => string
): RankRow[] {
  return sites.map((s) => ({
    key: String(s.location_id),
    label: `${s.location_code} · ${s.site_number}`,
    value: s.capture_pct,
    goal: s.capture_goal_pct,
    tier:
      s.capture_pct === null || s.capture_goal_pct === null
        ? null
        : captureTier(s.capture_pct, s.capture_goal_pct),
    hover: `${s.location_code} · ${pct(s.capture_pct)} capture · ${num(
      s.sign_ups
    )} sign ups on ${num(s.wash_sales)} wash sales · ${s.days} days reported`,
    href: link({ site: String(s.location_id) }),
    active: selected === s.location_id
  }));
}

function scatterPoints(
  rows: GreeterPeriodReportRow[],
  link: (patch: Record<string, string>) => string
): ScatterPoint[] {
  return rows.map((r) => ({
    key: `${r.beekeeper_user_id}-${r.location_id}`,
    x: r.wash_sales ?? 0,
    y: r.capture_pct,
    tier:
      r.capture_pct === null || r.capture_goal_pct === null
        ? null
        : captureTier(r.capture_pct, r.capture_goal_pct),
    hover: `${r.greeter_name} · ${r.location_code} · ${pct(
      r.capture_pct
    )} capture on ${num(r.wash_sales)} wash sales · ${r.days_over_goal} of ${
      r.gradeable_days
    } graded days over goal`,
    href: link({ person: r.beekeeper_user_id }),
    lowSample: r.low_sample
  }));
}

/* ============================================================
 * Tables
 * ============================================================ */

function GreeterTable({
  rows,
  view,
  lowSampleCount,
  selectedPerson,
  link
}: {
  rows: GreeterPeriodReportRow[];
  view: ViewKey;
  lowSampleCount: number;
  selectedPerson: string | null;
  link: (patch: Record<string, string>) => string;
}) {
  const title =
    view === "top"
      ? "Top performers"
      : view === "under"
        ? "Underperformers"
        : "Greeters in the window";

  return (
    <Card
      title={`${title} · ${rows.length}`}
      subtitle={
        lowSampleCount === 0
          ? "Capture % and D.O.B. are recomputed from the summed numbers, not averaged across days. Click a row to open that greeter's days."
          : `Capture % and D.O.B. are recomputed from the summed numbers, not averaged across days. ${lowSampleCount} greeter${
              lowSampleCount === 1 ? " has" : "s have"
            } fewer than ${LOW_SAMPLE_DAYS} graded days and sit at the bottom — their percentages are real but rest on very few reported numbers.`
      }
    >
      {rows.length === 0 ? (
        <EmptyNote>
          {view === "recent"
            ? "No greeter days logged in this window."
            : "Nobody meets this threshold in this window — which is either good news or a sign the days aren't being reported."}
        </EmptyNote>
      ) : (
        <TableWrap>
          <thead className={THEAD_CLS}>
            <tr>
              <th className="px-4 py-3">Greeter</th>
              <th className="px-4 py-3">Site</th>
              <th className="px-4 py-3">Days</th>
              <th className="px-4 py-3">Over goal</th>
              <th className="px-4 py-3">Under goal</th>
              <th className="px-4 py-3">% over</th>
              <th className="px-4 py-3">Wash sales</th>
              <th className="px-4 py-3">WS / hr</th>
              <th className="px-4 py-3">Sign ups</th>
              <th className="px-4 py-3">Capture %</th>
              <th className="px-4 py-3">D.O.B.</th>
            </tr>
          </thead>
          <tbody className={TBODY_CLS}>
            {rows.map((r) => {
              const selected = selectedPerson === r.beekeeper_user_id;
              return (
                <tr
                  key={`${r.beekeeper_user_id}-${r.location_id}`}
                  className={selected ? "bg-sudsy-blue-soft/50" : undefined}
                >
                  <td className="px-4 py-3">
                    <Link
                      href={link({ person: r.beekeeper_user_id })}
                      className="font-semibold text-splash-blue hover:text-splash-blue-dark hover:underline"
                    >
                      {r.greeter_name}
                    </Link>
                    {r.low_sample ? <LowSampleTag row={r} /> : null}
                  </td>
                  <td className="px-4 py-3 text-splash-navy/80">
                    <div>{r.location_code}</div>
                    <div className="font-mono text-xs text-splash-navy/60">
                      {r.site_number}
                    </div>
                  </td>
                  {/* Graded days, not days logged — a day with no wash sales
                      has no capture rate and can't be over or under anything.
                      The two numbers differing is normal, not an error. */}
                  <td className="px-4 py-3 text-splash-navy/80">
                    {r.days_logged}
                    {r.ungraded_days > 0 ? (
                      <span
                        className="ml-1 text-xs text-splash-navy/50"
                        title={`${r.ungraded_days} of these days had no capture rate to grade — no wash sales, or no goal window covering the date.`}
                      >
                        ({r.gradeable_days} graded)
                      </span>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 font-semibold text-splash-success">
                    {r.days_over_goal}
                  </td>
                  <td className="px-4 py-3 font-semibold text-splash-deny">
                    {r.days_under_goal}
                  </td>
                  <td className="px-4 py-3 text-splash-navy/80">
                    {r.pct_days_over === null ? "—" : `${r.pct_days_over}%`}
                  </td>
                  <td className="px-4 py-3 text-splash-navy/80">
                    {num(r.wash_sales)}
                  </td>
                  <td className="px-4 py-3 text-splash-navy/80">
                    {hours(r.wash_sales_per_hour)}
                  </td>
                  <td className="px-4 py-3 text-splash-navy/80">
                    {num(r.sign_ups)}
                  </td>
                  <td className="px-4 py-3">
                    <CaptureCell value={r.capture_pct} goal={r.capture_goal_pct} />
                  </td>
                  <td className="px-4 py-3 font-semibold">{dobCell(r.dob)}</td>
                </tr>
              );
            })}
          </tbody>
        </TableWrap>
      )}
    </Card>
  );
}

function LowSampleTag({ row }: { row: GreeterPeriodReportRow }) {
  return (
    <span
      className="ml-2 inline-flex items-center whitespace-nowrap rounded-full bg-gray-light px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-splash-navy/70"
      title={`Only ${row.gradeable_days} graded day${row.gradeable_days === 1 ? "" : "s"} in this window. The percentages are real, but they rest on very few reported numbers.`}
    >
      Few days
    </span>
  );
}

/**
 * One row per site for the last seven days, worst capture first, with the
 * selected site's individual days expanded underneath it.
 *
 * The expansion is inline rather than a separate card so the site's days sit
 * directly under the total they add up to — the whole point of the call is
 * asking "which day did that happen on".
 */
function MorningCall({
  sites,
  allRows,
  selectedSite,
  link
}: {
  sites: SiteTotals[];
  allRows: LocationPeriodRow[];
  selectedSite: number | null;
  link: (patch: Record<string, string>) => string;
}) {
  return (
    <Card
      title={`Morning call · ${sites.length} site${sites.length === 1 ? "" : "s"}`}
      subtitle="Site numbers only, worst capture rate first. Click a site to open its days underneath. Scanned % is a data-quality signal, not a sales one — a low number means cars went unattributed, so every per-greeter figure for that site is understated."
    >
      {sites.length === 0 ? (
        <EmptyNote>No site-wide days were logged in this window.</EmptyNote>
      ) : (
        <TableWrap>
          <thead className={THEAD_CLS}>
            <tr>
              <th className="px-4 py-3">Site</th>
              <th className="px-4 py-3">Days</th>
              <th className="px-4 py-3">Total cars</th>
              <th className="px-4 py-3">Wash sales</th>
              <th className="px-4 py-3">Scanned %</th>
              <th className="px-4 py-3">Sign ups</th>
              <th className="px-4 py-3">Cancels</th>
              <th className="px-4 py-3">Net</th>
              <th className="px-4 py-3">Members</th>
              <th className="px-4 py-3">Capture %</th>
              <th className="px-4 py-3">D.O.B.</th>
            </tr>
          </thead>
          <tbody className={TBODY_CLS}>
            {sites.map((s) => {
              const open = selectedSite === s.location_id;
              const dayRows = open ? daysForSite(allRows, s.location_id) : [];
              return (
                <Fragment key={s.location_id}>
                  <tr className={open ? "bg-sudsy-blue-soft/50" : undefined}>
                    <td className="px-4 py-3">
                      <Link
                        href={link({ site: open ? "" : String(s.location_id) })}
                        className="font-semibold text-splash-blue hover:text-splash-blue-dark hover:underline"
                      >
                        {s.location_code}
                      </Link>
                      <div className="font-mono text-xs text-splash-navy/60">
                        {s.site_number}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-splash-navy/80">{s.days}</td>
                    <td className="px-4 py-3 text-splash-navy/80">
                      {num(s.total_cars)}
                    </td>
                    <td className="px-4 py-3 text-splash-navy/80">
                      {num(s.wash_sales)}
                    </td>
                    <td className="px-4 py-3">
                      <ScanPill value={s.scanned_pct} />
                    </td>
                    <td className="px-4 py-3 text-splash-navy/80">
                      {num(s.sign_ups)}
                    </td>
                    <td className="px-4 py-3 text-splash-navy/80">
                      {num(s.cancellations)}
                    </td>
                    <td className="px-4 py-3 text-splash-navy/80">
                      {num(s.net_members)}
                    </td>
                    {/* A level read at the site's latest day in the window,
                        never a sum — see memberLevel() in _lib/aggregate. */}
                    <td className="px-4 py-3 font-semibold">
                      {num(s.total_members)}
                    </td>
                    <td className="px-4 py-3">
                      <CaptureCell value={s.capture_pct} goal={s.capture_goal_pct} />
                    </td>
                    <td className="px-4 py-3 font-semibold">{dobCell(s.dob)}</td>
                  </tr>
                  {dayRows.map((d) => (
                    <tr
                      key={`${s.location_id}-${d.business_date}`}
                      className="bg-splash-navy/[0.03] text-xs"
                    >
                      <td className="py-2 pl-8 pr-4 font-mono text-splash-navy/70">
                        {dayLabel(d.business_date)}
                      </td>
                      <td className="px-4 py-2 text-splash-navy/50">
                        {d.greeters_logged === 0
                          ? "no greeters"
                          : `${d.greeters_logged} greeter${d.greeters_logged === 1 ? "" : "s"}`}
                      </td>
                      <td className="px-4 py-2 text-splash-navy/80">
                        {num(d.total_cars)}
                      </td>
                      <td className="px-4 py-2 text-splash-navy/80">
                        {num(d.wash_sales)}
                      </td>
                      <td className="px-4 py-2">
                        <ScanPill value={dayScanPct(d)} />
                      </td>
                      <td className="px-4 py-2 text-splash-navy/80">
                        {num(d.sign_ups)}
                      </td>
                      <td className="px-4 py-2 text-splash-navy/80">
                        {num(d.cancellations)}
                      </td>
                      <td className="px-4 py-2 text-splash-navy/80">
                        {num(d.net_members)}
                      </td>
                      <td className="px-4 py-2 text-splash-navy/80">
                        {num(d.total_members)}
                      </td>
                      <td className="px-4 py-2">
                        <CaptureCell
                          value={d.capture_pct}
                          goal={d.capture_goal_pct}
                        />
                      </td>
                      <td className="px-4 py-2 font-semibold">{dobCell(d.dob)}</td>
                    </tr>
                  ))}
                </Fragment>
              );
            })}
          </tbody>
        </TableWrap>
      )}
    </Card>
  );
}

/** One site's days, for the drill-through card on the greeter views. */
function SiteDayTable({ rows }: { rows: LocationPeriodRow[] }) {
  if (rows.length === 0) {
    return <EmptyNote>This site logged nothing in the window.</EmptyNote>;
  }
  return (
    <TableWrap>
      <thead className={THEAD_CLS}>
        <tr>
          <th className="px-4 py-3">Date</th>
          <th className="px-4 py-3">Greeters</th>
          <th className="px-4 py-3">Total cars</th>
          <th className="px-4 py-3">Wash sales</th>
          <th className="px-4 py-3">Scanned %</th>
          <th className="px-4 py-3">Sign ups</th>
          <th className="px-4 py-3">Cancels</th>
          <th className="px-4 py-3">Net</th>
          <th className="px-4 py-3">Members</th>
          <th className="px-4 py-3">Capture %</th>
          <th className="px-4 py-3">D.O.B.</th>
        </tr>
      </thead>
      <tbody className={TBODY_CLS}>
        {rows.map((d) => (
          <tr key={d.business_date}>
            <td className="px-4 py-3 font-mono text-xs text-splash-navy/80">
              {dayLabel(d.business_date)}
            </td>
            <td className="px-4 py-3 text-splash-navy/80">{d.greeters_logged}</td>
            <td className="px-4 py-3 text-splash-navy/80">{num(d.total_cars)}</td>
            <td className="px-4 py-3 text-splash-navy/80">{num(d.wash_sales)}</td>
            <td className="px-4 py-3">
              <ScanPill value={dayScanPct(d)} />
            </td>
            <td className="px-4 py-3 text-splash-navy/80">{num(d.sign_ups)}</td>
            <td className="px-4 py-3 text-splash-navy/80">
              {num(d.cancellations)}
            </td>
            <td className="px-4 py-3 text-splash-navy/80">{num(d.net_members)}</td>
            <td className="px-4 py-3 text-splash-navy/80">
              {num(d.total_members)}
            </td>
            <td className="px-4 py-3">
              <CaptureCell value={d.capture_pct} goal={d.capture_goal_pct} />
            </td>
            <td className="px-4 py-3 font-semibold">{dobCell(d.dob)}</td>
          </tr>
        ))}
      </tbody>
    </TableWrap>
  );
}

/** One greeter's days — the bottom of the drill-through. */
function PersonDayTable({ rows }: { rows: GreeterDayRow[] }) {
  const ordered = [...rows].sort((a, b) =>
    a.business_date.localeCompare(b.business_date)
  );
  return (
    <TableWrap>
      <thead className={THEAD_CLS}>
        <tr>
          <th className="px-4 py-3">Date</th>
          <th className="px-4 py-3">Site</th>
          <th className="px-4 py-3">Hours</th>
          <th className="px-4 py-3">Wash sales</th>
          <th className="px-4 py-3">WS / hr</th>
          <th className="px-4 py-3">Package $</th>
          <th className="px-4 py-3">Extras $</th>
          <th className="px-4 py-3">Sign ups</th>
          <th className="px-4 py-3">Capture %</th>
          <th className="px-4 py-3">D.O.B.</th>
        </tr>
      </thead>
      <tbody className={TBODY_CLS}>
        {ordered.map((d) => (
          <tr key={d.id}>
            <td className="px-4 py-3 font-mono text-xs text-splash-navy/80">
              {dayLabel(d.business_date)}
            </td>
            <td className="px-4 py-3 text-splash-navy/80">{d.location_code}</td>
            <td className="px-4 py-3 text-splash-navy/80">
              {hours(d.hours_worked)}
            </td>
            <td className="px-4 py-3 text-splash-navy/80">{num(d.wash_sales)}</td>
            <td className="px-4 py-3 text-splash-navy/80">
              {hours(d.wash_sales_per_hour)}
            </td>
            <td className="px-4 py-3 text-splash-navy/80">
              {money(d.package_dollars)}
            </td>
            <td className="px-4 py-3 text-splash-navy/80">
              {money(d.extras_dollars)}
            </td>
            <td className="px-4 py-3 text-splash-navy/80">{num(d.sign_ups)}</td>
            <td className="px-4 py-3">
              <CaptureCell value={d.capture_pct} goal={d.capture_goal_pct} />
            </td>
            <td className="px-4 py-3 font-semibold">{dobCell(d.dob)}</td>
          </tr>
        ))}
      </tbody>
    </TableWrap>
  );
}

/* ============================================================
 * Small presentational pieces
 * ============================================================ */

const LABEL_CLS =
  "text-xs font-semibold uppercase tracking-wider text-splash-navy/70";
const INPUT_CLS =
  "rounded-splash-sm border border-gray-light bg-white px-3 py-2 text-sm text-splash-navy placeholder:text-splash-navy/40 focus:border-splash-blue focus:outline-none";
const BTN_CLS =
  "inline-flex items-center gap-1.5 rounded-splash-sm bg-splash-blue px-5 py-2.5 text-sm font-bold text-white shadow-splash-btn transition-colors hover:bg-splash-blue-dark";
const THEAD_CLS =
  "bg-splash-navy/5 text-left text-xs font-semibold uppercase tracking-wider text-splash-navy/70";
const TBODY_CLS = "divide-y divide-gray-light text-splash-navy";

/** Site-day scanned share. Null when the site sold nothing to scan. */
function dayScanPct(row: LocationPeriodRow): number | null {
  const site = row.wash_sales ?? 0;
  if (site <= 0) return null;
  return Math.round((row.scanned_wash_sales * 1000) / site) / 10;
}

function ScanPill({ value }: { value: number | null }) {
  if (value === null) {
    return (
      <span
        className="text-splash-navy/40"
        title="No a-la-carte cars sold, so there was nothing to scan."
      >
        —
      </span>
    );
  }
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-bold ${CAPTURE_TIER_CLASSES[scanTier(value)]}`}
      title={`Target is ${SCAN_TARGET_PCT}% of wash sales attributed to a greeter.`}
    >
      {pct(value)}
    </span>
  );
}

/** Green when at or above goal, red when clearly under — same tiers as a pill. */
function toneFor(value: number | null, goal: number | null) {
  if (value === null || goal === null) return null;
  return captureTier(value, goal);
}

function Kpi({
  label,
  value,
  goal,
  delta: d,
  deltaUnit,
  tone,
  foot
}: {
  label: string;
  value: string;
  goal: string | null;
  delta: number | null;
  deltaUnit: string;
  tone: "hit" | "near" | "miss" | null;
  foot: string;
}) {
  const toneCls =
    tone === "hit"
      ? "text-splash-success"
      : tone === "miss"
        ? "text-splash-deny"
        : tone === "near"
          ? "text-yellow-900"
          : "text-splash-navy";

  return (
    <div className="rounded-splash-lg border border-gray-light bg-white p-5 shadow-splash-card">
      <p className={LABEL_CLS}>{label}</p>
      <p className={`mt-1 text-3xl font-bold ${toneCls}`}>{value}</p>
      <div className="mt-1 flex flex-wrap items-baseline gap-2 text-xs">
        {goal ? <span className="text-splash-navy/60">{goal}</span> : null}
        <DeltaTag value={d} unit={deltaUnit} />
      </div>
      <p className="mt-2 text-[11px] leading-snug text-splash-navy/60">{foot}</p>
    </div>
  );
}

/**
 * Change against the prior window.
 *
 * "No prior data" is rendered as its own state, never as 0.0 — a period with
 * nothing to compare against is not a flat period, and the difference matters
 * most in exactly the case where it's easiest to miss: a site's first week.
 */
function DeltaTag({ value, unit }: { value: number | null; unit: string }) {
  if (value === null) {
    return <span className="text-splash-navy/40">no prior data</span>;
  }
  if (value === 0) {
    return <span className="text-splash-navy/50">flat</span>;
  }
  const up = value > 0;
  const shown =
    unit === "$"
      ? `$${Math.abs(value).toFixed(2)}`
      : `${Math.abs(value).toFixed(unit === "pts" ? 1 : 0)}${unit ? ` ${unit}` : ""}`;
  return (
    <span
      className={`font-bold ${up ? "text-splash-success" : "text-splash-deny"}`}
    >
      {up ? "▲" : "▼"} {shown}
    </span>
  );
}

function Card({
  title,
  subtitle,
  action,
  children
}: {
  title: string;
  subtitle?: string;
  action?: { href: string; label: string };
  children: ReactNode;
}) {
  return (
    <div className="mb-6 overflow-hidden rounded-splash-lg border border-gray-light bg-white shadow-splash-card">
      <div className="flex items-start justify-between gap-4 border-b border-gray-light px-5 py-4">
        <div>
          <h2 className="text-lg font-bold text-splash-navy">{title}</h2>
          {subtitle ? (
            <p className="mt-1 text-xs text-splash-navy/60">{subtitle}</p>
          ) : null}
        </div>
        {action ? (
          <Link
            href={action.href}
            className="shrink-0 text-xs font-semibold text-splash-blue hover:text-splash-blue-dark"
          >
            {action.label}
          </Link>
        ) : null}
      </div>
      {children}
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

function ReportBanner() {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-sudsy-blue">
          Internal Tools
        </p>
        <h1 className="text-2xl font-bold text-splash-navy">Greeter Report</h1>
      </div>
      <Link
        href="/admin/greeters"
        className="text-sm font-semibold text-splash-blue hover:text-splash-blue-dark"
      >
        ← Back to the scorecard
      </Link>
    </div>
  );
}
