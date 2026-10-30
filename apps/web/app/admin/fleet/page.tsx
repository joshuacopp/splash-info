// Fleet inquiries admin landing (Brief 83; on the report kit since Brief 179).
//
// Server component. The date range comes from the shared fleet report
// definition (@splash/report-kit/reports/fleet) via the same parser the
// fleet worker uses, so the page and the worker agree on what a URL means.
// Ranges are Eastern calendar days. The page always sends the worker an
// explicit from/to, so preset chips need no worker support.
// Click any row's View -> /admin/fleet/{id}.

import Link from "next/link";
import { formatRangeLabel, parseReportParams } from "@splash/report-kit";
import { fleetReport } from "@splash/report-kit/reports/fleet";

import { CsvExportButton } from "../../_components/CsvExportButton";
import { ReportRangeBar } from "../../_components/report/ReportRangeBar";
import { FleetTable } from "./_components/FleetTable";
import { getFleetCsvUrl, getFleetSubmissions } from "./_lib/worker-fetch";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function FleetInquiriesPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const { range } = parseReportParams(fleetReport, sp);
  const query = { from: range.fromYmd, to: range.toYmd };

  let data: Awaited<ReturnType<typeof getFleetSubmissions>>;
  let fetchError: string | null = null;
  try {
    data = await getFleetSubmissions(query);
  } catch (err) {
    data = null;
    fetchError = err instanceof Error ? err.message : "unknown error";
  }

  if (data === null && fetchError === null) {
    return (
      <section className="mx-auto w-full max-w-[640px] px-5 py-9">
        <h1 className="mb-3 text-2xl font-bold text-splash-navy">Fleet Inquiries</h1>
        <p className="text-racecar-red">
          You don&rsquo;t have access to Fleet Inquiries. Contact your administrator.
        </p>
        <p className="mt-4">
          <Link
            href="/login?return=%2Fadmin%2Ffleet"
            className="inline-flex items-center gap-1.5 rounded-splash-sm bg-splash-blue px-5 py-2.5 text-sm font-bold text-white shadow-splash-btn transition-colors hover:bg-splash-blue-dark"
          >
            Sign In
          </Link>
        </p>
      </section>
    );
  }

  return (
    <section className="mx-auto w-full max-w-[1100px] px-5 py-9">
      <div className="mb-2 text-sm">
        <Link href="/admin/dashboard" className="text-splash-blue hover:underline">
          ← Dashboard
        </Link>
      </div>
      <h1 className="mb-1 text-2xl font-bold text-splash-navy">{fleetReport.title}</h1>
      <p className="mb-5 text-sm text-splash-navy/70">
        B2B leads submitted from <code>fleet.splashcarwashes.info</code>.
      </p>

      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <ReportRangeBar presets={fleetReport.presets} range={range} searchParams={sp} />
        <CsvExportButton href={getFleetCsvUrl(query)} />
      </div>

      {fetchError && (
        <p className="mb-5 rounded-splash-md border border-racecar-red bg-white px-3 py-2 text-racecar-red">
          Failed to load submissions: {fetchError}
        </p>
      )}

      {data && (
        <>
          <p className="mb-3 text-sm text-splash-navy/70">
            {data.count} submission{data.count === 1 ? "" : "s"}, {formatRangeLabel(range)}
            {data.total != null && data.total !== data.count ? ` (${data.total} total in range)` : ""}
          </p>

          <FleetTable rows={data.rows} />

          {data.limit_hit && (
            <p className="mt-3 text-xs text-splash-navy/60">
              Showing the {data.limit} most recent. Export CSV for the full range.
            </p>
          )}
        </>
      )}
    </section>
  );
}
