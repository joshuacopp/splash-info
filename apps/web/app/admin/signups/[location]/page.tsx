// Per-location signups viewer (Brief 56 + Brief 84; on the report kit since
// Brief 179). Read-only.
//
// Server component. The date range comes from the shared signups report
// definition (@splash/report-kit/reports/signups) via the same parser the
// signup worker uses, so the page and the worker agree on what a URL means.
// Ranges are Eastern calendar days, and the page always sends the worker an
// explicit from/to. Old `?days=1|7|30` bookmarks still work: the parser maps
// them to the same window the pre-kit page showed.
//
// Scoping stays in the worker (adminGate + per-location check); a caller
// without access to this location gets the sign-in / no-access card.

import Link from "next/link";
import { formatRangeLabel, parseReportParams } from "@splash/report-kit";
import { signupsReport } from "@splash/report-kit/reports/signups";

import {
  getSignupsForLocation,
  getSignupsCsvUrl,
  type SignupsResponse
} from "../../pricing/_lib/worker-fetch";
import { SignupAdminTabs } from "../../_components/SignupAdminTabs";
import { CsvExportButton } from "../../../_components/CsvExportButton";
import { ReportRangeBar } from "../../../_components/report/ReportRangeBar";
import { SignupsTable } from "../_components/SignupsTable";

interface PageProps {
  params: Promise<{ location: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const LOCATION_CODE_RE = /^[a-z0-9_]+$/;

export default async function LocationSignupsPage({
  params,
  searchParams
}: PageProps) {
  const { location } = await params;
  const sp = await searchParams;
  const locationLower = location.toLowerCase();

  // Apply the worker's LOCATION_CODE_RE defensively so a malformed slug
  // renders 404 chrome instead of a worker round-trip.
  if (!LOCATION_CODE_RE.test(locationLower)) {
    return (
      <section className="mx-auto w-full max-w-[640px] px-5 py-9">
        <SignupAdminTabs locationCode={null} active="signups" />
        <h1 className="mb-2 text-2xl font-bold text-splash-navy">
          Signups
        </h1>
        <p className="text-racecar-red">
          Invalid location code: <strong>{location}</strong>
        </p>
        <p className="mt-3">
          <Link href="/admin/signups" className="text-splash-blue underline">
            ← All locations
          </Link>
        </p>
      </section>
    );
  }

  const { range } = parseReportParams(signupsReport, sp);
  const query = { from: range.fromYmd, to: range.toYmd };

  let data: SignupsResponse | null;
  try {
    data = await getSignupsForLocation(locationLower, query);
  } catch (err) {
    return (
      <section className="mx-auto w-full max-w-[1000px] px-5 py-9">
        <SignupAdminTabs locationCode={locationLower} active="signups" />
        <h1 className="mb-3 text-2xl font-bold text-splash-navy">
          Signups · {capitalize(locationLower)}
        </h1>
        <p className="text-racecar-red">
          Failed to load signups:{" "}
          {err instanceof Error ? err.message : "unknown error"}
        </p>
      </section>
    );
  }

  if (!data) {
    const returnPath = `/admin/signups/${encodeURIComponent(locationLower)}`;
    return (
      <section className="mx-auto w-full max-w-[640px] px-5 py-9">
        <SignupAdminTabs locationCode={locationLower} active="signups" />
        <h1 className="mb-2 text-2xl font-bold text-splash-navy">
          Signups · {capitalize(locationLower)}
        </h1>
        <p className="text-racecar-red">
          You don&rsquo;t have access to <strong>{locationLower}</strong>.
        </p>
        <p className="mt-4">
          <Link
            href={`/login?return=${encodeURIComponent(returnPath)}`}
            className="inline-flex items-center gap-1.5 rounded-splash-sm bg-splash-blue px-5 py-2.5 text-sm font-bold text-white shadow-splash-btn transition-colors hover:bg-splash-blue-dark"
          >
            Sign In
          </Link>
        </p>
        <p className="mt-3 text-sm">
          <Link href="/admin/signups" className="text-splash-blue underline">
            ← All locations
          </Link>
        </p>
      </section>
    );
  }

  return (
    <section className="mx-auto w-full max-w-[1000px] px-5 py-9">
      <SignupAdminTabs locationCode={locationLower} active="signups" />

      <div className="mb-2 text-sm">
        <Link href="/admin/signups" className="text-splash-blue hover:underline">
          ← All locations
        </Link>
      </div>

      <h1 className="mb-3 text-2xl font-bold text-splash-navy">
        Signups · {capitalize(locationLower)}
      </h1>

      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <ReportRangeBar presets={signupsReport.presets} range={range} searchParams={sp} />
        <CsvExportButton href={getSignupsCsvUrl(locationLower, query)} />
      </div>

      <p className="mb-3 text-sm text-splash-navy/70">
        {data.count} signup{data.count === 1 ? "" : "s"}, {formatRangeLabel(range)}
      </p>

      <SignupsTable rows={data.rows} />

      {data.limit_hit ? (
        <p className="mt-3 text-xs text-splash-navy/60">
          Showing the most recent {data.limit}. Narrow the date range, or use
          Export CSV for the complete set.
        </p>
      ) : null}
    </section>
  );
}

function capitalize(s: string): string {
  if (s.length === 0) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}
