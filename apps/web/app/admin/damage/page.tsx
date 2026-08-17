// Damage claims list page (/admin/damage).
//
// Server component. Reads ?search / ?location / ?status / ?lifecycle from
// the URL, calls damage-worker GET /manage/api/claims, and renders a filter
// bar + claims table.
//
// Per Brief 5a: list page only. The detail page at /admin/damage/[id] lands
// in Brief 5b — row links target it but a 404 there is acceptable until then.
// Write actions (transitions / notes / docs) are 5c/5d.
//
// Auth posture: damage-worker handles auth + dc_role scoping. damageGetJson
// returns null on 401/403 — both "no claims tool grant" and "no damage role
// assigned" land in the same null branch. Distinguishing them needs a body
// peek the helper currently throws away; flagged for 5b if it matters.

import Link from "next/link";
import { damageGetJson, damageGetJsonOrStatus } from "./_lib/worker-fetch";
import { LifecycleBadge } from "./_components/LifecycleBadge";
import { AgePill } from "./_components/AgePill";
import { DamageTabs } from "./_components/DamageTabs";
import { StatusActionPill } from "./_components/StatusActionPill";
import { CsvExportButton } from "../../_components/CsvExportButton";
import {
  type ClaimRow,
  type ClaimStatus,
  type LifecycleState,
  displayLifecycleForStatus
} from "@splash/types/claims";

// Brief 172 — list-page lifecycle picker is a 4-way URL value (the third
// "Awaiting Payment" bucket is derived in the worker from claim_status;
// stored lifecycle_state stays binary).
type LifecycleParam = LifecycleState | "Awaiting Payment" | "All";

// Brief 59 — shape returned from /manage/api/contact-roster.
interface ContactRosterEntry {
  email: string;
  name: string;
  location_codes: string[];
}

// What the worker actually returns from GET /manage/api/claims — the D1
// listClaims helper (packages/db-d1/src/claims.ts) selects a subset of
// columns. Keep this aligned with CLAIMS_LIST_COLS there.
//
// Brief 68: `age_days` is appended by the SELECT projection (computed via
// julianday() arithmetic at query time; not a stored column on `claims`).
type ClaimListRow = Pick<
  ClaimRow,
  | "claim_id"
  | "location_code"
  | "location_pretty"
  | "customer_name"
  | "vehicle_year"
  | "vehicle_make"
  | "vehicle_model"
  | "submitted_at"
  | "claim_status"
  | "lifecycle_state"
  | "contact_status"
> & {
  age_days: number;
};

// Full ClaimStatus enum, ordered as in the type union for legibility (15 values).
// Em-dashes are U+2014. NOTE (2026-08-17): the old comment here said this
// "matches the DB CHECK constraint" — there is no CHECK on claim_status; the
// live DDL has it as plain TEXT. The em-dashes still matter, but nothing in
// the database will catch a hyphen — it would insert fine and then vanish
// from this filter. See packages/types/src/claims.ts.
const CLAIM_STATUSES: ReadonlyArray<ClaimStatus> = [
  "New — Pending Review",
  "No Responsibility — Pending Review",
  "Pending GM Review",
  "Pending RM Review",
  "Approved — Pending Quotes",
  "Pending RM Quote Approval",
  "Approved — In House — Parts Ordered",
  "Approved — Check Request Submitted",
  "Approved — Submitted for Payment",
  "Approved — Pending CEO Approval",
  "Approved — Check Issued",
  "Closed — Paid",
  "Closed — Denied",
  "Closed — Approved/No Response",
  "Closed — Settled"
];

const LIFECYCLE_OPTIONS: ReadonlyArray<LifecycleParam> = [
  "Open",
  "Awaiting Payment",
  "Closed",
  "All"
];

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function firstParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

function formatVehicle(row: ClaimListRow): string {
  const parts = [row.vehicle_year, row.vehicle_make, row.vehicle_model]
    .map((p) => (p === null || p === undefined || p === "" ? null : String(p)))
    .filter((p): p is string => p !== null);
  return parts.length === 0 ? "—" : parts.join(", ");
}

function formatSubmittedDate(iso: string): string {
  // ISO timestamps from D1 start with YYYY-MM-DD; slice avoids timezone math.
  return iso.length >= 10 ? iso.slice(0, 10) : iso;
}

