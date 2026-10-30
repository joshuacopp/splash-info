// Brief 59 — /admin/damage/reporting
//
// Server component. Reads filters from URL searchParams and calls the new
// `/manage/api/reporting` endpoint on damage-worker. Multi-section layout
// with sticky anchor nav (Overview / By Location / By Damage Type) plus a
// filter row with location, RD, and RM.
//
// Brief 179: the period comes from the shared damage report definition
// (@splash/report-kit/reports/damage) through the same parser the worker
// uses -- Eastern days, preset chips plus a custom range, and old
// `?window=current_month|...` bookmarks still honoured. The page always sends
// the worker an explicit from/to. KPI tiles and the claims-by-location chart
// are the kit's shared report components.

import Link from "next/link";
import { formatRangeLabel, parseReportParams } from "@splash/report-kit";
import { damageReport } from "@splash/report-kit/reports/damage";
import { damageGetJson } from "../_lib/worker-fetch";
import { DamageTabs } from "../_components/DamageTabs";
import { ByLocationTableClient } from "./_components/ByLocationTableClient";
import { KpiTiles } from "../../../_components/report/KpiTiles";
import { ReportRangeBar } from "../../../_components/report/ReportRangeBar";
import { StackedBarChart } from "../../../_components/report/StackedBarChart";

interface ContactRosterEntry {
  email: string;
  name: string;
  location_codes: string[];
}

interface ReportingResponse {
  window: string;
  from: string;
  to: string;
  filters: {
    location: string;
    rd_email: string | null;
    rm_email: string | null;
  };
  totals: {
    open: number;
    /** Brief 172 — derived bucket; sits between Open and Closed. */
    awaiting_payment: number;
    closed: number;
    approved: number;
    denied: number;
    repair_cost: number;
  };
  by_location: Array<{
    location_code: string;
    location_pretty: string | null;
    open: number;
    awaiting_payment: number;
    closed: number;
    approved: number;
    denied: number;
    repair_cost: number;
    avg_days_open: number | null;
  }>;
  by_damage_type_open: Array<{ damage_type: string; count: number }>;
  by_damage_type_awaiting_payment: Array<{
    damage_type: string;
    count: number;
  }>;
  by_damage_type_approved: Array<{
    damage_type: string;
    count: number;
    cost: number;
  }>;
  by_damage_type_denied: Array<{ damage_type: string; count: number }>;
  by_location_drilldown: Array<{
    location_code: string;
    location_pretty: string | null;
    outcome_bucket:
      | "open"
      | "awaiting_payment"
      | "denied"
      | "approved"
      | "closed_approved"
      | "closed_other";
    damage_type: string;
    n: number;
    cost: number;
  }>;
  /** Brief 172 — by-cause / fault-attribution counts. Empty array pre-
   *  D1 migration; renderer treats empty as "(none)" gracefully. */
  by_fault_category: Array<{ fault_category: string; count: number }>;
  /** Damage Trends — (location, damage_type) hotspots over the rolling
   *  90-day window (>= 3 non-deleted claims). */
  trend_hotspots: Array<{
    location_code: string;
    location_pretty: string;
    damage_type: string;
    n: number;
  }>;
  /** Damage Trends — damage_types whose last-90-day volume runs ahead of
   *  the trailing-365-day expectation. `ratio` may be Infinity when there
   *  is no trailing baseline. */
  trend_spikes: Array<{
    damage_type: string;
    recent_90d: number;
    expected_90d: number;
    ratio: number;
  }>;
  /** Cost per car — repair cost over cars counted, per location. cars comes
   *  from the car_counts ranges overlapping the reporting window; cost_per_car
   *  is null when cars is 0 (no counted cars means no divisor). */
  cost_per_car_by_location: Array<{
    location_code: string;
    location_pretty: string;
    repair_cost: number;
    cars: number;
    cost_per_car: number | null;
  }>;
  /** Cost per car rolled up across every scoped location. */
  cost_per_car_total: {
    repair_cost: number;
    cars: number;
    cost_per_car: number | null;
  };
}

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function firstParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

function formatCurrency(n: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(n);
}

