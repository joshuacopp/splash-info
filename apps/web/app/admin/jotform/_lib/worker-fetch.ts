// Server-side fetch helpers for the jotform-worker admin endpoints (Brief 109).
// Mirrors apps/web/app/admin/fleet/_lib/worker-fetch.ts (Brief 83) —
// service-binding-first, URL-fallback for `next dev`.
//
// Bindings live in apps/web/wrangler.toml (`JOTFORM_WORKER`); the dev
// fallback URL comes from `NEXT_PUBLIC_JOTFORM_WORKER_URL` when set,
// otherwise the request host (apps/web staging is on the same zone via
// next.config.mjs rewrites — `splash-jotform` is path-carved under
// `/admin/jotform/api/*` per Brief 107). Same-origin pattern means the
// CSV-download URL is just a relative path — no Brief 88-style proxy
// route is needed (that was specific to fleet's subdomain split).

import { cookies, headers } from "next/headers";
import { getCloudflareContext } from "@opennextjs/cloudflare";

// =============================================================================
// Response shapes — mirror apps/jotform-worker/src/handlers/admin.js
// =============================================================================

export interface JotformForm {
  form_id: string;
  slug: string;
  display_name: string;
  enabled: boolean;
  submission_count: number;
}

export interface JotformFormsResponse {
  forms: JotformForm[];
  /**
   * Brief 151 — `"scoped"` when the caller is RM / RD / GM / location_admin
   * and per-form counts reflect only `site_number`s in their accessible
   * set. `"all"` for admin-tier callers (super_admin / admin / dcRole
   * admin/super_admin) where counts are unscoped totals.
   */
  scope?: "all" | "scoped";
}

/**
 * One row of `jotform_submissions`. `answers` is the JSONB payload of
 * per-field entries keyed by JotForm's `name` attribute; each entry is
 * typically `{answer, prettyFormat?, type, name, text}` but the renderer
 * treats it as generic JSON to stay schema-agnostic.
 */
export interface JotformSubmissionRow {
  id: string;
  form_id: string;
  site_number: string | null;
  site: string | null;
  site_email: string | null;
  jotform_created_at: string | null;
  jotform_updated_at: string | null;
  jotform_status: string | null;
  answers: Record<string, unknown>;
}

export interface JotformSubmissionsListResponse {
  rows: JotformSubmissionRow[];
  count: number;
  total: number;
  total_estimate: number;
  limit: number;
  offset: number;
  from: string;
  to: string;
  scope: "all" | "scoped";
}

export interface JotformSubmissionDetailResponse {
  row: JotformSubmissionRow;
}

export interface JotformSubmissionsListParams {
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
  siteNumber?: string;
  amEmail?: string;
  rmEmail?: string;
  locationCode?: string;
}

// Brief 115 — grouped + count-only response shapes for the
// `/submissions?group=location` and `?count_only=1` worker modes.
export interface JotformSubmissionsGroup {
  site: string;
  site_number: string;
  rm_email: string | null;
  rm_name: string | null;
  count: number;
  rows: JotformSubmissionRow[];
}

export interface JotformSubmissionsGroupedResponse {
  groups: JotformSubmissionsGroup[];
  total_rows: number;
  cap_reached: boolean;
  from: string;
  to: string;
  scope: "all" | "scoped";
}

export interface JotformSubmissionsCountOnlyResponse {
  total_rows: number;
  from: string;
  to: string;
  scope: "all" | "scoped";
}

// =============================================================================
// Brief 110 — roster response shapes
// =============================================================================

export interface RosterAm {
  email: string;
  name: string;
  site_numbers: string[];
}

export interface RosterRm {
  email: string;
  name: string;
  site_numbers: string[];
}

export interface RosterLocation {
  location_code: string;
  site_number: string;
  location_pretty: string;
  am_email: string | null;
  rm_email: string | null;
}

export interface JotformRoster {
  regional_directors: RosterAm[];
  regional_managers: RosterRm[];
  locations: RosterLocation[];
  scope: "all" | "scoped";
}

// =============================================================================
// Internal dispatch — service binding first, URL fallback for next dev
// =============================================================================

async function workerUrl(path: string): Promise<string> {
  const trimmed = path.startsWith("/") ? path : `/${path}`;
  const base = process.env.NEXT_PUBLIC_JOTFORM_WORKER_URL;
  if (base) return `${base}${trimmed}`;
  const headerStore = await headers();
  const host = headerStore.get("host") ?? "localhost:3000";
  const proto = headerStore.get("x-forwarded-proto") ?? "https";
  return `${proto}://${host}${trimmed}`;
}

async function jotformGetJson<T>(path: string): Promise<T | null> {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore.toString();

  let resp: Response;
  try {
    const { env } = await getCloudflareContext({ async: true });
    if (env.JOTFORM_WORKER) {
      const trimmed = path.startsWith("/") ? path : `/${path}`;
      const url = `https://internal${trimmed}`;
      const req = new Request(url, {
        method: "GET",
        headers: {
          Cookie: cookieHeader,
          Origin: new URL(url).origin
        }
      });
      resp = await env.JOTFORM_WORKER.fetch(req);
    } else {
      const url = await workerUrl(path);
      resp = await fetch(url, {
        method: "GET",
        headers: {
          Cookie: cookieHeader,
          Origin: new URL(url).origin
        },
        cache: "no-store"
      });
    }
  } catch {
    const url = await workerUrl(path);
    resp = await fetch(url, {
      method: "GET",
      headers: {
        Cookie: cookieHeader,
        Origin: new URL(url).origin
      },
      cache: "no-store"
    });
  }

  if (resp.status === 401 || resp.status === 403) return null;
  if (resp.status === 404) {
    // Detail endpoint anti-leak: out-of-scope returns 404 not 403, so a
    // null collapse here is the right call for both "not found" and
    // "exists but not yours".
    return null;
  }
  if (!resp.ok) {
    throw new Error(`Jotform worker GET ${path} failed: ${resp.status}`);
  }
  return (await resp.json()) as T;
}

