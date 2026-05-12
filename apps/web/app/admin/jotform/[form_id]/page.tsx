// Brief 109 — JotForm per-form submissions list
// (/admin/jotform/[form_id]).
// Brief 110 — RD / RM / Location filter dropdowns + location → date
// grouped rendering of the current page.
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
import { FilterBar } from "./_components/FilterBar";
import { columnsFor, type FormColumn } from "./_lib/form-columns";
import {
  csvExportUrl,
  getRoster,
  listForms,
  listSubmissions,
  type JotformForm,
  type JotformRoster,
  type JotformSubmissionRow,
  type JotformSubmissionsListResponse,
  type RosterLocation,
  type RosterRm
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
  const amEmail = readStringParam(sp.am_email);
  const rmEmail = readStringParam(sp.rm_email);
  const locationCode = readStringParam(sp.location_code);

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
  let roster: JotformRoster | null = null;
  try {
    [data, roster] = await Promise.all([
      listSubmissions(form_id, {
        from,
        to,
        offset,
        limit: DEFAULT_LIMIT,
        amEmail,
        rmEmail,
        locationCode
      }),
      getRoster()
    ]);
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
  const csvUrl = csvExportUrl(form_id, {
    from,
    to,
    amEmail,
    rmEmail,
    locationCode
  });
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

      {roster && (
        <div className="mb-3">
          <FilterBar roster={roster} />
        </div>
      )}

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
                Showing rows {currentOffset + 1}&ndash;
                {currentOffset + data.rows.length} of {total.toLocaleString()}{" "}
                submission{total === 1 ? "" : "s"} between{" "}
                {formatRangeLabel(data.from)} and {formatRangeLabel(data.to)}
                {data.scope === "scoped" ? " (scoped to your locations)" : ""}{" "}
                (grouped by location &amp; date)
              </>
            )}
          </p>

          {data.rows.length === 0 ? (
            <EmptyState scope={data.scope} />
          ) : (
            <GroupedSubmissions
              formId={form_id}
              columns={columnsFor(form_id)}
              rows={data.rows}
              roster={roster}
            />
          )}

          {data.rows.length > 0 && (hasPrev || hasNext) && (
            <Pagination
              offset={currentOffset}
              limit={limit}
              hasPrev={hasPrev}
              hasNext={hasNext}
              searchParams={sp}
            />
          )}
        </>
      )}
    </section>
  );
}

/* ============================================================
 * Grouped rendering (Brief 110)
 *
 * Group the current page's rows by location → date. Single-location
 * pages skip the outer group chrome (the date sub-headers are enough
 * structure on their own).
 * ============================================================ */

interface LocationGroupKey {
  key: string;
  siteNumber: string;
  pretty: string;
  rmName: string | null;
}

function locationKeyForRow(row: JotformSubmissionRow): string {
  const sn = (row.site_number ?? "").trim();
  if (sn) return `sn:${sn}`;
  const site = (row.site ?? "").trim();
  if (site) return `site:${site}`;
  return "site:unknown";
}

function GroupedSubmissions({
  formId,
  columns,
  rows,
  roster
}: {
  formId: string;
  columns: FormColumn[];
  rows: JotformSubmissionRow[];
  roster: JotformRoster | null;
}) {
  // Index rosters: site_number → location_pretty + rm_email; rm_email →
  // RM display name. Used to label group headers.
  const locByNum = new Map<string, RosterLocation>();
  const rmByEmail = new Map<string, RosterRm>();
  if (roster) {
    for (const loc of roster.locations) {
      locByNum.set(loc.site_number, loc);
    }
    for (const rm of roster.regional_managers) {
      rmByEmail.set(rm.email, rm);
    }
  }

  // Bucket rows by location key.
  const byLocation = new Map<string, JotformSubmissionRow[]>();
  for (const r of rows) {
    const k = locationKeyForRow(r);
    let bucket = byLocation.get(k);
    if (!bucket) {
      bucket = [];
      byLocation.set(k, bucket);
    }
    bucket.push(r);
  }

  // Sort locations alphabetically by pretty (or site_number as fallback).
  const locationGroups: Array<{
    meta: LocationGroupKey;
    rows: JotformSubmissionRow[];
  }> = [];
  for (const [key, groupRows] of byLocation.entries()) {
    const first = groupRows[0];
    if (!first) continue;
    const sn = (first.site_number ?? "").trim();
    const fallbackPretty =
      (first.site ?? "").trim() || sn || "Unknown location";
    const rosterLoc = sn
      ? locByNum.get(sn) ||
        (sn.length < 3 ? locByNum.get(sn.padStart(3, "0")) : undefined)
      : undefined;
    // Brief 111: skip rosterLoc.location_pretty when it looks like a
    // postal address (the roster worker's fallback when pricing_simple
    // is missing). Prefer location_code in that case; only fall back to
    // the address as a last resort. Address never shows in group headers.
    const rosterPretty = (rosterLoc?.location_pretty || "").trim();
    const rosterLooksLikeAddress =
      rosterPretty.includes(",") || /^\d/.test(rosterPretty);
    const pretty = rosterLooksLikeAddress
      ? rosterLoc?.location_code || rosterPretty || fallbackPretty
      : rosterPretty || fallbackPretty;
    const rmEmail = rosterLoc?.rm_email || null;
    const rmName = rmEmail ? rmByEmail.get(rmEmail)?.name ?? rmEmail : null;
    locationGroups.push({
      meta: {
        key,
        siteNumber: sn,
        pretty,
        rmName
      },
      rows: groupRows
    });
  }
  locationGroups.sort((a, b) => {
    const ap = a.meta.pretty || "";
    const bp = b.meta.pretty || "";
    const cmp = ap.localeCompare(bp);
    if (cmp !== 0) return cmp;
    return (a.meta.siteNumber || "").localeCompare(b.meta.siteNumber || "");
  });

  const singleLocation = locationGroups.length === 1;

  return (
    <div className="space-y-5">
      {locationGroups.map((g) => (
        <LocationGroup
          key={g.meta.key}
          formId={formId}
          columns={columns}
          group={g}
          flat={singleLocation}
        />
      ))}
    </div>
  );
}

