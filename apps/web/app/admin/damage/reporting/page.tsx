// Brief 59 — /admin/damage/reporting
//
// Server component. Reads filters from URL searchParams and calls the new
// `/manage/api/reporting` endpoint on damage-worker. Multi-section layout
// with sticky anchor nav (Overview / By Location / By Damage Type) plus a
// filter row with 5 window presets, location, RD, and RM.

import Link from "next/link";
import { damageGetJson } from "../_lib/worker-fetch";
import { DamageTabs } from "../_components/DamageTabs";

const WINDOW_PRESETS: ReadonlyArray<{
  value: ReportingWindow;
  label: string;
}> = [
  { value: "current_month", label: "Current month" },
  { value: "past_month", label: "Past month" },
  { value: "qtd", label: "QTD" },
  { value: "past_quarter", label: "Past quarter" },
  { value: "ytd", label: "YTD" }
];

const REPORTING_WINDOWS = new Set<string>([
  "current_month",
  "past_month",
  "qtd",
  "past_quarter",
  "ytd"
]);

type ReportingWindow =
  | "current_month"
  | "past_month"
  | "qtd"
  | "past_quarter"
  | "ytd";

interface ContactRosterEntry {
  email: string;
  name: string;
  location_codes: string[];
}

interface ReportingResponse {
  window: ReportingWindow;
  from: string;
  to: string;
  filters: {
    location: string;
    rd_email: string | null;
    rm_email: string | null;
  };
  totals: {
    open: number;
    closed: number;
    approved: number;
    denied: number;
    repair_cost: number;
  };
  by_location: Array<{
    location_code: string;
    location_pretty: string | null;
    open: number;
    closed: number;
    approved: number;
    denied: number;
    repair_cost: number;
  }>;
  by_damage_type_open: Array<{ damage_type: string; count: number }>;
  by_damage_type_approved: Array<{ damage_type: string; count: number }>;
  by_damage_type_denied: Array<{ damage_type: string; count: number }>;
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

function formatRange(fromIso: string, toIso: string): string {
  const fmt = (iso: string) => (iso.length >= 10 ? iso.slice(0, 10) : iso);
  return `${fmt(fromIso)} → ${fmt(toIso)}`;
}

export default async function DamageReportingPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const windowRaw = firstParam(sp.window).trim();
  const windowParam: ReportingWindow = REPORTING_WINDOWS.has(windowRaw)
    ? (windowRaw as ReportingWindow)
    : "qtd";
  const locationParam = firstParam(sp.location).trim() || "All";
  const rdEmailParam = firstParam(sp.regional_director_email).trim();
  const rmEmailParam = firstParam(sp.regional_manager_email).trim();

  const reportingQs = new URLSearchParams();
  reportingQs.set("window", windowParam);
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

  const rangeText = formatRange(report.from, report.to);

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
          href="#by-location"
          className="text-sm font-semibold text-splash-blue hover:text-splash-blue-dark"
        >
          By Location
        </a>
        <a
          href="#by-damage-type"
          className="text-sm font-semibold text-splash-blue hover:text-splash-blue-dark"
        >
          By Damage Type
        </a>
      </nav>

      {/* Window picker — separate from the filter form so each click
          navigates immediately, preserving other filters. */}
      <div className="mb-5 rounded-splash-lg border border-gray-light bg-white p-5 shadow-splash-card">
        <span className="text-xs font-semibold uppercase tracking-wider text-splash-navy/70">
          Window
        </span>
        <nav aria-label="Reporting window" className="mt-2 flex flex-wrap gap-2">
          {WINDOW_PRESETS.map((w) => {
            const isActive = w.value === windowParam;
            const cls = isActive
              ? "inline-flex items-center rounded-full border border-splash-blue bg-splash-blue px-3.5 py-1.5 text-sm font-bold text-white shadow-splash-btn"
              : "inline-flex items-center rounded-full border border-splash-blue bg-white px-3.5 py-1.5 text-sm font-bold text-splash-blue hover:bg-splash-blue/5";
            const next = new URLSearchParams();
            next.set("window", w.value);
            if (locationParam && locationParam !== "All") next.set("location", locationParam);
            if (rdEmailParam) next.set("regional_director_email", rdEmailParam);
            if (rmEmailParam) next.set("regional_manager_email", rmEmailParam);
            return (
              <Link
                key={w.value}
                href={`/admin/damage/reporting?${next.toString()}`}
                aria-current={isActive ? "page" : undefined}
                className={cls}
              >
                {w.label}
              </Link>
            );
          })}
        </nav>
      </div>