// =============================================================================
// Public helpers
// =============================================================================

export async function listForms(): Promise<JotformFormsResponse | null> {
  return jotformGetJson<JotformFormsResponse>("/admin/jotform/api/forms");
}

function buildSubmissionsQuery(
  params: JotformSubmissionsListParams,
  extras: Record<string, string> = {}
): string {
  const sp = new URLSearchParams();
  if (params.from) sp.set("from", params.from);
  if (params.to) sp.set("to", params.to);
  if (params.limit != null) sp.set("limit", String(params.limit));
  if (params.offset != null) sp.set("offset", String(params.offset));
  if (params.siteNumber) sp.set("site_number", params.siteNumber);
  if (params.amEmail) sp.set("am_email", params.amEmail);
  if (params.rmEmail) sp.set("rm_email", params.rmEmail);
  if (params.locationCode) sp.set("location_code", params.locationCode);
  for (const [k, v] of Object.entries(extras)) sp.set(k, v);
  const qs = sp.toString();
  return qs ? `?${qs}` : "";
}

export async function listSubmissions(
  formId: string,
  params: JotformSubmissionsListParams = {}
): Promise<JotformSubmissionsListResponse | null> {
  return jotformGetJson<JotformSubmissionsListResponse>(
    `/admin/jotform/api/${encodeURIComponent(formId)}/submissions${buildSubmissionsQuery(params)}`
  );
}

/**
 * Brief 115 — fetch the full grouped-by-site response for a form. The
 * worker pulls every row in scope (up to 2000), sorts groups
 * alphabetically by site, and returns one bucket per location with
 * pre-resolved RM info. apps/web renders without further pagination.
 */
export async function listSubmissionsGrouped(
  formId: string,
  params: JotformSubmissionsListParams = {}
): Promise<JotformSubmissionsGroupedResponse | null> {
  return jotformGetJson<JotformSubmissionsGroupedResponse>(
    `/admin/jotform/api/${encodeURIComponent(formId)}/submissions${buildSubmissionsQuery(
      params,
      { group: "location" }
    )}`
  );
}

/**
 * Brief 115 — count-only summary for the role-aware admin-tier gate
 * (and the "narrow your range or apply a filter" prompt for any
 * caller asking for a date range beyond today without a filter).
 */
export async function listSubmissionsCount(
  formId: string,
  params: JotformSubmissionsListParams = {}
): Promise<JotformSubmissionsCountOnlyResponse | null> {
  return jotformGetJson<JotformSubmissionsCountOnlyResponse>(
    `/admin/jotform/api/${encodeURIComponent(formId)}/submissions${buildSubmissionsQuery(
      params,
      { count_only: "1" }
    )}`
  );
}

export async function getSubmission(
  formId: string,
  subId: string
): Promise<JotformSubmissionDetailResponse | null> {
  return jotformGetJson<JotformSubmissionDetailResponse>(
    `/admin/jotform/api/${encodeURIComponent(formId)}/submissions/${encodeURIComponent(subId)}`
  );
}

/**
 * Build the CSV download URL with the current filter params. Used by the
 * `<CsvExportButton>` — the URL is consumed by the user's browser, not the
 * apps/web Worker. Same-origin works because splash-jotform is path-carved
 * on apps/web's hostname (per Brief 89 / Brief 107 convention).
 */
export function csvExportUrl(
  formId: string,
  params: {
    from?: string;
    to?: string;
    siteNumber?: string;
    amEmail?: string;
    rmEmail?: string;
    locationCode?: string;
  } = {}
): string {
  const sp = new URLSearchParams();
  if (params.from) sp.set("from", params.from);
  if (params.to) sp.set("to", params.to);
  if (params.siteNumber) sp.set("site_number", params.siteNumber);
  if (params.amEmail) sp.set("am_email", params.amEmail);
  if (params.rmEmail) sp.set("rm_email", params.rmEmail);
  if (params.locationCode) sp.set("location_code", params.locationCode);
  const qs = sp.toString();
  return `/admin/jotform/api/${encodeURIComponent(formId)}/submissions.csv${qs ? `?${qs}` : ""}`;
}

/**
 * Brief 110 — load the RD / RM / Location roster scoped to the caller.
 * Backs the FilterBar dropdowns on /admin/jotform/[form_id]. Returns null
 * if the caller is unauthenticated (the worker 401s without a session).
 */
export async function getRoster(): Promise<JotformRoster | null> {
  return jotformGetJson<JotformRoster>("/admin/jotform/api/roster");
}

/**
 * Brief 113 — build a same-origin proxy URL for a JotForm-hosted asset
 * (signatures, file uploads). The browser loads the proxy URL with the
 * apps/web session cookie; the worker validates auth, fetches the
 * JotForm asset with the API key, and streams it back. No raw
 * cross-origin <img src=jotform.com> loads anywhere.
 */
export function assetProxyUrl(jotformUrl: string): string {
  return `/admin/jotform/api/asset?url=${encodeURIComponent(jotformUrl)}`;
}
