// Performance tracker UI (/admin/performance). Brief 6.
//
// Server component. Reads filter params from the URL, calls
// performance-worker GET /pertrack/api/submissions, renders a filter bar
// + results table + new-submission card below it.
//
// Sections (top -> bottom):
//   1. Action-error banner (?action_error=...) and success banner (?success=1).
//   2. Page banner ("Internal Tools" eyebrow + h1 "Performance Tracker").
//   3. Filter form: top row (always visible) — date range + LocationPicker
//      + GM/AGM tri-state. Second row (collapsed under <details>): greeter,
//      gm_name, agm_name, regional_manager, area_manager, rm_group,
//      fivestar — all substring text inputs.
//   4. Results table (or no-access / error / empty card).
//   5. New-submission card with createSubmissionAction.
//
// Auth posture: performanceGetJson collapses 401/403 into null.
// 401 = not signed in, 403 = signed in without "pertrack" tool grant.
// Both render the no-access Sign In card. The worker's standalone
// 8-hour /api/login is dormant in apps/web — we use the unified
// dashboard-worker session cookie.
//
// Worker response shape: listPerformanceSubmissions selects an embedded
// `location:locations!inner(id, site_number, ...)` rather than
// `location_id`, so the row carries `row.location.id` instead. The
// type below mirrors db-supabase/src/performance.ts SUBMISSIONS_SELECT.

import Link from "next/link";
import { performanceGetJson } from "./_lib/worker-fetch";
import { LocationPicker } from "./_components/LocationPicker";
import { createSubmissionAction } from "./actions";
import { RedirectForm } from "../_components/RedirectForm";

interface EmbeddedLocation {
  id: number;
  site_number: number;
  site: string | null;
  mla_location: string | null;
  location: string | null;
  area_manager: string | null;
  regional_manager: string | null;
  rm_group: string | null;
  rm_email: string | null;
  am_email: string | null;
  hrt_email: string | null;
  site_email: string | null;
  hrt1: string | null;
  hrt2: string | null;
  fivestar: string | null;
}

interface SubmissionRow {
  id: number;
  visit_at: string;
  capture_rate: number | null;
  opportunities: number | null;
  greeter_1_name: string | null;
  greeter_2_name: string | null;
  greeter_3_name: string | null;
  greeter_1_shift_start: string | null;
  greeter_1_shift_end: string | null;
  greeter_2_shift_start: string | null;
  greeter_2_shift_end: string | null;
  greeter_3_shift_start: string | null;
  greeter_3_shift_end: string | null;
  gm_on_site: boolean | null;
  gm_name: string | null;
  agm_on_site: boolean | null;
  agm_name: string | null;
  comments: string | null;
  submitted_by_email: string | null;
  created_at: string;
  location: EmbeddedLocation | null;
}

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function firstParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

function formatLocationLabel(loc: EmbeddedLocation): string {
  const name = loc.mla_location || loc.site || loc.location || "(unnamed)";
  return `${name} · ${loc.site_number}`;
}

function formatVisitAt(iso: string): string {
  if (!iso) return "—";
  if (iso.length < 16) return iso;
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

function formatCaptureRate(value: number | null): string {
  // Decision: render as "62.4%". The legacy stores capture_rate as the raw
  // percentage (0-100), not a 0-1 fraction — apiCreateSubmission applies
  // toNumOrNull and the form input has min/max 0..100. So we display the
  // value as-is with one decimal and a "%" suffix.
  if (value === null || value === undefined) return "—";
  return `${value.toFixed(1)}%`;
}

function joinGreeters(row: SubmissionRow): string {
  const names = [row.greeter_1_name, row.greeter_2_name, row.greeter_3_name]
    .map((n) => (n && n.trim() ? n.trim() : null))
    .filter((n): n is string => n !== null);
  return names.length === 0 ? "—" : names.join(", ");
}

function presenceCell(present: boolean | null, name: string | null): string {
  const mark = present ? "✓" : "✗";
  if (name && name.trim()) return `${mark} ${name.trim()}`;
  return mark;
}

function buildFilterQs(params: {
  search: { [key: string]: string | undefined };
}): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params.search)) {
    if (v) qs.set(k, v);
  }
  return qs.toString();
}

const TRI_BOOL_OPTIONS: ReadonlyArray<{ label: string; value: string }> = [
  { label: "Any", value: "" },
  { label: "Yes", value: "true" },
  { label: "No", value: "false" }
];