      {/* Filter form */}
      <form
        method="GET"
        action="/admin/damage/reporting"
        className="mb-5 rounded-splash-lg border border-gray-light bg-white p-5 shadow-splash-card"
      >
        {/* Window selection round-trips through the form on Apply too, so
            the user keeps the chosen window when changing other filters. */}
        <input type="hidden" name="window" value={windowParam} />

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
            Range: <span className="font-mono">{rangeText}</span>
          </span>
        </div>
      </form>

      <section id="overview" className="mb-8 scroll-mt-20">
        <h2 className="mb-3 text-lg font-bold text-splash-navy">Overview</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <KpiTile label="Open" value={String(report.totals.open)} />
          <KpiTile label="Closed" value={String(report.totals.closed)} />
          <KpiTile label="Approved" value={String(report.totals.approved)} />
          <KpiTile label="Denied" value={String(report.totals.denied)} />
          <KpiTile label="Repair Cost" value={formatCurrency(report.totals.repair_cost)} />
        </div>
      </section>

      <section id="by-location" className="mb-8 scroll-mt-20">
        <h2 className="mb-3 text-lg font-bold text-splash-navy">By Location</h2>
        {report.by_location.length === 0 ? (
          <p className="text-sm text-splash-navy/70">No claims in this window.</p>
        ) : (
          <div className="overflow-hidden rounded-splash-lg border border-gray-light bg-white shadow-splash-card">
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-light text-sm">
                <thead className="bg-splash-navy/5 text-left text-xs font-semibold uppercase tracking-wider text-splash-navy/70">
                  <tr>
                    <th className="px-4 py-3">Location</th>
                    <th className="px-4 py-3 text-right">Open</th>
                    <th className="px-4 py-3 text-right">Closed</th>
                    <th className="px-4 py-3 text-right">Approved</th>
                    <th className="px-4 py-3 text-right">Denied</th>
                    <th className="px-4 py-3 text-right">Cost</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-light text-splash-navy">
                  {report.by_location.map((row) => (
                    <tr key={row.location_code}>
                      <td className="px-4 py-3">
                        <div className="text-splash-navy">
                          {row.location_pretty ?? row.location_code}
                        </div>
                        <div className="font-mono text-xs text-splash-navy/60">
                          {row.location_code}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-xs text-splash-navy/80">
                        {row.open}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-xs text-splash-navy/80">
                        {row.closed}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-xs text-splash-navy/80">
                        {row.approved}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-xs text-splash-navy/80">
                        {row.denied}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-xs text-splash-navy/80">
                        {formatCurrency(row.repair_cost)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>

      <section id="by-damage-type" className="mb-8 scroll-mt-20">
        <h2 className="mb-3 text-lg font-bold text-splash-navy">By Damage Type</h2>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <DamageTypeTable
            heading="Open"
            rows={report.by_damage_type_open}
          />
          <DamageTypeTable
            heading="Approved"
            rows={report.by_damage_type_approved}
          />
          <DamageTypeTable
            heading="Denied"
            rows={report.by_damage_type_denied}
          />
        </div>
      </section>

      <p className="mt-6 text-xs text-splash-navy/60">
        Cost = sum of approved quote amounts + receipt amounts. Claims with
        both a quote and a receipt may be double-counted (limitation flagged
        in Brief 59 — refine in v2).
      </p>
    </section>
  );
}

function KpiTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-splash-lg border border-gray-light bg-white p-4 shadow-splash-card">
      <div className="text-xs font-semibold uppercase tracking-wider text-splash-navy/60">
        {label}
      </div>
      <div className="mt-1 text-2xl font-bold text-splash-navy">{value}</div>
    </div>
  );
}

function DamageTypeTable({
  heading,
  rows
}: {
  heading: string;
  rows: Array<{ damage_type: string; count: number }>;
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
