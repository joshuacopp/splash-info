// Brief 109 — JotForm per-form submissions list
// (/admin/jotform/[form_id]).
//
// Brief 115 restructured the rendering model:
//   - Default date range = today (was last 30 days)
//   - Full-scope alphabetical grouped rendering (no row pagination)
//   - Hard cap of 2000 rows; amber banner above when exceeded
//   - Role-aware count-only gate: admin-tier without a filter, or any
//     user with a date range beyond today and no filter, sees only a
//     "{N} total submissions {date}" summary tile with a copy
//     pointing at the FilterBar / DateRangePicker
//   - Brief 110's per-page grouping replaced with full-scope grouping;
//     per-day sub-buckets dropped since the date range is now narrow
//     by default and group counts are accurate over the full scope.

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
  listSubmissionsCount,
  listSubmissionsGrouped,
  type JotformForm,
  type JotformRoster,
  type JotformSubmissionRow,
  type JotformSubmissionsGroup,
  type JotformSubmissionsGroupedResponse,
  type JotformSubmissionsCountOnlyResponse
} from "../_lib/worker-fetch";

export const dynamic = "force-dynamic";

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

/**
 * Today's date in America/New_York wall-clock as YYYY-MM-DD. The worker
 * defaults to this when no `from` / `to` is passed, and the apps/web URL
 * defaults match so the DateRangePicker shows "today" out of the box.
 */
function todayEstYmd(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function isAdminTier(session: Awaited<ReturnType<typeof getMe>>): boolean {
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
  const fromParam = readStringParam(sp.from);
  const toParam = readStringParam(sp.to);
  const amEmail = readStringParam(sp.am_email);
  const rmEmail = readStringParam(sp.rm_email);
  const locationCode = readStringParam(sp.location_code);

  const session = await getMe().catch(() => null);
  if (!session) {
    return (
      <NoAccessCard
        returnPath={`/admin/jotform/${encodeURIComponent(form_id)}`}
      />
    );
  }

  // Brief 151 — listForms() is any-session, so all callers resolve a
  // proper display_name + early 404 on stale links (was admin-tier
  // gated in Brief 109, with non-admin falling through to the
  // submissions fetch for the 404 chrome).
  let formMeta: JotformForm | null = null;
  let formsScope: "all" | "scoped" | undefined;
  try {
    const formsResp = await listForms();
    formMeta = formsResp?.forms.find((f) => f.form_id === form_id) ?? null;
    formsScope = formsResp?.scope;
    if (formsResp !== null && formMeta === null) {
      notFound();
    }
  } catch {
    /* Non-fatal — drop through. */
  }

  const today = todayEstYmd();
  const effectiveFrom = fromParam ?? today;
  const effectiveTo = toParam ?? today;
  const isTodayOnly = effectiveFrom === today && effectiveTo === today;
  const hasFilter = !!(amEmail || rmEmail || locationCode);
  const adminTier = isAdminTier(session);

  // Decision tree (Brief 115 Phase 4):
  //
  //   - admin/super_admin + no filter   → count-only summary
  //                                       (regardless of date range)
  //   - admin/super_admin + filter      → grouped view
  //   - RM/RD/GM + today only           → grouped view (no filter req'd)
  //   - RM/RD/GM + beyond today + no f. → count-only summary
  //   - RM/RD/GM + beyond today + f.    → grouped view
  const renderCountOnly =
    (adminTier && !hasFilter) || (!adminTier && !isTodayOnly && !hasFilter);

  let grouped: JotformSubmissionsGroupedResponse | null = null;
  let countOnly: JotformSubmissionsCountOnlyResponse | null = null;
  let roster: JotformRoster | null = null;
  let fetchError: string | null = null;

  try {
    const fetchParams = {
      from: fromParam,
      to: toParam,
      amEmail,
      rmEmail,
      locationCode
    };
    if (renderCountOnly) {
      [countOnly, roster] = await Promise.all([
        listSubmissionsCount(form_id, fetchParams),
        getRoster()
      ]);
    } else {
      [grouped, roster] = await Promise.all([
        listSubmissionsGrouped(form_id, fetchParams),
        getRoster()
      ]);
    }
  } catch (err) {
    fetchError = err instanceof Error ? err.message : String(err);
  }

  // Unknown / disabled form → 404 chrome when listForms threw + the
  // submissions fetch also produced nothing usable.
  if (
    grouped === null &&
    countOnly === null &&
    fetchError === null &&
    !formMeta
  ) {
    notFound();
  }

  const csvUrl = csvExportUrl(form_id, {
    from: fromParam,
    to: toParam,
    amEmail,
    rmEmail,
    locationCode
  });
  const title = formMeta?.display_name ?? form_id;
  const dateRangeCopy = buildDateRangeCopy(effectiveFrom, effectiveTo);

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
            {formMeta.submission_count.toLocaleString()} submissions
            {formsScope === "scoped" ? " at your locations" : " on record"}
          </p>
        )}
      </div>

      {roster && (
        <div className="mb-3">
          <FilterBar roster={roster} />
        </div>
      )}

      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <DateRangePicker defaultFromYmd={today} defaultToYmd={today} />
        <CsvExportButton href={csvUrl} />
      </div>

      {fetchError && (
        <p className="mb-5 rounded-splash-md border border-racecar-red bg-white px-3 py-2 text-racecar-red">
          Failed to load submissions: {fetchError}
        </p>
      )}

      {renderCountOnly && countOnly && (
        <CountOnlySummary
          totalRows={countOnly.total_rows}
          dateRangeCopy={dateRangeCopy}
          adminTier={adminTier}
          isTodayOnly={isTodayOnly}
        />
      )}

      {!renderCountOnly && grouped && (
        <>
          {grouped.cap_reached && (
            <p className="mb-3 rounded-splash-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              Showing first 2,000 of {grouped.total_rows.toLocaleString()}+
              submissions. Narrow the date range or apply filters for the
              complete view.
            </p>
          )}
          <p className="mb-3 text-sm text-splash-navy/70">
            {grouped.total_rows === 0 ? (
              <>No submissions {dateRangeCopy.toLowerCase()}.</>
            ) : (
              <>
                {grouped.total_rows.toLocaleString()} total submission
                {grouped.total_rows === 1 ? "" : "s"} {dateRangeCopy} across{" "}
                {grouped.groups.length} location
                {grouped.groups.length === 1 ? "" : "s"}
                {grouped.scope === "scoped" ? " (scoped to your locations)" : ""}
              </>
            )}
          </p>
          {grouped.groups.length === 0 ? (
            <EmptyState scope={grouped.scope} />
          ) : (
            <GroupedSubmissions
              formId={form_id}
              columns={columnsFor(form_id)}
              groups={grouped.groups}
            />
          )}
        </>
      )}
    </section>
  );
}

