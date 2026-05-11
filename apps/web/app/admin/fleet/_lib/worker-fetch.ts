// Server-side fetch helpers for the fleet-inquiry-worker admin endpoints
// (Brief 83). Mirrors apps/web/app/admin/pricing/_lib/worker-fetch.ts —
// service-binding-first, URL-fallback for `next dev`.
//
// Bindings live in apps/web/wrangler.toml (`FLEET_INQUIRY_WORKER`); the dev
// fallback URL comes from `NEXT_PUBLIC_FLEET_INQUIRY_WORKER_URL` when set,
// otherwise the request host (apps/web staging is on the same zone via
// next.config.mjs rewrites).

import { cookies, headers } from "next/headers";
import { getCloudflareContext } from "@opennextjs/cloudflare";

export interface FleetSubmissionRow {
  id: string;
  created_at: string;
  submitted_at: string;
  company: string | null;
  name: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  location_code: string | null;
  location_pretty: string | null;
  service_type: string | null;
  packages: string | null;
  packages_detail: unknown;
  detailing_requested: boolean | null;
  detailing_location_code: string | null;
  detailing_location_pretty: string | null;
  number_of_vehicles: number | null;
  anticipated_washes_per_month: number | null;
  ip_address: string | null;
  user_agent: string | null;
  status: string | null;
  splash_notes: string | null;
}

export interface FleetSubmissionsListResponse {
  rows: FleetSubmissionRow[];
  count: number;
  total: number;
  from: string;
  to: string;
  limit: number;
  limit_hit: boolean;
}

export interface FleetSubmissionDetailResponse {
  row: FleetSubmissionRow;
}

export interface FleetSubmissionsListParams {
  from?: string;
  to?: string;
  limit?: number;
}

async function workerUrl(path: string): Promise<string> {
  const trimmed = path.startsWith("/") ? path : `/${path}`;
  const base = process.env.NEXT_PUBLIC_FLEET_INQUIRY_WORKER_URL;
  if (base) return `${base}${trimmed}`;
  const headerStore = await headers();
  const host = headerStore.get("host") ?? "localhost:3000";
  const proto = headerStore.get("x-forwarded-proto") ?? "https";
  return `${proto}://${host}${trimmed}`;
}

