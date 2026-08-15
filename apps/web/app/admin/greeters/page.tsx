// Greeter scorecard (/admin/greeters).
//
// The database version of the per-greeter monthly spreadsheet: one row per
// greeter per day, plus a parallel site-wide row, filterable by date range,
// location, and person.
//
// This is NOT the visit-based Performance Tracker at /admin/performance. That
// one logs a manager's visit (who was on site, one capture rate). This one logs
// a full day's sales numbers for one greeter. They share the "pertrack" grant
// and the same worker, and nothing else.
//
// Sections (top -> bottom):
//   1. Action-error / success banners.
//   2. Filter bar — date range, location, greeter-name substring.
//   3. Summary table (per-greeter rollup for the filtered range).
//   4. Daily rows table.
//   5. Site-wide day rows table.
//   6. Three write cards: greeter day, site-wide day, goal window.
//
// DERIVED COLUMNS: capture % and D.O.B. arrive computed from Postgres and are
// rendered as-is. Do not recompute them here — the rollup's versions come from
// summed numerators and denominators, so a client-side recompute over the
// displayed columns would disagree with the summary for any multi-day range.
//
// Auth posture: performanceGetJson collapses 401/403 to null -> no-access card,
// same as the performance page. A location admin's rows are scoped worker-side.

import type { ReactNode } from "react";
import Link from "next/link";
import { performanceGetJson } from "../performance/_lib/worker-fetch";
import { LocationPicker } from "../performance/_components/LocationPicker";
import { GreeterDayForm } from "./_components/GreeterDayForm";
import { MetricFields } from "./_components/MetricFields";
import {
  createGoalAction,
  submitGreeterDayAction,
  submitLocationDayAction
} from "./actions";

interface DayRow {
  id: string;
  business_date: string;
  location_id: number;
  site_number: number;
  location_code: string;
  beekeeper_user_id?: string;
  greeter_name?: string;
  total_cars: number | null;
  wash_sales: number | null;
  package_dollars: number | null;
  extras_dollars: number | null;
  sign_ups: number | null;
  sign_up_goal: number | null;
  extras_goal: number | null;
  capture_pct: number | null;
  dob: number | null;
  comments: string | null;
  created_by_email: string | null;
  updated_by_email: string | null;
}

interface RollupRow {
  beekeeper_user_id: string;
  greeter_name: string;
  site_number: number;
  location_code: string;
  first_date: string;
  last_date: string;
  days_logged: number;
  total_cars: number | null;
  wash_sales: number | null;
  package_dollars: number | null;
  extras_dollars: number | null;
  sign_ups: number | null;
  sign_up_goal: number | null;
  extras_goal: number | null;
  capture_pct: number | null;
  dob: number | null;
}

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function firstParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

function num(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return value.toLocaleString();
}