function buildDateRangeCopy(fromYmd: string, toYmd: string): string {
  if (fromYmd === toYmd) {
    const today = todayEstYmd();
    if (fromYmd === today) return "today";
    return `on ${formatYmd(fromYmd)}`;
  }
  return `between ${formatYmd(fromYmd)} and ${formatYmd(toYmd)}`;
}

function formatYmd(ymd: string): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return ymd;
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC"
  });
}

/* ============================================================
 * Count-only summary (Brief 115 Phase 4)
 * ============================================================ */

function CountOnlySummary({
  totalRows,
  dateRangeCopy,
  adminTier,
  isTodayOnly
}: {
  totalRows: number;
  dateRangeCopy: string;
  adminTier: boolean;
  isTodayOnly: boolean;
}) {
  const prompt = adminTier
    ? "Select a Regional Director, Regional Manager, or Location to view individual submissions."
    : isTodayOnly
      ? "Select a Regional Director, Regional Manager, or Location to narrow the view."
      : "Narrow the date range to today, or apply a Regional Director / Regional Manager / Location filter, to see individual submissions.";

  return (
    <section className="rounded-splash-md border border-splash-blue/30 bg-white p-6 text-center">
      <p className="text-4xl font-bold text-splash-navy">
        {totalRows.toLocaleString()}
      </p>
      <p className="mt-1 text-sm font-semibold uppercase tracking-wide text-splash-navy/70">
        total submission{totalRows === 1 ? "" : "s"} {dateRangeCopy}
      </p>
      <p className="mx-auto mt-4 max-w-md text-sm text-splash-navy/60">
        {prompt}
      </p>
    </section>
  );
}

/* ============================================================
 * Grouped rendering (Brief 115 Phase 3)
 *
 * Worker pre-computed buckets, sorted alphabetically by site, with rows
 * already sorted desc by jotform_created_at. apps/web just renders.
 * Single-location pages still get the outer chrome (gives operators a
 * consistent visual anchor regardless of how many sites the filter
 * resolved to).
 * ============================================================ */

function GroupedSubmissions({
  formId,
  columns,
  groups
}: {
  formId: string;
  columns: FormColumn[];
  groups: JotformSubmissionsGroup[];
}) {
  return (
    <div className="space-y-5">
      {groups.map((g) => (
        <LocationGroup
          key={`${g.site}-${g.site_number}`}
          formId={formId}
          columns={columns}
          group={g}
        />
      ))}
    </div>
  );
}

function LocationGroup({
  formId,
  columns,
  group
}: {
  formId: string;
  columns: FormColumn[];
  group: JotformSubmissionsGroup;
}) {
  const headerSuffix = group.rm_name ? ` — Regional Manager: ${group.rm_name}` : "";
  const locLabel = group.site_number
    ? `${group.site} (${group.site_number})`
    : group.site;

  return (
    <section className="rounded-splash-md border border-gray-light bg-white p-4">
      <h2 className="mb-3 text-base font-bold text-splash-navy">
        {locLabel}
        <span className="ml-2 text-sm font-normal text-splash-navy/70">
          ({group.count} submission{group.count === 1 ? "" : "s"})
        </span>
        {headerSuffix && (
          <span className="font-normal text-splash-navy/70">
            {headerSuffix}
          </span>
        )}
      </h2>
      <SubmissionsTable formId={formId} columns={columns} rows={group.rows} />
    </section>
  );
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