async function fleetGetJson<T>(path: string): Promise<T | null> {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore.toString();

  let resp: Response;
  try {
    const { env } = await getCloudflareContext({ async: true });
    if (env.FLEET_INQUIRY_WORKER) {
      const trimmed = path.startsWith("/") ? path : `/${path}`;
      const url = `https://internal${trimmed}`;
      const req = new Request(url, {
        method: "GET",
        headers: {
          Cookie: cookieHeader,
          Origin: new URL(url).origin
        }
      });
      resp = await env.FLEET_INQUIRY_WORKER.fetch(req);
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
    // Caller distinguishes "no access" vs "row not found" via a separate
    // entry point (getFleetSubmission throws); this generic helper treats
    // 404 the same as a missing row.
    return null;
  }
  if (!resp.ok) {
    throw new Error(`Fleet worker GET ${path} failed: ${resp.status}`);
  }
  return (await resp.json()) as T;
}

function buildQuery(params: FleetSubmissionsListParams): string {
  const sp = new URLSearchParams();
  if (params.from) sp.set("from", params.from);
  if (params.to) sp.set("to", params.to);
  if (params.limit != null) sp.set("limit", String(params.limit));
  const qs = sp.toString();
  return qs ? `?${qs}` : "";
}

export async function getFleetSubmissions(
  params: FleetSubmissionsListParams = {}
): Promise<FleetSubmissionsListResponse | null> {
  return fleetGetJson<FleetSubmissionsListResponse>(
    `/admin/api/submissions${buildQuery(params)}`
  );
}

export async function getFleetSubmission(
  id: string
): Promise<FleetSubmissionDetailResponse | null> {
  return fleetGetJson<FleetSubmissionDetailResponse>(
    `/admin/api/submissions/${encodeURIComponent(id)}`
  );
}

/**
 * Build the CSV download URL with the current filter params. Used by the
 * `<CsvExportButton>` — the URL is consumed by the user's browser, not the
 * apps/web Worker.
 *
 * Brief 88: points at the apps/web proxy route at
 * `/admin/fleet/export.csv`, NOT at the fleet worker directly. The fleet
 * worker lives on a separate subdomain
 * (`fleet.staging.splashcarwashes.info` per Brief 82) so a same-origin
 * relative URL on this button doesn't reach it — apps/web has no route
 * at `/admin/api/submissions.csv` and Next renders 404 HTML the browser
 * saves as `submissions.txt`. The proxy route forwards the request via
 * the `FLEET_INQUIRY_WORKER` service binding internally and streams the
 * upstream CSV body back with `Content-Disposition` preserved (correct
 * filename) — zero cross-domain cookie / CORS issues. The
 * `NEXT_PUBLIC_FLEET_INQUIRY_WORKER_URL` env var is no longer consumed
 * here; the proxy route's URL fallback uses it for `next dev`.
 */
export function getFleetCsvUrl(params: FleetSubmissionsListParams = {}): string {
  return `/admin/fleet/export.csv${buildQuery(params)}`;
}

/**
 * PATCH /admin/api/submissions/{id} body shape (Brief 87 + Brief 105).
 *
 * Either or both fields must be present. The worker rejects all-absent
 * bodies with 400, and re-validates `status` against the four-value enum
 * server-side. Caller responsibility (here in the helper or in the calling
 * server action) is to provide at least one field — but the helper does
 * NOT enforce that locally; the worker's 400 is the single source of
 * truth.
 */
export interface UpdateFleetSubmissionInput {
  splashNotes?: string;
  status?: string;
}

/**
 * PATCH /admin/api/submissions/{id} with a `{splash_notes?, status?}` body.
 *
 * Brief 87 added the original notes-only PATCH; Brief 105 widened it to
 * accept either or both `splash_notes` and `status`, stamps the
 * per-field `*_updated_{at,by}` audit columns, and fires the
 * `FLEET_SUBMISSION_UPDATE_WEBHOOK_URL` per-edit webhook for SharePoint
 * sync.
 *
 * Mirrors the binding-first / URL-fallback shape of `fleetGetJson` —
 * service binding for prod (apps/web Worker → fleet-inquiry-worker on the
 * same zone), URL fetch for `next dev` where bindings aren't available.
 * Throws on non-2xx so the calling server action can surface a typed
 * ActionResult error.
 */
export async function updateFleetSubmission(
  id: string,
  input: UpdateFleetSubmissionInput
): Promise<void> {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore.toString();
  const path = `/admin/api/submissions/${encodeURIComponent(id)}`;
  const body: Record<string, string> = {};
  if (input.splashNotes !== undefined) body.splash_notes = input.splashNotes;
  if (input.status !== undefined) body.status = input.status;
  const bodyJson = JSON.stringify(body);

  let resp: Response;
  try {
    const { env } = await getCloudflareContext({ async: true });
    if (env.FLEET_INQUIRY_WORKER) {
      const url = `https://internal${path}`;
      const req = new Request(url, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookieHeader,
          Origin: new URL(url).origin
        },
        body: bodyJson
      });
      resp = await env.FLEET_INQUIRY_WORKER.fetch(req);
    } else {
      const url = await workerUrl(path);
      resp = await fetch(url, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookieHeader,
          Origin: new URL(url).origin
        },
        body: bodyJson,
        cache: "no-store"
      });
    }
  } catch {
    const url = await workerUrl(path);
    resp = await fetch(url, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookieHeader,
        Origin: new URL(url).origin
      },
      body: bodyJson,
      cache: "no-store"
    });
  }

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(
      `Fleet worker PATCH failed: ${resp.status}${txt ? ` — ${txt}` : ""}`
    );
  }
}