export default async function PerformancePage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const dateFrom = firstParam(sp.date_from).trim();
  const dateTo = firstParam(sp.date_to).trim();
  const locationIdRaw = firstParam(sp.location_id).trim();
  const locationIdNum =
    locationIdRaw && /^\d+$/.test(locationIdRaw)
      ? Number.parseInt(locationIdRaw, 10)
      : undefined;
  const gmOnSite = firstParam(sp.gm_on_site).trim();
  const agmOnSite = firstParam(sp.agm_on_site).trim();
  const greeter = firstParam(sp.greeter).trim();
  const gmName = firstParam(sp.gm_name).trim();
  const agmName = firstParam(sp.agm_name).trim();
  const regionalManager = firstParam(sp.regional_manager).trim();
  const areaManager = firstParam(sp.area_manager).trim();
  const rmGroup = firstParam(sp.rm_group).trim();
  const fivestar = firstParam(sp.fivestar).trim();

  const actionError = firstParam(sp.action_error).trim() || null;
  const successFlag = firstParam(sp.success).trim() === "1";

  // Whether any of the "More filters" fields are populated — auto-open
  // the <details> reveal on round-trip so the user sees what's filtering.
  const moreFiltersActive = Boolean(
    greeter || gmName || agmName || regionalManager || areaManager || rmGroup || fivestar
  );

  // Build worker query string.
  const qs = new URLSearchParams();
  if (dateFrom) qs.set("date_from", dateFrom);
  if (dateTo) qs.set("date_to", dateTo);
  if (locationIdNum !== undefined) qs.set("location_id", String(locationIdNum));
  if (gmOnSite === "true" || gmOnSite === "false") qs.set("gm_on_site", gmOnSite);
  if (agmOnSite === "true" || agmOnSite === "false") qs.set("agm_on_site", agmOnSite);
  if (greeter) qs.set("greeter", greeter);
  if (gmName) qs.set("gm_name", gmName);
  if (agmName) qs.set("agm_name", agmName);
  if (regionalManager) qs.set("regional_manager", regionalManager);
  if (areaManager) qs.set("area_manager", areaManager);
  if (rmGroup) qs.set("rm_group", rmGroup);
  if (fivestar) qs.set("fivestar", fivestar);
  const workerPath = `/pertrack/api/submissions${qs.toString() ? `?${qs.toString()}` : ""}`;

  let rows: SubmissionRow[] | null = null;
  let fetchError: string | null = null;
  try {
    rows = await performanceGetJson<SubmissionRow[]>(workerPath);
  } catch (err) {
    fetchError = err instanceof Error ? err.message : "Unknown error fetching submissions.";
  }

  // Build the filter-encoded path for the Sign In return.
  const filterQs = buildFilterQs({
    search: {
      date_from: dateFrom,
      date_to: dateTo,
      location_id: locationIdNum !== undefined ? String(locationIdNum) : undefined,
      gm_on_site: gmOnSite === "true" || gmOnSite === "false" ? gmOnSite : undefined,
      agm_on_site: agmOnSite === "true" || agmOnSite === "false" ? agmOnSite : undefined,
      greeter: greeter || undefined,
      gm_name: gmName || undefined,
      agm_name: agmName || undefined,
      regional_manager: regionalManager || undefined,
      area_manager: areaManager || undefined,
      rm_group: rmGroup || undefined,
      fivestar: fivestar || undefined
    }
  });
  const returnPath = `/admin/performance${filterQs ? `?${filterQs}` : ""}`;

  // No-access branch (401/403): render Sign In card.
  if (rows === null && !fetchError) {
    return (
      <section className="mx-auto w-full max-w-[1200px] px-5 py-9">
        <PageBanner />
        <div className="rounded-splash-lg border border-gray-light bg-white p-6 shadow-splash-card">
          <p className="mb-4 text-splash-deny">
            You don&rsquo;t have access to the Performance Tracker. Contact
            your administrator if this is unexpected.
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

  if (fetchError) {
    return (
      <section className="mx-auto w-full max-w-[1200px] px-5 py-9">
        <PageBanner />
        <div className="rounded-splash-lg border border-gray-light bg-white p-6 shadow-splash-card">
          <h2 className="mb-2 text-lg font-bold text-splash-deny">
            Could not load submissions
          </h2>
          <p className="text-sm text-splash-navy/80">{fetchError}</p>
          <p className="mt-2 text-sm text-splash-navy/60">
            Reload the page to retry.
          </p>
        </div>
      </section>
    );
  }

  const list = rows ?? [];

  // Derive a default label for the filter's LocationPicker from the result
  // set. If the filter narrows past the selected location, fall back to
  // a numeric placeholder so the user can still see the active filter.
  let filterLocationDefaultLabel: string | undefined;
  if (locationIdNum !== undefined) {
    const match = list.find((r) => r.location?.id === locationIdNum);
    filterLocationDefaultLabel = match?.location
      ? formatLocationLabel(match.location)
      : `ID ${locationIdNum}`;
  }

  return (
    <section className="mx-auto w-full max-w-[1200px] px-5 py-9">
      <ActionAlert message={actionError} />
      {successFlag ? <SuccessBanner /> : null}
      <PageBanner />

      {/* Filter bar */}
      <form
        method="GET"
        action="/admin/performance"
        className="mb-5 rounded-splash-lg border border-gray-light bg-white p-5 shadow-splash-card"
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-semibold uppercase tracking-wider text-splash-navy/70">
              Date from
            </span>
            <input
              type="date"
              name="date_from"
              defaultValue={dateFrom}
              className="rounded-splash-sm border border-gray-light bg-white px-3 py-2 text-sm text-splash-navy focus:border-splash-blue focus:outline-none"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs font-semibold uppercase tracking-wider text-splash-navy/70">
              Date to
            </span>
            <input
              type="date"
              name="date_to"
              defaultValue={dateTo}
              className="rounded-splash-sm border border-gray-light bg-white px-3 py-2 text-sm text-splash-navy focus:border-splash-blue focus:outline-none"
            />
          </label>

          <div className="flex flex-col gap-1 lg:col-span-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-splash-navy/70">
              Location
            </span>
            <LocationPicker
              name="location_id"
              defaultValue={locationIdNum}
              defaultLabel={filterLocationDefaultLabel}
              placeholder="Search by site number, name, or location code…"
            />
          </div>

          <label className="flex flex-col gap-1">
            <span className="text-xs font-semibold uppercase tracking-wider text-splash-navy/70">
              GM on site
            </span>
            <select
              name="gm_on_site"
              defaultValue={gmOnSite === "true" || gmOnSite === "false" ? gmOnSite : ""}
              className="rounded-splash-sm border border-gray-light bg-white px-3 py-2 text-sm text-splash-navy focus:border-splash-blue focus:outline-none"
            >
              {TRI_BOOL_OPTIONS.map((o) => (
                <option key={o.label} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs font-semibold uppercase tracking-wider text-splash-navy/70">
              AGM on site
            </span>
            <select
              name="agm_on_site"
              defaultValue={agmOnSite === "true" || agmOnSite === "false" ? agmOnSite : ""}
              className="rounded-splash-sm border border-gray-light bg-white px-3 py-2 text-sm text-splash-navy focus:border-splash-blue focus:outline-none"
            >
              {TRI_BOOL_OPTIONS.map((o) => (
                <option key={o.label} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <details className="mt-4" open={moreFiltersActive}>
          <summary className="cursor-pointer text-sm font-semibold text-splash-blue hover:text-splash-blue-dark">
            More filters
          </summary>
          <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {(
              [
                { name: "greeter", label: "Greeter name", value: greeter },
                { name: "gm_name", label: "GM name", value: gmName },
                { name: "agm_name", label: "AGM name", value: agmName },
                {
                  name: "regional_manager",
                  label: "Regional manager",
                  value: regionalManager
                },
                { name: "area_manager", label: "Area manager", value: areaManager },
                { name: "rm_group", label: "RM group", value: rmGroup },
                { name: "fivestar", label: "Five-star", value: fivestar }
              ] as const
            ).map((f) => (
              <label key={f.name} className="flex flex-col gap-1">
                <span className="text-xs font-semibold uppercase tracking-wider text-splash-navy/70">
                  {f.label}
                </span>
                <input
                  type="text"
                  name={f.name}
                  defaultValue={f.value}
                  className="rounded-splash-sm border border-gray-light bg-white px-3 py-2 text-sm text-splash-navy placeholder:text-splash-navy/40 focus:border-splash-blue focus:outline-none"
                />
              </label>
            ))}
          </div>
        </details>

        <div className="mt-4 flex items-center gap-3">
          <button
            type="submit"
            className="inline-flex items-center gap-1.5 rounded-splash-sm bg-splash-blue px-5 py-2.5 text-sm font-bold text-white shadow-splash-btn transition-colors hover:bg-splash-blue-dark"
          >
            Apply filters
          </button>
          <Link
            href="/admin/performance"
            className="text-sm font-semibold text-splash-blue hover:text-splash-blue-dark"
          >
            Reset
          </Link>
        </div>
      </form>

      {/* Results card */}
      {list.length === 0 ? (
        <div className="mb-6 rounded-splash-lg border border-gray-light bg-white p-6 shadow-splash-card">
          <p className="mb-3 text-splash-navy/80">
            No submissions match these filters.
          </p>
          <Link
            href="/admin/performance"
            className="text-sm font-semibold text-splash-blue hover:text-splash-blue-dark"
          >
            Show all submissions
          </Link>
        </div>
      ) : (
        <div className="mb-6 overflow-hidden rounded-splash-lg border border-gray-light bg-white shadow-splash-card">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-light text-sm">
              <thead className="bg-splash-navy/5 text-left text-xs font-semibold uppercase tracking-wider text-splash-navy/70">
                <tr>
                  <th className="px-4 py-3">Visit at</th>
                  <th className="px-4 py-3">Location</th>
                  <th className="px-4 py-3">Capture</th>
                  <th className="px-4 py-3">Opportunities</th>
                  <th className="px-4 py-3">GM</th>
                  <th className="px-4 py-3">AGM</th>
                  <th className="px-4 py-3">Greeters</th>
                  <th className="px-4 py-3">Submitted by</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-light text-splash-navy">
                {list.map((row) => (
                  <tr key={row.id}>
                    <td className="px-4 py-3 font-mono text-xs text-splash-navy/80">
                      {formatVisitAt(row.visit_at)}
                    </td>
                    <td className="px-4 py-3">
                      {row.location ? (
                        <>
                          <div className="text-splash-navy">
                            {row.location.mla_location ||
                              row.location.site ||
                              row.location.location ||
                              "(unnamed)"}
                          </div>
                          <div className="font-mono text-xs text-splash-navy/60">
                            {row.location.site_number}
                          </div>
                        </>
                      ) : (
                        <span className="text-splash-navy/60">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-splash-navy/80">
                      {formatCaptureRate(row.capture_rate)}
                    </td>
                    <td className="px-4 py-3 text-splash-navy/80">
                      {row.opportunities ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-splash-navy/80">
                      {presenceCell(row.gm_on_site, row.gm_name)}
                    </td>
                    <td className="px-4 py-3 text-splash-navy/80">
                      {presenceCell(row.agm_on_site, row.agm_name)}
                    </td>
                    <td className="px-4 py-3 text-splash-navy/80">
                      {joinGreeters(row)}
                    </td>
                    <td className="px-4 py-3 text-xs text-splash-navy/80">
                      {row.submitted_by_email ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <NewSubmissionCard />
    </section>
  );
}

/* ============================================================
 * Banners
 * ============================================================ */

function ActionAlert({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div
      role="alert"
      className="mb-5 flex flex-col gap-2 rounded-splash-md border border-splash-deny/40 bg-splash-deny/10 p-4 text-sm text-splash-deny sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex-1 whitespace-pre-line">
        <span className="font-bold">Action failed: </span>
        {message}
      </div>
      <Link
        href="/admin/performance"
        className="text-xs font-semibold underline underline-offset-2 hover:text-splash-deny/80"
      >
        Dismiss
      </Link>
    </div>
  );
}

function SuccessBanner() {
  return (
    <div
      role="status"
      className="mb-5 flex flex-col gap-2 rounded-splash-md border border-splash-success/40 bg-splash-success/10 p-4 text-sm text-splash-success sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex-1">
        <span className="font-bold">Submission saved.</span> The new entry
        appears at the top of the table.
      </div>
      <Link
        href="/admin/performance"
        className="text-xs font-semibold underline underline-offset-2 hover:text-splash-success/80"
      >
        Dismiss
      </Link>
    </div>
  );
}

function PageBanner() {
  return (
    <div className="mb-6">
      <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-sudsy-blue">
        Internal Tools
      </p>
      <h1 className="text-2xl font-bold text-splash-navy">
        Performance Tracker
      </h1>
    </div>
  );
}

/* ============================================================
 * New-submission card
 * ============================================================ */

function NewSubmissionCard() {
  const labelCls =
    "text-xs font-semibold uppercase tracking-wider text-splash-navy/70";
  const sectionLabelCls =
    "mt-4 mb-2 border-b border-gray-light pb-1 text-sm font-bold uppercase tracking-wider text-splash-navy/80";
  const inputCls =
    "w-full rounded-splash-sm border border-gray-light bg-white px-3 py-2 text-sm text-splash-navy placeholder:text-splash-navy/40 focus:border-splash-blue focus:outline-none";

  // Default visit_at to "now" in YYYY-MM-DDTHH:mm (browser-local) form.
  // datetime-local inputs require a 16-char ISO-ish string with no
  // timezone; toISOString().slice(0,16) truncates to that shape (UTC,
  // not local — but the field is purely informational and the worker
  // accepts any parseable string, so the slight UTC offset is acceptable
  // for v1). The user can adjust before submitting.
  const defaultVisitAt = new Date().toISOString().slice(0, 16);

  return (
    <div className="rounded-splash-lg border border-gray-light bg-white p-6 shadow-splash-card">
      <h2 className="mb-1 text-lg font-bold text-splash-navy">
        Log a new submission
      </h2>
      <p className="mb-4 text-xs text-splash-navy/60">
        Records a visit row in the performance_tracking table. Visit time
        and location are required; everything else is optional.
      </p>

      <RedirectForm action={createSubmissionAction} className="flex flex-col gap-2">
        <h3 className={sectionLabelCls}>Visit</h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className={labelCls}>Visit at *</span>
            <input
              type="datetime-local"
              name="visit_at"
              required
              defaultValue={defaultVisitAt}
              className={inputCls}
            />
          </label>
          <div className="flex flex-col gap-1">
            <span className={labelCls}>Location *</span>
            <LocationPicker
              name="location_id"
              required
              placeholder="Search by site number, name, or location code…"
            />
          </div>
        </div>

        <h3 className={sectionLabelCls}>Capture</h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className={labelCls}>Capture rate (%)</span>
            <input
              type="number"
              name="capture_rate"
              step="0.1"
              min="0"
              max="100"
              placeholder="0.0"
              className={inputCls}
            />
            <span className="text-[11px] text-splash-navy/60">
              Percentage (0-100).
            </span>
          </label>
          <label className="flex flex-col gap-1">
            <span className={labelCls}>Opportunities</span>
            <input
              type="number"
              name="opportunities"
              min="0"
              placeholder="0"
              className={inputCls}
            />
          </label>
        </div>

        <h3 className={sectionLabelCls}>Greeters</h3>
        <div className="space-y-3">
          {[1, 2, 3].map((n) => (
            <div
              key={n}
              className="grid grid-cols-1 gap-3 sm:grid-cols-3"
            >
              <label className="flex flex-col gap-1">
                <span className={labelCls}>Greeter {n}</span>
                <input
                  type="text"
                  name={`greeter_${n}_name`}
                  maxLength={200}
                  placeholder="Name"
                  className={inputCls}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className={labelCls}>Shift start</span>
                <input
                  type="time"
                  name={`greeter_${n}_shift_start`}
                  className={inputCls}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className={labelCls}>Shift end</span>
                <input
                  type="time"
                  name={`greeter_${n}_shift_end`}
                  className={inputCls}
                />
              </label>
            </div>
          ))}
        </div>

        <h3 className={sectionLabelCls}>Management</h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <label className="flex items-center gap-2 text-sm text-splash-navy">
              <input
                type="checkbox"
                name="gm_on_site"
                className="h-4 w-4 rounded border-gray-light text-splash-blue focus:ring-splash-blue"
              />
              <span className="font-semibold">GM on site</span>
            </label>
            <label className="flex flex-col gap-1">
              <span className={labelCls}>GM name</span>
              <input
                type="text"
                name="gm_name"
                maxLength={200}
                placeholder="Name"
                className={inputCls}
              />
            </label>
          </div>

          <div className="flex flex-col gap-1">
            <label className="flex items-center gap-2 text-sm text-splash-navy">
              <input
                type="checkbox"
                name="agm_on_site"
                className="h-4 w-4 rounded border-gray-light text-splash-blue focus:ring-splash-blue"
              />
              <span className="font-semibold">AGM on site</span>
            </label>
            <label className="flex flex-col gap-1">
              <span className={labelCls}>AGM name</span>
              <input
                type="text"
                name="agm_name"
                maxLength={200}
                placeholder="Name"
                className={inputCls}
              />
            </label>
          </div>
        </div>

        <h3 className={sectionLabelCls}>Notes</h3>
        <label className="flex flex-col gap-1">
          <span className={labelCls}>Comments</span>
          <textarea
            name="comments"
            rows={3}
            maxLength={2000}
            placeholder="Anything notable about this visit…"
            className={inputCls}
          />
        </label>

        <div className="mt-5">
          <button
            type="submit"
            className="inline-flex items-center gap-1.5 rounded-splash-sm bg-splash-blue px-5 py-2.5 text-sm font-bold text-white shadow-splash-btn transition-colors hover:bg-splash-blue-dark"
          >
            Save submission
          </button>
        </div>
      </RedirectForm>
    </div>
  );
}