export default async function DamageReportingPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const { range } = parseReportParams(damageReport, sp);
  const locationParam = firstParam(sp.location).trim() || "All";
  const rdEmailParam = firstParam(sp.regional_director_email).trim();
  const rmEmailParam = firstParam(sp.regional_manager_email).trim();

  const reportingQs = new URLSearchParams();
  reportingQs.set("from", range.fromYmd);
  reportingQs.set("to", range.toYmd);
  if (locationParam && locationParam !== "All") reportingQs.set("location", locationParam);
  if (rdEmailParam) reportingQs.set("regional_director_email", rdEmailParam);
  if (rmEmailParam) reportingQs.set("regional_manager_email", rmEmailParam);

  let report: ReportingResponse | null = null;
  let rdRoster: ContactRosterEntry[] = [];
  let rmRoster: ContactRosterEntry[] = [];
  let fetchError: string | null = null;
  try {
    [report, rdRoster, rmRoster] = await Promise.all([
      damageGetJson<ReportingResponse>(
        `/manage/api/reporting?${reportingQs.toString()}`
      ),
      damageGetJson<ContactRosterEntry[]>(
        "/manage/api/contact-roster?role=regional_director"
      ).then((r) => r ?? []),
      damageGetJson<ContactRosterEntry[]>(
        "/manage/api/contact-roster?role=regional_manager"
      ).then((r) => r ?? [])
    ]);
  } catch (err) {
    fetchError = err instanceof Error ? err.message : "Unknown error fetching report.";
  }

  if (report === null && !fetchError) {
    const returnPath = `/admin/damage/reporting${
      reportingQs.toString() ? `?${reportingQs.toString()}` : ""
    }`;
    return (
      <section className="mx-auto w-full max-w-[1100px] px-5 py-9">
        <DamageTabs active="reporting" />
        <PageBanner />
        <div className="rounded-splash-lg border border-gray-light bg-white p-6 shadow-splash-card">
          <p className="mb-4 text-splash-deny">
            You don&rsquo;t have access to Damage Reporting. Contact your
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

  if (fetchError || !report) {
    return (
      <section className="mx-auto w-full max-w-[1100px] px-5 py-9">
        <DamageTabs active="reporting" />
        <PageBanner />
        <div className="rounded-splash-lg border border-gray-light bg-white p-6 shadow-splash-card">
          <h2 className="mb-2 text-lg font-bold text-splash-deny">
            Could not load report
          </h2>
          <p className="text-sm text-splash-navy/80">{fetchError ?? "Unknown error."}</p>
          <p className="mt-2 text-sm text-splash-navy/60">
            Reload the page to retry.
          </p>
        </div>
      </section>
    );
  }

  const rangeText = `${formatRangeLabel(range)} (Eastern)`;
  // Chips and the custom picker rewrite the period; drop the legacy key so
  // a stale `window=` doesn't ride along in every link.
  const rangeBarParams = { ...sp, window: undefined };

  return (
    <section className="mx-auto w-full max-w-[1100px] px-5 py-9">
      <DamageTabs active="reporting" />
      <PageBanner />

      {/* Sticky section nav */}
      <nav
        aria-label="Report sections"
        className="sticky top-0 z-10 -mx-5 mb-5 flex gap-3 border-b border-gray-light bg-white/95 px-5 py-2 backdrop-blur"
      >
        <a
          href="#overview"
          className="text-sm font-semibold text-splash-blue hover:text-splash-blue-dark"
        >
          Overview
        </a>
        <a
          href="#damage-trends"
          className="text-sm font-semibold text-splash-blue hover:text-splash-blue-dark"
        >
          Trends
        </a>
        <a
          href="#by-location"
          className="text-sm font-semibold text-splash-blue hover:text-splash-blue-dark"
        >
          By Location
        </a>
        <a
          href="#cost-per-car"
          className="text-sm font-semibold text-splash-blue hover:text-splash-blue-dark"
        >
          Cost per Car
        </a>
        <a
          href="#by-damage-type"
          className="text-sm font-semibold text-splash-blue hover:text-splash-blue-dark"
        >
          By Damage Type
        </a>
      </nav>

      <div className="mb-5 rounded-splash-lg border border-gray-light bg-white p-5 shadow-splash-card">
        <span className="text-xs font-semibold uppercase tracking-wider text-splash-navy/70">
          Period
        </span>
        <div className="mt-2">
          <ReportRangeBar
            presets={damageReport.presets}
            range={range}
            searchParams={rangeBarParams}
          />
        </div>
      </div>

      {/* Filter form */}
      <form
        method="GET"
        action="/admin/damage/reporting"
        className="mb-5 rounded-splash-lg border border-gray-light bg-white p-5 shadow-splash-card"
      >
        {/* The period round-trips through the form on Apply too, so the
            user keeps it when changing other filters. */}
        {range.preset === "custom" ? (
          <>
            <input type="hidden" name="from" value={range.fromYmd} />
            <input type="hidden" name="to" value={range.toYmd} />
          </>
        ) : (
          <input type="hidden" name="range" value={range.preset} />
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-semibold uppercase tracking-wider text-splash-navy/70">
              Location
            </span>
            <select
              name="location"
              defaultValue={locationParam}
              className="rounded-splash-sm border border-gray-light bg-white px-3 py-2 text-sm text-splash-navy focus:border-splash-blue focus:outline-none"
            >
              <option value="All">All locations</option>
              {report.by_location.map((row) => (
                <option key={row.location_code} value={row.location_code}>
                  {row.location_pretty ?? row.location_code}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs font-semibold uppercase tracking-wider text-splash-navy/70">
              Regional Director
            </span>
            <select
              name="regional_director_email"
              defaultValue={rdEmailParam}
              className="rounded-splash-sm border border-gray-light bg-white px-3 py-2 text-sm text-splash-navy focus:border-splash-blue focus:outline-none"
            >
              <option value="">(any)</option>
              {rdRoster.map((e) => (
                <option key={e.email} value={e.email}>
                  {e.name}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs font-semibold uppercase tracking-wider text-splash-navy/70">
              Regional Manager
            </span>
            <select
              name="regional_manager_email"
              defaultValue={rmEmailParam}
              className="rounded-splash-sm border border-gray-light bg-white px-3 py-2 text-sm text-splash-navy focus:border-splash-blue focus:outline-none"
            >
              <option value="">(any)</option>
              {rmRoster.map((e) => (
                <option key={e.email} value={e.email}>
                  {e.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="mt-4 flex items-center gap-3">
          <button
            type="submit"
            className="inline-flex items-center gap-1.5 rounded-splash-sm bg-splash-blue px-5 py-2.5 text-sm font-bold text-white shadow-splash-btn transition-colors hover:bg-splash-blue-dark"
          >
            Apply
          </button>
          <Link
            href="/admin/damage/reporting"
            className="text-sm font-semibold text-splash-blue hover:text-splash-blue-dark"
          >
            Reset
          </Link>
          <span className="ml-auto text-xs text-splash-navy/60">
            Period: {rangeText}
          </span>
        </div>
      </form>

      <section id="overview" className="mb-8 scroll-mt-20">
        <h2 className="mb-3 text-lg font-bold text-splash-navy">Overview</h2>
        {/* Brief 172 — Awaiting Payment inserted between Open and Closed
            so the row reads in lifecycle order. The three counts are
            mutually exclusive: open + awaiting_payment + closed = total. */}
        <KpiTiles
          items={[
            { label: "Open", value: report.totals.open },
            { label: "Awaiting Payment", value: report.totals.awaiting_payment },
            { label: "Closed", value: report.totals.closed },
            { label: "Approved", value: report.totals.approved },
            { label: "Denied", value: report.totals.denied },
            { label: "Repair Cost", value: report.totals.repair_cost, kind: "currency" }
          ]}
        />

        {/* Brief 172 — By Cause / fault-attribution. KPI-pill row below the
            tiles, one pill per category present in the result (the worker's
            COALESCE folds NULLs into a synthesized "Undetermined" entry).
            Empty array means no claims fell into any bucket (or the
            fault_category column hasn't been migrated yet); fall back to a
            neutral "(none)" hint so the section doesn't visually disappear. */}
        <div className="mt-4">
          <h3 className="mb-2 text-sm font-semibold uppercase tracking-wider text-splash-navy/70">
            By Cause
          </h3>
          {report.by_fault_category.length === 0 ? (
            <p className="text-xs text-splash-navy/60">(none)</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {report.by_fault_category.map((row) => (
                <CausePill
                  key={row.fault_category}
                  cause={row.fault_category}
                  count={row.count}
                />
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Damage Trends — rolling 90/365-day alert. Sits directly below the
          KPI overview so an emerging hotspot or spike is the first thing a
          reviewer sees, above the standard breakdowns. */}
      <section id="damage-trends" className="mb-8 scroll-mt-20">
        <h2 className="mb-3 text-lg font-bold text-splash-navy">
          Damage Trends
        </h2>
        <TrendAlert
          hotspots={report.trend_hotspots}
          spikes={report.trend_spikes}
        />
      </section>

      <section id="by-location" className="mb-8 scroll-mt-20">
        <h2 className="mb-3 text-lg font-bold text-splash-navy">By Location</h2>
        <div className="mb-4">
          <StackedBarChart
            title="Claims by location, split by open, awaiting payment and closed"
            series={[
              { key: "open", label: "Open" },
              { key: "awaiting_payment", label: "Awaiting payment" },
              { key: "closed", label: "Closed" }
            ]}
            rows={report.by_location.map((r) => ({
              label: r.location_pretty ?? r.location_code,
              open: r.open,
              awaiting_payment: r.awaiting_payment,
              closed: r.closed
            }))}
          />
        </div>
        <ByLocationTableClient
          rows={report.by_location}
          drilldown={report.by_location_drilldown}
        />
      </section>

      {/* Cost per Car — repair cost divided by cars counted, per site and in
          total. Cars come from the car_counts ranges (managed on the Car
          Counts tab) overlapping this window. Sites with no counted cars show
          an em dash rather than a misleading $0 or Infinity. */}
      <section id="cost-per-car" className="mb-8 scroll-mt-20">
        <h2 className="mb-3 text-lg font-bold text-splash-navy">Cost per Car</h2>
        <CostPerCarTable
          rows={report.cost_per_car_by_location}
          total={report.cost_per_car_total}
        />
      </section>

      <section id="by-damage-type" className="mb-8 scroll-mt-20">
        <h2 className="mb-3 text-lg font-bold text-splash-navy">By Damage Type</h2>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          <DamageTypeTable
            heading="Open"
            rows={report.by_damage_type_open}
          />
          <DamageTypeTable
            heading="Awaiting Payment"
            rows={report.by_damage_type_awaiting_payment}
          />
          <DamageTypeTable
            heading="Approved"
            rows={report.by_damage_type_approved}
            showCost
          />
          <DamageTypeTable
            heading="Denied"
            rows={report.by_damage_type_denied}
          />
        </div>
      </section>

      <p className="mt-6 text-xs text-splash-navy/60">
        Cost = receipts where a repair has been paid for, otherwise the approved
        quote amount. Quotes that are still awaiting approval do not count —
        there is no committed spend until a quote is approved or a receipt is
        uploaded, so competing estimates on the same claim are never added
        together.
      </p>
    </section>
  );
}

/**
 * Brief 172 — KPI pill for the By-Cause row. Tones mirror the
 * StatusActionPill vocabulary (amber / sudsy / neutral / muted) so the
 * three real causes stand out from the synthesized Undetermined row.
 */
function CausePill({ cause, count }: { cause: string; count: number }) {
  let cls = "bg-splash-navy/10 text-splash-navy/80";
  if (cause === "Employee Error") {
    cls = "bg-amber-100 text-amber-900 ring-1 ring-amber-300";
  } else if (cause === "Equipment Malfunction") {
    cls = "bg-sudsy-blue-soft text-splash-navy ring-1 ring-sudsy-blue/40";
  } else if (cause === "Not Employee/Equipment") {
    cls = "bg-gray-light/70 text-splash-navy/80 ring-1 ring-gray-light";
  } else if (cause === "No Fault") {
    cls = "bg-green-100 text-green-900 ring-1 ring-green-300";
  } else if (cause === "Undetermined") {
    cls = "bg-white text-splash-navy/60 ring-1 ring-gray-light";
  }
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ${cls}`}
    >
      <span>{cause}</span>
      <span className="font-mono text-[11px] opacity-80">{count}</span>
    </span>
  );
}

/**
 * Damage Trends alert. Amber-emphasised (matching the "Employee Error"
 * CausePill vocabulary) when there are hotspots or spikes; a muted card
 * otherwise. Hotspots and spikes render as small labelled lists.
 */
function TrendAlert({
  hotspots,
  spikes
}: {
  hotspots: ReportingResponse["trend_hotspots"];
  spikes: ReportingResponse["trend_spikes"];
}) {
  const hasAlerts = hotspots.length > 0 || spikes.length > 0;

  if (!hasAlerts) {
    return (
      <div className="rounded-splash-lg border border-gray-light bg-white p-5 text-sm text-splash-navy/70 shadow-splash-card">
        No trend alerts in the last 90 days.
      </div>
    );
  }

  const fmtRatio = (r: number) =>
    Number.isFinite(r) ? `${r}x` : "new";

  return (
    <div className="rounded-splash-lg border border-amber-300 bg-amber-100 p-5 shadow-splash-card ring-1 ring-amber-300">
      <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
        <div>
          <h3 className="mb-2 text-sm font-semibold uppercase tracking-wider text-amber-900">
            Location hotspots
          </h3>
          {hotspots.length === 0 ? (
            <p className="text-sm text-amber-900/70">None.</p>
          ) : (
            <ul className="space-y-1.5">
              {hotspots.map((h) => (
                <li
                  key={`${h.location_code}::${h.damage_type}`}
                  className="text-sm text-amber-900"
                >
                  <span className="font-semibold">{h.location_pretty}</span>
                  {" · "}
                  {h.damage_type}
                  {" — "}
                  <span className="font-mono">{h.n}</span> claims / 90d
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <h3 className="mb-2 text-sm font-semibold uppercase tracking-wider text-amber-900">
            Company-wide spikes
          </h3>
          {spikes.length === 0 ? (
            <p className="text-sm text-amber-900/70">None.</p>
          ) : (
            <ul className="space-y-1.5">
              {spikes.map((s) => (
                <li key={s.damage_type} className="text-sm text-amber-900">
                  <span className="font-semibold">{s.damage_type}</span>
                  {" — "}
                  <span className="font-mono">{s.recent_90d}</span> in 90d vs ~
                  <span className="font-mono">{s.expected_90d}</span> expected (
                  <span className="font-mono">{fmtRatio(s.ratio)}</span>)
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Cost per car — one row per location plus a total footer. cost_per_car is
 * null when cars is 0 (the worker's guard against dividing by zero); those
 * cells render an em dash. Repair cost and cars are always shown so a reader
 * can see WHY a rate is missing (no cars counted for the window).
 */
function CostPerCarTable({
  rows,
  total
}: {
  rows: ReportingResponse["cost_per_car_by_location"];
  total: ReportingResponse["cost_per_car_total"];
}) {
  return (
    <div className="overflow-hidden rounded-splash-lg border border-gray-light bg-white shadow-splash-card">
      {rows.length === 0 ? (
        <p className="px-4 py-3 text-sm text-splash-navy/70">
          No cost-per-car data for this window. Add car counts on the Car Counts
          tab to see rates here.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-light text-sm">
            <thead className="bg-splash-navy/5 text-left text-xs font-semibold uppercase tracking-wider text-splash-navy/70">
              <tr>
                <th className="px-4 py-3">Location</th>
                <th className="px-4 py-3 text-right">Repair Cost</th>
                <th className="px-4 py-3 text-right">Cars</th>
                <th className="px-4 py-3 text-right">Cost / Car</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-light text-splash-navy">
              {rows.map((row) => (
                <tr key={row.location_code}>
                  <td className="px-4 py-2.5">
                    <div className="text-splash-navy">{row.location_pretty}</div>
                    <div className="font-mono text-xs text-splash-navy/60">
                      {row.location_code}
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-xs text-splash-navy/80">
                    {formatCurrency(row.repair_cost)}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-xs text-splash-navy/80">
                    {row.cars.toLocaleString()}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-splash-navy">
                    {row.cost_per_car === null
                      ? "—"
                      : formatCurrency(row.cost_per_car)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot className="border-t border-gray-light bg-splash-navy/5 text-splash-navy">
              <tr>
                <td className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-splash-navy/70">
                  Total
                </td>
                <td className="px-4 py-3 text-right font-mono text-xs font-semibold">
                  {formatCurrency(total.repair_cost)}
                </td>
                <td className="px-4 py-3 text-right font-mono text-xs font-semibold">
                  {total.cars.toLocaleString()}
                </td>
                <td className="px-4 py-3 text-right font-mono font-bold">
                  {total.cost_per_car === null
                    ? "—"
                    : formatCurrency(total.cost_per_car)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}

function DamageTypeTable({
  heading,
  rows,
  showCost = false
}: {
  heading: string;
  rows: Array<{ damage_type: string; count: number; cost?: number }>;
  showCost?: boolean;
}) {
  return (
    <div className="overflow-hidden rounded-splash-lg border border-gray-light bg-white shadow-splash-card">
      <div className="bg-splash-navy/5 px-4 py-2 text-xs font-semibold uppercase tracking-wider text-splash-navy/70">
        {heading}
      </div>
      {rows.length === 0 ? (
        <p className="px-4 py-3 text-sm text-splash-navy/70">No claims.</p>
      ) : (
        <table className="min-w-full divide-y divide-gray-light text-sm">
          <tbody className="divide-y divide-gray-light text-splash-navy">
            {rows.map((row) => (
              <tr key={row.damage_type}>
                <td className="px-4 py-2">{row.damage_type}</td>
                <td className="px-4 py-2 text-right font-mono text-xs text-splash-navy/80">
                  {row.count}
                </td>
                {showCost ? (
                  <td className="px-4 py-2 text-right font-mono text-xs text-splash-navy/80">
                    {formatCurrency(row.cost ?? 0)}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function PageBanner() {
  return (
    <div className="mb-6">
      <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-sudsy-blue">
        Internal Tools
      </p>
      <h1 className="text-2xl font-bold text-splash-navy">Damage Reporting</h1>
    </div>
  );
}
