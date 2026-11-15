// /admin/site-status/reports — closure history: how often each site closes,
// for how long, why, and how far off the estimates were.
//
// The period comes from the shared report definition
// (@splash/report-kit/reports/site-closures), bucketed by when each closure
// STARTED, Eastern days. A closure still open counts up to now.

import Link from "next/link";
import { formatRangeLabel, parseReportParams } from "@splash/report-kit";
import {
  siteClosuresReport,
  summarizeClosures,
  toClosureRows,
  type ClosureGroup
} from "@splash/report-kit/reports/site-closures";
import { KpiTiles } from "../../../_components/report/KpiTiles";
import { ReportRangeBar } from "../../../_components/report/ReportRangeBar";
import { StackedBarChart } from "../../../_components/report/StackedBarChart";
import { ClosuresTable } from "../_components/ClosuresTable";
import { SiteStatusTabs } from "../_components/SiteStatusTabs";
import { getReport } from "../_lib/worker-fetch";

export const dynamic = "force-dynamic";

const CARD = "rounded-splash-lg border border-gray-light bg-white p-5 shadow-splash-card";
const TH = "px-3 py-2 text-left text-xs font-semibold uppercase tracking-wider text-splash-navy/70";
const TD = "px-3 py-2 text-sm text-splash-navy";
const NUM = "px-3 py-2 text-right text-sm tabular-nums text-splash-navy";

type SP = Record<string, string | string[] | undefined>;

function GroupTable({ title, groups, firstHeader, showSub }: { title: string; groups: ClosureGroup[]; firstHeader: string; showSub?: boolean }) {
  return (
    <section className={CARD}>
      <h2 className="mb-3 text-lg font-bold text-splash-navy">{title}</h2>
      {groups.length === 0 ? (
        <p className="text-sm text-splash-navy/60">No closures in this period.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-light">
            <thead>
              <tr>
                <th className={TH}>{firstHeader}</th>
                <th className={`${TH} text-right`}>Closures</th>
                <th className={`${TH} text-right`}>Hours closed</th>
                <th className={`${TH} text-right`}>Avg hrs</th>
                <th className={`${TH} text-right`}>Longest</th>
                <th className={`${TH} text-right`}>Ran over estimate</th>
                <th className={TH}>Most common reason</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-light">
              {groups.map((g) => (
                <tr key={g.key}>
                  <td className={TD}>
                    <div className="font-semibold">{g.label}</div>
                    {showSub && g.sub ? <div className="text-xs text-splash-navy/60">{g.sub}</div> : null}
                  </td>
                  <td className={NUM}>{g.closures}</td>
                  <td className={NUM}>{g.hours.toFixed(1)}</td>
                  <td className={NUM}>{g.avg_hours.toFixed(1)}</td>
                  <td className={NUM}>{g.longest_hours.toFixed(1)}</td>
                  <td className={NUM}>{g.over_estimate}</td>
                  <td className={TD}>{g.top_reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export default async function SiteStatusReportsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const { range } = parseReportParams(siteClosuresReport, sp);
  const res = await getReport(range.fromIso, range.toIso);

  if (!("data" in res)) {
    return (
      <main className="mx-auto max-w-6xl px-4 py-8">
        <div className={CARD}>
          {res.status === 401 ? (
            <p>
              Please <Link href="/login?next=/admin/site-status/reports" className="text-splash-blue underline">sign in</Link>.
            </p>
          ) : (
            <p>Couldn&apos;t load the report ({res.status}).</p>
          )}
        </div>
      </main>
    );
  }

  const rows = toClosureRows(res.data.closures, new Date(res.data.now));
  const sum = summarizeClosures(rows, range);
  const csvQs = new URLSearchParams({ from: range.fromYmd, to: range.toYmd });

  return (
    <main className="mx-auto max-w-6xl space-y-5 px-4 py-6">
      <div>
        <h1 className="text-2xl font-bold text-splash-navy">Site Status</h1>
        <p className="text-sm text-splash-navy/70">Closures that started {formatRangeLabel(range)}.</p>
      </div>
      <SiteStatusTabs active="reports" />

      <div className="flex flex-wrap items-end justify-between gap-3">
        <ReportRangeBar presets={siteClosuresReport.presets} range={range} searchParams={sp} />
        <a
          href={`/admin/site-status/export.csv?${csvQs.toString()}`}
          download
          className="rounded-splash-sm border border-splash-blue px-4 py-2 text-sm font-bold text-splash-blue hover:bg-splash-blue/5"
        >
          Export CSV
        </a>
      </div>

      <KpiTiles
        items={[
          { label: "Closures", value: sum.kpis.closures },
          { label: "Sites affected", value: sum.kpis.sites },
          { label: "Hours closed", value: sum.kpis.hours },
          { label: "Avg hours per closure", value: sum.kpis.avg_hours },
          { label: "Still closed", value: sum.kpis.still_closed },
          {
            label: "Ran past first estimate",
            value: sum.kpis.over_estimate_rate,
            kind: "percent",
            hint: "Share of finished closures that reopened later than first estimated"
          }
        ]}
      />

      {rows.length > 0 ? (
        <div className="grid gap-5 lg:grid-cols-2">
          <section className={CARD}>
            <h2 className="mb-3 text-lg font-bold text-splash-navy">Closures per week</h2>
            <StackedBarChart
              title="Closures per week"
              series={[{ key: "closures", label: "Closures" }]}
              rows={sum.by_week.map((w) => ({ label: `Week of ${w.label}`, closures: w.closures }))}
              maxRows={30}
            />
          </section>
          <section className={CARD}>
            <h2 className="mb-3 text-lg font-bold text-splash-navy">Hours closed by site (top 15)</h2>
            <StackedBarChart
              title="Hours closed by site"
              series={[{ key: "hours", label: "Hours closed" }]}
              rows={[...sum.by_site]
                .sort((a, b) => b.hours - a.hours)
                .map((g) => ({ label: g.label, hours: g.hours }))}
              maxRows={15}
            />
          </section>
        </div>
      ) : null}

      <GroupTable title="By site" groups={sum.by_site} firstHeader="Site" showSub />
      <GroupTable title="By reason" groups={sum.by_reason} firstHeader="Reason" />
      <div className="grid gap-5 lg:grid-cols-2">
        <GroupTable title="By Regional Director" groups={sum.by_rd} firstHeader="RD" />
        <GroupTable title="By Regional Manager" groups={sum.by_rm} firstHeader="RM" />
      </div>

      <section className={CARD}>
        <h2 className="mb-3 text-lg font-bold text-splash-navy">Every closure</h2>
        {rows.length === 0 ? <p className="text-sm text-splash-navy/60">No closures in this period.</p> : <ClosuresTable rows={rows} />}
      </section>
    </main>
  );
}