function LocationGroup({
  formId,
  columns,
  group,
  flat
}: {
  formId: string;
  columns: FormColumn[];
  group: { meta: LocationGroupKey; rows: JotformSubmissionRow[] };
  flat: boolean;
}) {
  const dateBuckets = bucketByDate(group.rows);

  const inner = (
    <div className="space-y-3">
      {dateBuckets.map((d) => (
        <div key={d.ymd}>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-splash-navy/60">
            {d.label} ({d.rows.length} submission
            {d.rows.length === 1 ? "" : "s"})
          </h3>
          <SubmissionsTable formId={formId} columns={columns} rows={d.rows} />
        </div>
      ))}
    </div>
  );

  if (flat) return inner;

  const headerSuffix =
    group.meta.rmName !== null
      ? ` — Regional Manager: ${group.meta.rmName}`
      : "";
  const locLabel = group.meta.siteNumber
    ? `${group.meta.pretty} (${group.meta.siteNumber})`
    : group.meta.pretty;

  return (
    <section className="rounded-splash-md border border-gray-light bg-white p-4">
      <h2 className="mb-3 text-base font-bold text-splash-navy">
        {locLabel}
        {headerSuffix && (
          <span className="font-normal text-splash-navy/70">
            {headerSuffix}
          </span>
        )}
      </h2>
      {inner}
    </section>
  );
}

function bucketByDate(
  rows: JotformSubmissionRow[]
): Array<{ ymd: string; label: string; rows: JotformSubmissionRow[] }> {
  const buckets = new Map<string, JotformSubmissionRow[]>();
  for (const r of rows) {
    const iso = r.jotform_created_at ?? "";
    const ymd = iso.length >= 10 ? iso.slice(0, 10) : "unknown";
    let b = buckets.get(ymd);
    if (!b) {
      b = [];
      buckets.set(ymd, b);
    }
    b.push(r);
  }
  // Most-recent date first; rows within a day already arrived in
  // jotform_created_at desc order from the worker.
  const out: Array<{ ymd: string; label: string; rows: JotformSubmissionRow[] }> = [];
  for (const [ymd, bRows] of buckets.entries()) {
    bRows.sort((a, b) => {
      const ai = a.jotform_created_at ?? "";
      const bi = b.jotform_created_at ?? "";
      return bi.localeCompare(ai);
    });
    out.push({ ymd, label: labelForYmd(ymd), rows: bRows });
  }
  out.sort((a, b) => b.ymd.localeCompare(a.ymd));
  return out;
}

function labelForYmd(ymd: string): string {
  if (ymd === "unknown") return "Date unknown";
  const d = new Date(`${ymd}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return ymd;
  return d.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC"
  });
}

function SubmissionsTable({
  formId,
  columns,
  rows
}: {
  formId: string;
  columns: FormColumn[];
  rows: JotformSubmissionRow[];
}) {
  return (
    <div className="overflow-x-auto rounded-splash-md border border-gray-light">
      <table className="w-full border-collapse text-sm">
        <thead className="bg-sudsy-blue-soft/40 text-left text-xs uppercase tracking-wide text-splash-navy/70">
          <tr>
            {columns.map((col) => (
              <th key={col.key} className="px-3 py-2 font-semibold">
                {col.label}
              </th>
            ))}
            <th className="px-3 py-2 font-semibold"></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.id}
              className="border-t border-gray-light hover:bg-sudsy-blue-soft/20"
            >
              {columns.map((col) => (
                <td
                  key={col.key}
                  className="px-3 py-2 align-top text-splash-navy"
                >
                  {col.render(r)}
                </td>
              ))}
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
  offset,
  limit,
  hasPrev,
  hasNext,
  searchParams
}: {
  offset: number;
  limit: number;
  hasPrev: boolean;
  hasNext: boolean;
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const prevOffset = Math.max(0, offset - limit);
  const nextOffset = offset + limit;
  return (
    <div className="mt-4 flex items-center justify-between gap-3">
      <Link
        href={buildHref(searchParams, prevOffset)}
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
        href={buildHref(searchParams, nextOffset)}
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

const PAGINATION_PASSTHROUGH_KEYS = [
  "from",
  "to",
  "am_email",
  "rm_email",
  "location_code"
] as const;

function buildHref(
  searchParams: Record<string, string | string[] | undefined>,
  offset: number
): string {
  const sp = new URLSearchParams();
  for (const key of PAGINATION_PASSTHROUGH_KEYS) {
    const raw = searchParams[key];
    if (typeof raw === "string" && raw) sp.set(key, raw);
  }
  if (offset > 0) sp.set("offset", String(offset));
  const qs = sp.toString();
  return qs ? `?${qs}` : "?";
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
