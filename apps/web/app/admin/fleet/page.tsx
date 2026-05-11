// Fleet inquiries admin landing (Brief 83).
//
// Server component. Renders the date-range-filterable list of recent fleet
// submissions plus an "Export CSV" link. Click any row → /admin/fleet/{id}.
// Backed by the fleet-inquiry-worker's `/admin/api/submissions*` endpoints
// via the FLEET_INQUIRY_WORKER service binding (Brief 83).

import Link from "next/link";
import { DateRangePicker } from "../../_components/DateRangePicker";
import { CsvExportButton } from "../../_components/CsvExportButton";
import {
  getFleetSubmissions,
  getFleetCsvUrl,
  type FleetSubmissionRow
} from "./_lib/worker-fetch";
import {
  FLEET_STATUS_PILL_CLASS,
  isFleetStatus
} from "./_lib/constants";

const DEFAULT_WINDOW_DAYS = 30;

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function ymdUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function todayYmd(): string {
  const n = new Date();
  return ymdUtc(new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate())));
}

function defaultFromYmd(): string {
  const n = new Date();
  const today = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
  return ymdUtc(new Date(today.getTime() - DEFAULT_WINDOW_DAYS * 86_400_000));
}

function readStringParam(
  raw: string | string[] | undefined
): string | undefined {
  if (typeof raw !== "string") return undefined;
  if (raw === "") return undefined;
  return raw;
}

export default async function FleetInquiriesPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const from = readStringParam(sp.from);
  const to = readStringParam(sp.to);

  let data: Awaited<ReturnType<typeof getFleetSubmissions>>;
  let fetchError: string | null = null;
  try {
    data = await getFleetSubmissions({ from, to });
  } catch (err) {
    data = null;
    fetchError = err instanceof Error ? err.message : "unknown error";
  }

  const fromDefault = defaultFromYmd();
  const toDefault = todayYmd();
  const csvUrl = getFleetCsvUrl({ from, to });

  if (data === null && fetchError === null) {
    return (
      <section className="mx-auto w-full max-w-[640px] px-5 py-9">
        <h1 className="mb-3 text-2xl font-bold text-splash-navy">
          Fleet Inquiries
        </h1>
        <p className="text-racecar-red">
          You don&rsquo;t have access to Fleet Inquiries. Contact your
          administrator.
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
        <Link
          href="/admin/dashboard"
          className="text-splash-blue hover:underline"
        >
          ← Dashboard
        </Link>
      </div>
      <h1 className="mb-1 text-2xl font-bold text-splash-navy">
        Fleet Inquiries
      </h1>
      <p className="mb-5 text-sm text-splash-navy/70">
        B2B leads submitted from <code>fleet.splashcarwashes.info</code>.
        Last-30-days by default; widen the range for older inquiries.
      </p>

      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <DateRangePicker
          defaultFromYmd={fromDefault}
          defaultToYmd={toDefault}
        />
        <CsvExportButton href={csvUrl} />
      </div>

      {fetchError && (
        <p className="mb-5 rounded-splash-md border border-racecar-red bg-white px-3 py-2 text-racecar-red">
          Failed to load submissions: {fetchError}
        </p>
      )}

      {data && (
        <>
          <p className="mb-3 text-sm text-splash-navy/70">
            {data.count} submission{data.count === 1 ? "" : "s"} between{" "}
            {formatRangeLabel(data.from)} and {formatRangeLabel(data.to)}
            {data.total != null && data.total !== data.count
              ? ` (${data.total} total in range)`
              : ""}
          </p>

          <SubmissionsTable rows={data.rows} />

          <p className="mt-3 text-xs text-splash-navy/60">
            Showing up to {data.limit} most recent rows. For full history use
            Export CSV.
          </p>
        </>
      )}
    </section>
  );
}

function SubmissionsTable({ rows }: { rows: FleetSubmissionRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-splash-md border border-gray-light bg-white px-4 py-6 text-center italic text-splash-navy/60">
        No submissions in this date range.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-splash-md border border-gray-light">
      <table className="w-full border-collapse text-sm">
        <thead className="bg-sudsy-blue-soft/40 text-left text-xs uppercase tracking-wide text-splash-navy/70">
          <tr>
            <th className="px-3 py-2 font-semibold">Submitted</th>
            <th className="px-3 py-2 font-semibold">Contact</th>
            <th className="px-3 py-2 font-semibold">Email</th>
            <th className="px-3 py-2 font-semibold">Phone</th>
            <th className="px-3 py-2 font-semibold">Vehicles</th>
            <th className="px-3 py-2 font-semibold">Location</th>
            <th className="px-3 py-2 font-semibold">Status</th>
            <th className="px-3 py-2 font-semibold"></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t border-gray-light">
              <td className="px-3 py-2 align-top text-splash-navy">
                <span title={formatAbsolute(r.submitted_at)}>
                  {formatRelative(r.submitted_at)}
                </span>
              </td>
              <td className="px-3 py-2 align-top text-splash-navy">
                <div className="font-semibold">{r.name ?? "—"}</div>
                {r.company && (
                  <div className="text-xs text-splash-navy/60">{r.company}</div>
                )}
              </td>
              <td className="px-3 py-2 align-top text-splash-navy">
                {r.email ?? <span className="text-splash-navy/50">—</span>}
              </td>
              <td className="px-3 py-2 align-top text-splash-navy">
                {formatPhone(r.phone) ?? <span className="text-splash-navy/50">—</span>}
              </td>
              <td className="px-3 py-2 align-top text-splash-navy">
                {r.number_of_vehicles ?? <span className="text-splash-navy/50">—</span>}
              </td>
              <td className="px-3 py-2 align-top text-splash-navy">
                {r.location_pretty ?? r.location_code ?? <span className="text-splash-navy/50">—</span>}
              </td>
              <td className="px-3 py-2 align-top text-splash-navy">
                <StatusPill status={r.status} />
              </td>
              <td className="px-3 py-2 align-top text-splash-navy">
                <Link
                  href={`/admin/fleet/${encodeURIComponent(r.id)}`}
                  className="text-splash-blue hover:underline"
                >
                  View
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StatusPill({ status }: { status: string | null }) {
  // Brief 105 widened the enum from "new" + everything-else to four discrete
  // values; the color map lives in _lib/constants.ts so the worker, server
  // action, dropdown, and pill all key off the same allow-list.
  const label = status ?? "new";
  const cls = isFleetStatus(label)
    ? FLEET_STATUS_PILL_CLASS[label]
    : FLEET_STATUS_PILL_CLASS.default;
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-bold ${cls}`}
    >
      {label}
    </span>
  );
}

function formatRangeLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric"
  });
}

function formatAbsolute(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function formatRelative(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const ms = Date.now() - d.getTime();
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day} day${day === 1 ? "" : "s"} ago`;
  return formatAbsolute(iso);
}

function formatPhone(raw: string | null): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return raw;
}
