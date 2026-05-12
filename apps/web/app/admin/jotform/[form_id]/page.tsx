// Brief 109 — JotForm per-form submissions list
// (/admin/jotform/[form_id]).
//
// Server component. Any authenticated session passes; the worker re-validates
// scope via accessibleSiteNumbersForSession (Brief 107). Unknown `form_id`
// values resolve to a notFound() — we look up the form via the admin-tier
// listForms() call when possible and fall back to the per-form submissions
// call (which the worker 404s for unknown / disabled forms) so RM / RD / GM
// callers (who can't hit the admin-tier listForms endpoint) still get a
// proper not-found chrome on a stale link.

import Link from "next/link";
import { notFound } from "next/navigation";

import { getMe } from "../../../_lib/me";
import { DateRangePicker } from "../../../_components/DateRangePicker";
import { CsvExportButton } from "../../../_components/CsvExportButton";
import NoAccessCard from "../_components/NoAccessCard";
import {
  csvExportUrl,
  listForms,
  listSubmissions,
  type JotformForm,
  type JotformSubmissionRow,
  type JotformSubmissionsListResponse
} from "../_lib/worker-fetch";

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 50;
const DEFAULT_WINDOW_DAYS = 30;

interface PageProps {
  params: Promise<{ form_id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function readStringParam(
  raw: string | string[] | undefined
): string | undefined {
  if (typeof raw !== "string" || raw === "") return undefined;
  return raw;
}

function readIntParam(raw: string | string[] | undefined): number | undefined {
  const s = readStringParam(raw);
  if (!s) return undefined;
  const n = Number.parseInt(s, 10);
  if (!Number.isInteger(n) || n < 0) return undefined;
  return n;
}

function ymdUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function todayYmd(): string {
  const n = new Date();
  return ymdUtc(
    new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()))
  );
}

function defaultFromYmd(): string {
  const n = new Date();
  const today = new Date(
    Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate())
  );
  return ymdUtc(new Date(today.getTime() - DEFAULT_WINDOW_DAYS * 86_400_000));
}

function isAdminTier(
  session: Awaited<ReturnType<typeof getMe>>
): boolean {
  if (!session) return false;
  return (
    session.role === "super_admin" ||
    session.dcRole === "admin" ||
    session.dcRole === "super_admin"
  );
}

export default async function JotformFormPage({
  params,
  searchParams
}: PageProps) {
  const { form_id } = await params;
  const sp = await searchParams;
  const from = readStringParam(sp.from);
  const to = readStringParam(sp.to);
  const offset = readIntParam(sp.offset) ?? 0;

  const session = await getMe().catch(() => null);
  if (!session) {
    return (
      <NoAccessCard
        reason="signin"
        returnPath={`/admin/jotform/${encodeURIComponent(form_id)}`}
      />
    );
  }

  // Try to resolve the form's display_name via the admin-tier listForms
  // call. Non-admin callers receive null here (the worker gates that
  // endpoint to admin-tier); we fall through to the form_id as the
  // display name in that case.
  let formMeta: JotformForm | null = null;
  if (isAdminTier(session)) {
    try {
      const formsResp = await listForms();
      formMeta =
        formsResp?.forms.find((f) => f.form_id === form_id) ?? null;
      // If admin-tier and the form_id is genuinely unknown, render a
      // proper 404 chrome instead of leaking probe-ability.
      if (formsResp !== null && formMeta === null) {
        notFound();
      }
    } catch {
      // Non-fatal — drop through to the submissions call.
    }
  }

  let data: JotformSubmissionsListResponse | null = null;
  let fetchError: string | null = null;
  try {
    data = await listSubmissions(form_id, {
      from,
      to,
      offset,
      limit: DEFAULT_LIMIT
    });
  } catch (err) {
    fetchError = err instanceof Error ? err.message : String(err);
  }

  // The worker returns 404 for unknown / disabled forms; listSubmissions
  // collapses 404 to null. If the caller is non-admin and we got null,
  // surface a notFound() chrome so a stale link gets a proper 404 instead
  // of a generic empty state.
  if (data === null && fetchError === null && !formMeta) {
    notFound();
  }

  const fromDefault = defaultFromYmd();
  const toDefault = todayYmd();
  const csvUrl = csvExportUrl(form_id, { from, to });
  const title = formMeta?.display_name ?? form_id;
  const total = data?.total ?? data?.total_estimate ?? 0;
  const limit = data?.limit ?? DEFAULT_LIMIT;
  const currentOffset = data?.offset ?? offset;
  const hasPrev = currentOffset > 0;
  const hasNext = data ? currentOffset + (data.rows.length || 0) < total : false;

  return (
    <section className="mx-auto w-full max-w-[1100px] px-5 py-9">
      <div className="mb-2 text-sm">
        <Link href="/admin/jotform" className="text-splash-blue hover:underline">
          ← All forms
        </Link>
      </div>

      <div className="mb-5">
        <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-sudsy-blue">
          JotForm
        </p>
        <h1 className="text-2xl font-bold text-splash-navy">{title}</h1>
        {formMeta && (
          <p className="mt-1 text-sm text-splash-navy/70">
            <code>{formMeta.slug}</code> ·{" "}
            {formMeta.submission_count.toLocaleString()} submissions on record
          </p>
        )}
      </div>

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
            {data.rows.length === 0 ? (
              <>No submissions in this date range.</>
            ) : (
              <>
                Showing {currentOffset + 1}&ndash;
                {currentOffset + data.rows.length} of {total.toLocaleString()}{" "}
                submission{total === 1 ? "" : "s"} between{" "}
                {formatRangeLabel(data.from)} and {formatRangeLabel(data.to)}
                {data.scope === "scoped" ? " (scoped to your locations)" : ""}
              </>
            )}
          </p>

          {data.rows.length === 0 ? (
            <EmptyState scope={data.scope} />
          ) : (
            <SubmissionsTable formId={form_id} rows={data.rows} />
          )}

          {data.rows.length > 0 && (hasPrev || hasNext) && (
            <Pagination
              from={from}
              to={to}
              offset={currentOffset}
              limit={limit}
              hasPrev={hasPrev}
              hasNext={hasNext}
            />
          )}
        </>
      )}
    </section>
  );
}