export default async function DamageClaimsListPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const search = firstParam(sp.search).trim();
  const locationParam = firstParam(sp.location) || "All";
  const statusParam = firstParam(sp.status) || "All";
  const lifecycleRaw = firstParam(sp.lifecycle) || "All";
  const lifecycleParam: LifecycleParam =
    lifecycleRaw === "Closed" ||
    lifecycleRaw === "All" ||
    lifecycleRaw === "Awaiting Payment"
      ? lifecycleRaw
      : "Open";
  const rdEmailParam = firstParam(sp.regional_director_email).trim();
  const rmEmailParam = firstParam(sp.regional_manager_email).trim();
  const submittedFromParam = firstParam(sp.submitted_from).trim();
  const submittedToParam = firstParam(sp.submitted_to).trim();

  // Build worker query string, omitting empty filters.
  const qs = new URLSearchParams();
  if (search) qs.set("search", search);
  if (locationParam && locationParam !== "All") qs.set("location", locationParam);
  if (statusParam && statusParam !== "All") qs.set("status", statusParam);
  qs.set("lifecycle", lifecycleParam);
  if (rdEmailParam) qs.set("regional_director_email", rdEmailParam);
  if (rmEmailParam) qs.set("regional_manager_email", rmEmailParam);
  if (submittedFromParam) qs.set("submitted_from", submittedFromParam);
  if (submittedToParam) qs.set("submitted_to", submittedToParam);
  const workerPath = `/manage/api/claims${qs.toString() ? `?${qs.toString()}` : ""}`;

  // This page is a server component that reads every filter out of the URL,
  // so "go back to the list" only preserves the user's filters if the detail
  // page knows what they were. Carry the same querystring into each row link;
  // the detail page's BackLink hands it straight back. The param names are
  // identical on both sides (they're read back out of `sp` above), so the
  // worker querystring can be reused verbatim as a UI one.
  const detailHref = (claimId: string) =>
    `/admin/damage/${encodeURIComponent(claimId)}${
      qs.toString() ? `?${qs.toString()}` : ""
    }`;

  // Use damageGetJsonOrStatus for the claims fetch so we can distinguish
  // 401 (no/invalid cookie — typically a stale session post forced-reset;
  // Brief 147) from 403 (cookie valid, but no claims tool or no dc_role).
  // The roster fetches keep the null-on-401/403 shape — they're decorative
  // and don't drive routing.
  let claimsResult:
    | { kind: "ok"; data: ClaimListRow[] }
    | { kind: "denied" }
    | { kind: "session_stale" }
    | { kind: "error"; message: string }
    | null = null;
  let rdRoster: ContactRosterEntry[] = [];
  let rmRoster: ContactRosterEntry[] = [];
  try {
    const [claimsRaw, rd, rm] = await Promise.all([
      damageGetJsonOrStatus<ClaimListRow[]>(workerPath),
      damageGetJson<ContactRosterEntry[]>(
        "/manage/api/contact-roster?role=regional_director"
      ).then((r) => r ?? []),
      damageGetJson<ContactRosterEntry[]>(
        "/manage/api/contact-roster?role=regional_manager"
      ).then((r) => r ?? [])
    ]);
    rdRoster = rd;
    rmRoster = rm;
    if ("data" in claimsRaw) {
      claimsResult = { kind: "ok", data: claimsRaw.data };
    } else if (claimsRaw.status === 401) {
      claimsResult = { kind: "session_stale" };
    } else if (claimsRaw.status === 403) {
      claimsResult = { kind: "denied" };
    } else {
      claimsResult = {
        kind: "error",
        message: `Worker GET ${workerPath} failed: ${claimsRaw.status}`
      };
    }
  } catch (err) {
    claimsResult = {
      kind: "error",
      message: err instanceof Error ? err.message : "Unknown error fetching claims."
    };
  }

  // Brief 147 — split the legacy "no access" branch into two:
  //   401 → session-not-loaded (stale cookie, common iOS Safari case post
  //         forced-reset). Surface a "Sign in again" CTA that hard-navs to
  //         /logout (clears cookies, then bounces to /login), which is the
  //         user-recoverable path. Old copy implied "your administrator
  //         needs to do something" — wrong + scary for the common case.
  //   403 → genuinely no access (no claims tool grant or no dc_role).
  //         Keep the operational "contact your administrator" copy.
  if (claimsResult && claimsResult.kind !== "ok" && claimsResult.kind !== "error") {
    const currentQs = new URLSearchParams();
    if (search) currentQs.set("search", search);
    if (locationParam && locationParam !== "All") currentQs.set("location", locationParam);
    if (statusParam && statusParam !== "All") currentQs.set("status", statusParam);
    if (lifecycleParam !== "All") currentQs.set("lifecycle", lifecycleParam);
    if (rdEmailParam) currentQs.set("regional_director_email", rdEmailParam);
    if (rmEmailParam) currentQs.set("regional_manager_email", rmEmailParam);
    if (submittedFromParam) currentQs.set("submitted_from", submittedFromParam);
    if (submittedToParam) currentQs.set("submitted_to", submittedToParam);
    const returnPath = `/admin/damage${currentQs.toString() ? `?${currentQs.toString()}` : ""}`;

    if (claimsResult.kind === "session_stale") {
      return (
        <section className="mx-auto w-full max-w-[1100px] px-5 py-9">
          <DamageTabs active="claims" />
          <PageBanner />
          <div className="rounded-splash-lg border border-gray-light bg-white p-6 shadow-splash-card">
            <p className="mb-4 text-splash-navy/80">
              Session expired or hasn&rsquo;t fully loaded. Try refreshing
              the page or signing out and back in.
            </p>
            <Link
              href={`/logout?return=${encodeURIComponent(returnPath)}`}
              className="inline-flex items-center gap-1.5 rounded-splash-sm bg-splash-blue px-5 py-2.5 text-sm font-bold text-white shadow-splash-btn transition-colors hover:bg-splash-blue-dark"
            >
              Sign in again
            </Link>
          </div>
        </section>
      );
    }

    // claimsResult.kind === "denied"
    return (
      <section className="mx-auto w-full max-w-[1100px] px-5 py-9">
        <DamageTabs active="claims" />
        <PageBanner />
        <div className="rounded-splash-lg border border-gray-light bg-white p-6 shadow-splash-card">
          <p className="mb-4 text-splash-deny">
            You don&rsquo;t have access to Damage Claims. Contact your
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

  const fetchError =
    claimsResult && claimsResult.kind === "error" ? claimsResult.message : null;
  const claims =
    claimsResult && claimsResult.kind === "ok" ? claimsResult.data : null;

  // Error branch (5xx / network / malformed). Page reload retries.
  if (fetchError) {
    return (
      <section className="mx-auto w-full max-w-[1100px] px-5 py-9">
        <DamageTabs active="claims" />
        <PageBanner />
        <div className="rounded-splash-lg border border-gray-light bg-white p-6 shadow-splash-card">
          <h2 className="mb-2 text-lg font-bold text-splash-deny">
            Could not load claims
          </h2>
          <p className="text-sm text-splash-navy/80">{fetchError}</p>
          <p className="mt-2 text-sm text-splash-navy/60">
            Reload the page to retry.
          </p>
        </div>
      </section>
    );
  }

  const list = claims ?? [];

  // Derive the location dropdown options from the result set. v1 compromise:
  // locations with zero matching claims under the current filters won't
  // appear — preserve the currently-selected value as a fallback so the
  // dropdown doesn't visually drop a filter the user explicitly set.
  const locationMap = new Map<string, string>();
  for (const c of list) {
    if (!locationMap.has(c.location_code)) {
      locationMap.set(c.location_code, c.location_pretty);
    }
  }
  if (locationParam !== "All" && !locationMap.has(locationParam)) {
    locationMap.set(locationParam, locationParam);
  }
  const locationOptions = Array.from(locationMap.entries()).sort(
    ([, a], [, b]) => a.localeCompare(b)
  );

  return (
    <section className="mx-auto w-full max-w-[1100px] px-5 py-9">
      <DamageTabs active="claims" />
      <PageBanner />

      {/* Filter bar — pure server-rendered GET form. */}
      <form
        method="GET"
        action="/admin/damage"
        className="mb-5 rounded-splash-lg border border-gray-light bg-white p-5 shadow-splash-card"
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-semibold uppercase tracking-wider text-splash-navy/70">
              Search
            </span>
            <input
              type="text"
              name="search"
              defaultValue={search}
              placeholder="Search customer name…"
              className="rounded-splash-sm border border-gray-light bg-white px-3 py-2 text-sm text-splash-navy placeholder:text-splash-navy/40 focus:border-splash-blue focus:outline-none"
            />
          </label>

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
              {locationOptions.map(([code, pretty]) => (
                <option key={code} value={code}>
                  {pretty}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs font-semibold uppercase tracking-wider text-splash-navy/70">
              Status
            </span>
            <select
              name="status"
              defaultValue={statusParam}
              className="rounded-splash-sm border border-gray-light bg-white px-3 py-2 text-sm text-splash-navy focus:border-splash-blue focus:outline-none"
            >
              <option value="All">All</option>
              {CLAIM_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs font-semibold uppercase tracking-wider text-splash-navy/70">
              Lifecycle
            </span>
            <select
              name="lifecycle"
              defaultValue={lifecycleParam}
              className="rounded-splash-sm border border-gray-light bg-white px-3 py-2 text-sm text-splash-navy focus:border-splash-blue focus:outline-none"
            >
              {LIFECYCLE_OPTIONS.map((l) => (
                <option key={l} value={l}>
                  {l}
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

          <label className="flex flex-col gap-1">
            <span className="text-xs font-semibold uppercase tracking-wider text-splash-navy/70">
              Submitted from
            </span>
            <input
              type="date"
              name="submitted_from"
              defaultValue={submittedFromParam}
              className="rounded-splash-sm border border-gray-light bg-white px-3 py-2 text-sm text-splash-navy focus:border-splash-blue focus:outline-none"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs font-semibold uppercase tracking-wider text-splash-navy/70">
              Submitted to
            </span>
            <input
              type="date"
              name="submitted_to"
              defaultValue={submittedToParam}
              className="rounded-splash-sm border border-gray-light bg-white px-3 py-2 text-sm text-splash-navy focus:border-splash-blue focus:outline-none"
            />
          </label>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="submit"
            className="inline-flex items-center gap-1.5 rounded-splash-sm bg-splash-blue px-5 py-2.5 text-sm font-bold text-white shadow-splash-btn transition-colors hover:bg-splash-blue-dark"
          >
            Apply filters
          </button>
          <Link
            href="/admin/damage"
            className="text-sm font-semibold text-splash-blue hover:text-splash-blue-dark"
          >
            Reset
          </Link>
          {/*
           * Brief 172/178 — CSV + XLSX export. Both hrefs carry the SAME
           * filter params the page is currently rendering against so a
           * click downloads exactly the visible result set (no surprise
           * widening). Brief 88 proxy-route pattern: the links point at
           * apps/web's /admin/damage/export.csv|.xlsx, which proxy via the
           * DAMAGE_WORKER service binding internally so the browser stays
           * same-origin (cookies + auth all "just work"). Same rows/columns
           * in both; XLSX adds widths, a frozen bold header, autofilter,
           * wrapped note columns, and real date typing.
           */}
          <div className="ml-auto flex items-center gap-2">
            <CsvExportButton
              href={`/admin/damage/export.csv${qs.toString() ? `?${qs.toString()}` : ""}`}
            />
            <CsvExportButton
              href={`/admin/damage/export.xlsx${qs.toString() ? `?${qs.toString()}` : ""}`}
              label="Export XLSX"
            />
          </div>
        </div>
      </form>

      {/* Results card */}
      {list.length === 0 ? (
        <div className="rounded-splash-lg border border-gray-light bg-white p-6 shadow-splash-card">
          <p className="mb-3 text-splash-navy/80">
            No claims match these filters.
          </p>
          <Link
            href="/admin/damage"
            className="text-sm font-semibold text-splash-blue hover:text-splash-blue-dark"
          >
            Show all claims
          </Link>
        </div>
      ) : (
        <div className="overflow-hidden rounded-splash-lg border border-gray-light bg-white shadow-splash-card">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-light text-sm">
              <thead className="bg-splash-navy/5 text-left text-xs font-semibold uppercase tracking-wider text-splash-navy/70">
                <tr>
                  <th className="px-4 py-3">Claim ID</th>
                  <th className="px-4 py-3">Customer</th>
                  <th className="px-4 py-3">Vehicle</th>
                  <th className="px-4 py-3">Location</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Lifecycle</th>
                  <th className="px-4 py-3">Submitted</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-light text-splash-navy">
                {list.map((c) => (
                  <tr
                    key={c.claim_id}
                    className="cursor-pointer transition-colors hover:bg-sudsy-blue-soft/40"
                  >
                    <td className="px-4 py-3 font-mono text-xs">
                      <Link
                        href={detailHref(c.claim_id)}
                        className="text-splash-blue hover:text-splash-blue-dark"
                      >
                        {c.claim_id}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        href={detailHref(c.claim_id)}
                        className="block font-semibold text-splash-navy"
                      >
                        {c.customer_name}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-splash-navy/80">
                      {formatVehicle(c)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="text-splash-navy">{c.location_pretty}</div>
                      <div className="font-mono text-xs text-splash-navy/60">
                        {c.location_code}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-splash-navy/80">
                      <div className="flex flex-wrap items-center gap-2">
                        <span>{c.claim_status}</span>
                        <StatusActionPill status={c.claim_status} />
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      {/*
                       * Brief 172 — derive the 3-way bucket from
                       * claim_status. The stored `c.lifecycle_state` is
                       * binary (Open/Closed); awaiting-payment claims
                       * still carry Open but the badge surfaces the
                       * derived value so the operator sees finance-
                       * stage claims distinctly.
                       */}
                      <LifecycleBadge
                        state={displayLifecycleForStatus(c.claim_status)}
                      />
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-splash-navy/80">
                      <div className="flex items-center gap-2">
                        <span>{formatSubmittedDate(c.submitted_at)}</span>
                        <AgePill
                          ageDays={c.age_days}
                          lifecycle={displayLifecycleForStatus(c.claim_status)}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}

function PageBanner() {
  return (
    <div className="mb-6">
      <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-sudsy-blue">
        Internal Tools
      </p>
      <h1 className="text-2xl font-bold text-splash-navy">Damage Claims</h1>
    </div>
  );
}