function money(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return `$${value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}

/** Null means "no wash sales that day" — unknown, not zero. Say so with a dash. */
function pct(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return `${value.toFixed(1)}%`;
}

function dobCell(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return `$${value.toFixed(2)}`;
}

const SUCCESS_COPY: Record<string, string> = {
  day: "Greeter day saved.",
  location: "Site-wide day saved.",
  goal: "Goal window saved."
};

export default async function GreetersPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const dateFrom = firstParam(sp.date_from).trim();
  const dateTo = firstParam(sp.date_to).trim();
  const locationIdRaw = firstParam(sp.location_id).trim();
  const locationIdNum =
    locationIdRaw && /^\d+$/.test(locationIdRaw)
      ? Number.parseInt(locationIdRaw, 10)
      : undefined;
  const greeter = firstParam(sp.greeter).trim();

  const actionError = firstParam(sp.action_error).trim() || null;
  const successKey = firstParam(sp.success).trim();
  const successMessage = SUCCESS_COPY[successKey] ?? null;

  const qs = new URLSearchParams();
  if (dateFrom) qs.set("date_from", dateFrom);
  if (dateTo) qs.set("date_to", dateTo);
  if (locationIdNum !== undefined) qs.set("location_id", String(locationIdNum));
  if (greeter) qs.set("greeter", greeter);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";

  let days: DayRow[] | null = null;
  let rollup: RollupRow[] | null = null;
  let locationDays: DayRow[] | null = null;
  let fetchError: string | null = null;

  try {
    // Parallel: three independent reads over the same filter set. Sequential
    // awaits would triple the page's time-to-first-byte for no benefit.
    [days, rollup, locationDays] = await Promise.all([
      performanceGetJson<DayRow[]>(`/pertrack/api/greeter/days${suffix}`),
      performanceGetJson<RollupRow[]>(`/pertrack/api/greeter/rollup${suffix}`),
      performanceGetJson<DayRow[]>(`/pertrack/api/greeter/location-days${suffix}`)
    ]);
  } catch (err) {
    fetchError =
      err instanceof Error ? err.message : "Unknown error loading the scorecard.";
  }

  const returnPath = `/admin/greeters${suffix}`;

  if (days === null && !fetchError) {
    return (
      <section className="mx-auto w-full max-w-[1200px] px-5 py-9">
        <PageBanner />
        <div className="rounded-splash-lg border border-gray-light bg-white p-6 shadow-splash-card">
          <p className="mb-4 text-splash-deny">
            You don&rsquo;t have access to the greeter scorecard. Contact your
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

  if (fetchError) {
    return (
      <section className="mx-auto w-full max-w-[1200px] px-5 py-9">
        <PageBanner />
        <div className="rounded-splash-lg border border-gray-light bg-white p-6 shadow-splash-card">
          <h2 className="mb-2 text-lg font-bold text-splash-deny">
            Could not load the scorecard
          </h2>
          <p className="text-sm text-splash-navy/80">{fetchError}</p>
          <p className="mt-2 text-sm text-splash-navy/60">
            Reload the page to retry.
          </p>
        </div>
      </section>
    );
  }

  const dayList = days ?? [];
  const rollupList = rollup ?? [];
  const locationDayList = locationDays ?? [];

  // Label for the filter's LocationPicker on round-trip. Derived from a row in
  // the result set; falls back to the raw id when the filter excludes every row.
  let filterLocationLabel: string | undefined;
  if (locationIdNum !== undefined) {
    const match =
      dayList.find((r) => r.location_id === locationIdNum) ??
      locationDayList.find((r) => r.location_id === locationIdNum);
    filterLocationLabel = match
      ? `${match.location_code} · ${match.site_number}`
      : `ID ${locationIdNum}`;
  }

  // Today in YYYY-MM-DD, which is what the date inputs and the worker both
  // want. toISOString() is UTC — acceptable for a default the user can change.
  const today = new Date().toISOString().slice(0, 10);

  return (
    <section className="mx-auto w-full max-w-[1200px] px-5 py-9">
      <ActionAlert message={actionError} />
      {successMessage ? <SuccessBanner message={successMessage} /> : null}
      <PageBanner />

      {/* Filter bar */}
      <form
        method="GET"
        action="/admin/greeters"
        className="mb-5 rounded-splash-lg border border-gray-light bg-white p-5 shadow-splash-card"
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <label className="flex flex-col gap-1">
            <span className={LABEL_CLS}>Date from</span>
            <input
              type="date"
              name="date_from"
              defaultValue={dateFrom}
              className={INPUT_CLS}
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className={LABEL_CLS}>Date to</span>
            <input
              type="date"
              name="date_to"
              defaultValue={dateTo}
              className={INPUT_CLS}
            />
          </label>

          <div className="flex flex-col gap-1">
            <span className={LABEL_CLS}>Location</span>
            <LocationPicker
              name="location_id"
              defaultValue={locationIdNum}
              defaultLabel={filterLocationLabel}
              placeholder="Search by site number, name, or code…"
            />
          </div>

          <label className="flex flex-col gap-1">
            <span className={LABEL_CLS}>Greeter</span>
            <input
              type="text"
              name="greeter"
              defaultValue={greeter}
              placeholder="Name contains…"
              className={INPUT_CLS}
            />
          </label>
        </div>

        <div className="mt-4 flex items-center gap-3">
          <button
            type="submit"
            className="inline-flex items-center gap-1.5 rounded-splash-sm bg-splash-blue px-5 py-2.5 text-sm font-bold text-white shadow-splash-btn transition-colors hover:bg-splash-blue-dark"
          >
            Apply filters
          </button>
          <Link
            href="/admin/greeters"
            className="text-sm font-semibold text-splash-blue hover:text-splash-blue-dark"
          >
            Reset
          </Link>
        </div>
      </form>

      {/* Summary */}
      <Card
        title="By greeter"
        subtitle="Totals for the filtered range. Capture % and D.O.B. are recomputed from the summed numbers, not averaged across days."
      >
        {rollupList.length === 0 ? (
          <EmptyNote>No greeter days match these filters.</EmptyNote>
        ) : (
          <TableWrap>
            <thead className={THEAD_CLS}>
              <tr>
                <th className="px-4 py-3">Greeter</th>
                <th className="px-4 py-3">Site</th>
                <th className="px-4 py-3">Days</th>
                <th className="px-4 py-3">Total cars</th>
                <th className="px-4 py-3">Wash sales</th>
                <th className="px-4 py-3">Package $</th>
                <th className="px-4 py-3">Extras $</th>
                <th className="px-4 py-3">D.O.B.</th>
                <th className="px-4 py-3">Sign ups</th>
                <th className="px-4 py-3">Capture %</th>
              </tr>
            </thead>
            <tbody className={TBODY_CLS}>
              {rollupList.map((r) => (
                <tr key={`${r.beekeeper_user_id}-${r.site_number}`}>
                  <td className="px-4 py-3 font-semibold">{r.greeter_name}</td>
                  <td className="px-4 py-3 text-splash-navy/80">
                    <div>{r.location_code}</div>
                    <div className="font-mono text-xs text-splash-navy/60">
                      {r.site_number}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-splash-navy/80">
                    {r.days_logged}
                  </td>
                  <td className="px-4 py-3 text-splash-navy/80">
                    {num(r.total_cars)}
                  </td>
                  <td className="px-4 py-3 text-splash-navy/80">
                    {num(r.wash_sales)}
                  </td>
                  <td className="px-4 py-3 text-splash-navy/80">
                    {money(r.package_dollars)}
                  </td>
                  <td className="px-4 py-3 text-splash-navy/80">
                    {money(r.extras_dollars)}
                  </td>
                  <td className="px-4 py-3 font-semibold">{dobCell(r.dob)}</td>
                  <td className="px-4 py-3 text-splash-navy/80">
                    {num(r.sign_ups)}
                    {r.sign_up_goal !== null ? (
                      <span className="text-xs text-splash-navy/50">
                        {" "}
                        / {r.sign_up_goal}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 font-semibold">
                    {pct(r.capture_pct)}
                  </td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Card>

      {/* Daily rows */}
      <Card title="Daily rows">
        {dayList.length === 0 ? (
          <EmptyNote>Nothing logged for these filters yet.</EmptyNote>
        ) : (
          <TableWrap>
            <thead className={THEAD_CLS}>
              <tr>
                <th className="px-4 py-3">Date</th>
                <th className="px-4 py-3">Greeter</th>
                <th className="px-4 py-3">Site</th>
                <th className="px-4 py-3">Total cars</th>
                <th className="px-4 py-3">Wash sales</th>
                <th className="px-4 py-3">Package $</th>
                <th className="px-4 py-3">Extras $</th>
                <th className="px-4 py-3">D.O.B.</th>
                <th className="px-4 py-3">Sign ups</th>
                <th className="px-4 py-3">Capture %</th>
              </tr>
            </thead>
            <tbody className={TBODY_CLS}>
              {dayList.map((r) => (
                <tr key={r.id}>
                  <td className="px-4 py-3 font-mono text-xs text-splash-navy/80">
                    {r.business_date}
                  </td>
                  <td className="px-4 py-3 font-semibold">
                    {r.greeter_name ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-splash-navy/80">
                    <div>{r.location_code}</div>
                    <div className="font-mono text-xs text-splash-navy/60">
                      {r.site_number}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-splash-navy/80">
                    {num(r.total_cars)}
                  </td>
                  <td className="px-4 py-3 text-splash-navy/80">
                    {num(r.wash_sales)}
                  </td>
                  <td className="px-4 py-3 text-splash-navy/80">
                    {money(r.package_dollars)}
                  </td>
                  <td className="px-4 py-3 text-splash-navy/80">
                    {money(r.extras_dollars)}
                  </td>
                  <td className="px-4 py-3 font-semibold">{dobCell(r.dob)}</td>
                  <td className="px-4 py-3 text-splash-navy/80">
                    {num(r.sign_ups)}
                    {r.sign_up_goal !== null ? (
                      <span className="text-xs text-splash-navy/50">
                        {" "}
                        / {r.sign_up_goal}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 font-semibold">
                    {pct(r.capture_pct)}
                  </td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Card>

      {/* Site-wide rows */}
      <Card
        title="Site-wide days"
        subtitle="Full-day location totals, logged separately from the individual greeters."
      >
        {locationDayList.length === 0 ? (
          <EmptyNote>No site-wide days match these filters.</EmptyNote>
        ) : (
          <TableWrap>
            <thead className={THEAD_CLS}>
              <tr>
                <th className="px-4 py-3">Date</th>
                <th className="px-4 py-3">Site</th>
                <th className="px-4 py-3">Total cars</th>
                <th className="px-4 py-3">Wash sales</th>
                <th className="px-4 py-3">Package $</th>
                <th className="px-4 py-3">Extras $</th>
                <th className="px-4 py-3">D.O.B.</th>
                <th className="px-4 py-3">Sign ups</th>
                <th className="px-4 py-3">Capture %</th>
              </tr>
            </thead>
            <tbody className={TBODY_CLS}>
              {locationDayList.map((r) => (
                <tr key={r.id}>
                  <td className="px-4 py-3 font-mono text-xs text-splash-navy/80">
                    {r.business_date}
                  </td>
                  <td className="px-4 py-3 text-splash-navy/80">
                    <div>{r.location_code}</div>
                    <div className="font-mono text-xs text-splash-navy/60">
                      {r.site_number}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-splash-navy/80">
                    {num(r.total_cars)}
                  </td>
                  <td className="px-4 py-3 text-splash-navy/80">
                    {num(r.wash_sales)}
                  </td>
                  <td className="px-4 py-3 text-splash-navy/80">
                    {money(r.package_dollars)}
                  </td>
                  <td className="px-4 py-3 text-splash-navy/80">
                    {money(r.extras_dollars)}
                  </td>
                  <td className="px-4 py-3 font-semibold">{dobCell(r.dob)}</td>
                  <td className="px-4 py-3 text-splash-navy/80">
                    {num(r.sign_ups)}
                  </td>
                  <td className="px-4 py-3 font-semibold">
                    {pct(r.capture_pct)}
                  </td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Card>

      {/* Write cards */}
      <div className="mb-6 rounded-splash-lg border border-gray-light bg-white p-6 shadow-splash-card">
        <h2 className="mb-1 text-lg font-bold text-splash-navy">
          Log a greeter&rsquo;s day
        </h2>
        <p className="mb-4 text-xs text-splash-navy/60">
          One row per greeter per day. Submitting the same greeter and date
          again updates that row rather than adding a second one. D.O.B. and
          capture % are calculated for you.
        </p>
        <GreeterDayForm action={submitGreeterDayAction} defaultDate={today} />
      </div>

      <div className="mb-6 rounded-splash-lg border border-gray-light bg-white p-6 shadow-splash-card">
        <h2 className="mb-1 text-lg font-bold text-splash-navy">
          Log site-wide numbers
        </h2>
        <p className="mb-4 text-xs text-splash-navy/60">
          The whole location&rsquo;s day, not attributed to anyone. Same
          metrics; one row per site per day.
        </p>
        <form action={submitLocationDayAction} className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className={LABEL_CLS}>Date *</span>
              <input
                type="date"
                name="business_date"
                required
                defaultValue={today}
                className={INPUT_CLS}
              />
            </label>
            <div className="flex flex-col gap-1">
              <span className={LABEL_CLS}>Location *</span>
              <LocationPicker
                name="location_id"
                required
                placeholder="Search by site number, name, or code…"
              />
            </div>
          </div>
          <MetricFields />
          <div className="mt-1">
            <button
              type="submit"
              className="inline-flex items-center gap-1.5 rounded-splash-sm bg-splash-blue px-5 py-2.5 text-sm font-bold text-white shadow-splash-btn transition-colors hover:bg-splash-blue-dark"
            >
              Save site-wide day
            </button>
          </div>
        </form>
      </div>

      <div className="rounded-splash-lg border border-gray-light bg-white p-6 shadow-splash-card">
        <h2 className="mb-1 text-lg font-bold text-splash-navy">
          Set goals for a site
        </h2>
        <p className="mb-4 text-xs text-splash-navy/60">
          Goals apply to a location for a date range and are copied onto each
          day as it&rsquo;s logged — changing them later won&rsquo;t re-grade
          days already submitted. Leave the end date blank for an open-ended
          goal. Ranges for one site can&rsquo;t overlap.
        </p>
        <form action={createGoalAction} className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div className="flex flex-col gap-1">
              <span className={LABEL_CLS}>Location *</span>
              <LocationPicker
                name="location_id"
                required
                placeholder="Search by site number, name, or code…"
              />
            </div>
            <label className="flex flex-col gap-1">
              <span className={LABEL_CLS}>Effective from *</span>
              <input
                type="date"
                name="effective_from"
                required
                className={INPUT_CLS}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className={LABEL_CLS}>Effective to</span>
              <input type="date" name="effective_to" className={INPUT_CLS} />
            </label>
            <label className="flex flex-col gap-1">
              <span className={LABEL_CLS}>Sign up goal *</span>
              <input
                type="number"
                name="sign_up_goal"
                min="0"
                step="1"
                required
                placeholder="0"
                className={INPUT_CLS}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className={LABEL_CLS}>Extras goal ($) *</span>
              <input
                type="number"
                name="extras_goal"
                min="0"
                step="0.01"
                required
                placeholder="0.00"
                className={INPUT_CLS}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className={LABEL_CLS}>Note</span>
              <input
                type="text"
                name="note"
                maxLength={500}
                placeholder="Optional"
                className={INPUT_CLS}
              />
            </label>
          </div>
          <div className="mt-1">
            <button
              type="submit"
              className="inline-flex items-center gap-1.5 rounded-splash-sm bg-splash-blue px-5 py-2.5 text-sm font-bold text-white shadow-splash-btn transition-colors hover:bg-splash-blue-dark"
            >
              Save goal
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}

/* ============================================================
 * Shared classes + small presentational pieces
 * ============================================================ */

const LABEL_CLS =
  "text-xs font-semibold uppercase tracking-wider text-splash-navy/70";
const INPUT_CLS =
  "rounded-splash-sm border border-gray-light bg-white px-3 py-2 text-sm text-splash-navy placeholder:text-splash-navy/40 focus:border-splash-blue focus:outline-none";
const THEAD_CLS =
  "bg-splash-navy/5 text-left text-xs font-semibold uppercase tracking-wider text-splash-navy/70";
const TBODY_CLS = "divide-y divide-gray-light text-splash-navy";

function Card({
  title,
  subtitle,
  children
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <div className="mb-6 overflow-hidden rounded-splash-lg border border-gray-light bg-white shadow-splash-card">
      <div className="border-b border-gray-light px-5 py-4">
        <h2 className="text-lg font-bold text-splash-navy">{title}</h2>
        {subtitle ? (
          <p className="mt-1 text-xs text-splash-navy/60">{subtitle}</p>
        ) : null}
      </div>
      {children}
    </div>
  );
}

function TableWrap({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-gray-light text-sm">
        {children}
      </table>
    </div>
  );
}

function EmptyNote({ children }: { children: ReactNode }) {
  return <p className="px-5 py-6 text-sm text-splash-navy/70">{children}</p>;
}

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
        href="/admin/greeters"
        className="text-xs font-semibold underline underline-offset-2 hover:text-splash-deny/80"
      >
        Dismiss
      </Link>
    </div>
  );
}

function SuccessBanner({ message }: { message: string }) {
  return (
    <div
      role="status"
      className="mb-5 flex flex-col gap-2 rounded-splash-md border border-splash-success/40 bg-splash-success/10 p-4 text-sm text-splash-success sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex-1">
        <span className="font-bold">{message}</span>
      </div>
      <Link
        href="/admin/greeters"
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
      <h1 className="text-2xl font-bold text-splash-navy">Greeter Scorecard</h1>
    </div>
  );
}