function SubmissionsTable({
  formId,
  rows
}: {
  formId: string;
  rows: JotformSubmissionRow[];
}) {
  return (
    <div className="overflow-x-auto rounded-splash-md border border-gray-light">
      <table className="w-full border-collapse text-sm">
        <thead className="bg-sudsy-blue-soft/40 text-left text-xs uppercase tracking-wide text-splash-navy/70">
          <tr>
            <th className="px-3 py-2 font-semibold">Submitted at</th>
            <th className="px-3 py-2 font-semibold">Site</th>
            <th className="px-3 py-2 font-semibold">Status</th>
            <th className="px-3 py-2 font-semibold"></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.id}
              className="border-t border-gray-light hover:bg-sudsy-blue-soft/20"
            >
              <td className="px-3 py-2 align-top text-splash-navy">
                {r.jotform_created_at ? (
                  <span title={formatAbsolute(r.jotform_created_at)}>
                    {formatRelative(r.jotform_created_at)}
                  </span>
                ) : (
                  <span className="text-splash-navy/50">—</span>
                )}
              </td>
              <td className="px-3 py-2 align-top text-splash-navy">
                {r.site ?? r.site_number ?? (
                  <span className="text-splash-navy/50">—</span>
                )}
              </td>
              <td className="px-3 py-2 align-top">
                <StatusPill status={r.jotform_status} />
              </td>
              <td className="px-3 py-2 align-top">
                <Link
                  href={`/admin/jotform/${encodeURIComponent(formId)}/${encodeURIComponent(r.id)}`}
                  className="text-splash-blue hover:underline"
                >
                  View →
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EmptyState({ scope }: { scope: "all" | "scoped" }) {
  return (
    <div className="rounded-splash-md border border-gray-light bg-white px-4 py-6 text-center italic text-splash-navy/60">
      No submissions in this date range. Widen the range above to see older
      entries
      {scope === "scoped" ? " (scoped to your locations)" : ""}.
    </div>
  );
}

function Pagination({
  from,
  to,
  offset,
  limit,
  hasPrev,
  hasNext
}: {
  from: string | undefined;
  to: string | undefined;
  offset: number;
  limit: number;
  hasPrev: boolean;
  hasNext: boolean;
}) {
  const prevOffset = Math.max(0, offset - limit);
  const nextOffset = offset + limit;
  return (
    <div className="mt-4 flex items-center justify-between gap-3">
      <Link
        href={buildHref(from, to, prevOffset)}
        aria-disabled={!hasPrev}
        tabIndex={hasPrev ? 0 : -1}
        className={`inline-flex items-center rounded-splash-sm border border-splash-blue px-4 py-1.5 text-sm font-bold ${
          hasPrev
            ? "bg-white text-splash-blue hover:bg-splash-blue/5"
            : "pointer-events-none border-gray-light bg-gray-light/40 text-splash-navy/40"
        }`}
      >
        ← Prev
      </Link>
      <span className="text-xs text-splash-navy/60">
        Offset {offset.toLocaleString()}
      </span>
      <Link
        href={buildHref(from, to, nextOffset)}
        aria-disabled={!hasNext}
        tabIndex={hasNext ? 0 : -1}
        className={`inline-flex items-center rounded-splash-sm border border-splash-blue px-4 py-1.5 text-sm font-bold ${
          hasNext
            ? "bg-white text-splash-blue hover:bg-splash-blue/5"
            : "pointer-events-none border-gray-light bg-gray-light/40 text-splash-navy/40"
        }`}
      >
        Next →
      </Link>
    </div>
  );
}

function buildHref(
  from: string | undefined,
  to: string | undefined,
  offset: number
): string {
  const sp = new URLSearchParams();
  if (from) sp.set("from", from);
  if (to) sp.set("to", to);
  if (offset > 0) sp.set("offset", String(offset));
  const qs = sp.toString();
  return qs ? `?${qs}` : "?";
}

function StatusPill({ status }: { status: string | null }) {
  const label = status ?? "—";
  return (
    <span className="inline-flex items-center rounded-full bg-gray-light px-2.5 py-0.5 text-xs font-bold text-splash-navy/80">
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
