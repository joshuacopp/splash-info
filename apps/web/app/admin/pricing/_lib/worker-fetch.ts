// Server-side fetch helper for /admin/api/* — apps/web's pages call the
// signup-worker's JSON API for pricing data.
//
// DUAL-MODE TRANSPORT (Brief 17):
//
//   PRODUCTION / STAGING (Cloudflare Workers runtime):
//     env.SIGNUP_WORKER (service binding declared in apps/web/wrangler.toml)
//     is called directly — env.SIGNUP_WORKER.fetch(req). Cloudflare routes
//     the request internally without going back through the edge. This
//     avoids CF's same-zone Worker-to-Worker subrequest gotcha (URL-based
//     same-zone fetches loop through the edge and 522 after ~19s).
//
//   DEV (next dev outside the Workers runtime):
//     getCloudflareContext() throws or env.SIGNUP_WORKER is undefined. We
//     fall through to the URL-based fetch path. The URL is built from the
//     NEXT_PUBLIC_SIGNUP_WORKER_URL env var when set (cross-origin dev) or
//     the request host when unset (same-origin via next.config.mjs rewrites).
//     CF Workers fetch doesn't accept relative URLs server-side, which is
//     why we always build an absolute URL in this branch.
//
// HOST PLACEHOLDER:
//   Service bindings ignore the URL host; only the path matters. Use
//   `https://internal` consistently across helpers so logs are predictable.

import { cookies, headers } from "next/headers";
import { getCloudflareContext } from "@opennextjs/cloudflare";

/**
 * Build an absolute URL for a /admin/api/* call. Server-only — uses
 * next/headers which is unavailable in client components. Used by the
 * URL-based dev fallback.
 */
async function workerUrl(path: string): Promise<string> {
  const trimmed = path.startsWith("/") ? path : `/${path}`;
  const base = process.env.NEXT_PUBLIC_SIGNUP_WORKER_URL;
  if (base) {
    return `${base}${trimmed}`;
  }
  const headerStore = await headers();
  const host = headerStore.get("host") ?? "localhost:3000";
  const proto = headerStore.get("x-forwarded-proto") ?? "https";
  return `${proto}://${host}${trimmed}`;
}

/**
 * GET a JSON endpoint, forwarding the user's auth cookie.
 *
 *   - Returns parsed JSON on 2xx.
 *   - Returns null on 401/403 (caller decides — typically render a
 *     "no access" page).
 *   - Throws on other non-2xx (5xx, malformed JSON, etc.) — caller's
 *     error boundary handles.
 */
export async function workerGetJson<T>(path: string): Promise<T | null> {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore.toString();

  let resp: Response;
  try {
    const { env } = await getCloudflareContext({ async: true });
    if (env.SIGNUP_WORKER) {
      const trimmed = path.startsWith("/") ? path : `/${path}`;
      const req = new Request(`https://internal${trimmed}`, {
        method: "GET",
        headers: { Cookie: cookieHeader }
      });
      resp = await env.SIGNUP_WORKER.fetch(req);
    } else {
      const url = await workerUrl(path);
      resp = await fetch(url, {
        method: "GET",
        headers: { Cookie: cookieHeader },
        cache: "no-store"
      });
    }
  } catch {
    const url = await workerUrl(path);
    resp = await fetch(url, {
      method: "GET",
      headers: { Cookie: cookieHeader },
      cache: "no-store"
    });
  }

  if (resp.status === 401 || resp.status === 403) return null;
  if (!resp.ok) {
    throw new Error(`Worker GET ${path} failed: ${resp.status}`);
  }
  return (await resp.json()) as T;
}

/* ============================================================
 * Brief 56 / Brief 84 — per-location signups viewer types + helpers
 * ============================================================
 *
 * Signups read-only viewer reuses the same SIGNUP_WORKER service binding
 * + URL fallback transport (workerGetJson above) — adding the domain
 * wrapper here keeps the signup-worker-side adapter colocated. The
 * signups pages live under apps/web/app/admin/signups/ and import this
 * helper.
 *
 * Brief 84 added arbitrary-date-range filtering (`from`/`to`) and a CSV
 * export endpoint. Brief 56's `days=N` callers continue to work — the
 * worker accepts either parameter shape — but new code should pass
 * `{ from, to }` instead of `{ days }`.
 */

export type SignupDays = 1 | 7 | 30;

export interface SignupRow {
  submitted_at: string;
  phone_formatted: string;
  email: string | null;
  package_pretty: string;
  today_price: number;
  city: string | null;
  region: string | null;
}

export interface SignupsResponse {
  rows: SignupRow[];
  count: number;
  /** ISO timestamp lower bound (Brief 56 field; preserved for back-compat). */
  since: string;
  /** ISO timestamp lower bound (Brief 84). Equal to `since`. */
  from: string;
  /** ISO timestamp upper bound (Brief 84). */
  to: string;
  /** Non-null when the caller used `days=N`; null for from/to or default windows. */
  days: number | null;
  limit: number;
  limit_hit: boolean;
}

export interface SignupsParams {
  /** YYYY-MM-DD UTC. Pair with `to`. */
  from?: string;
  /** YYYY-MM-DD UTC. Pair with `from`. */
  to?: string;
  /** Brief 56 back-compat. Ignored when `from`/`to` are provided. */
  days?: SignupDays;
  /** 1..200; default 200. */
  limit?: number;
}

function buildSignupsQuery(params: SignupsParams): string {
  const sp = new URLSearchParams();
  if (params.from && params.to) {
    sp.set("from", params.from);
    sp.set("to", params.to);
  } else if (params.days != null) {
    sp.set("days", String(params.days));
  }
  if (params.limit != null) sp.set("limit", String(params.limit));
  const qs = sp.toString();
  return qs ? `?${qs}` : "";
}

/**
 * Fetch recent signups for a location. Accepts either Brief 56's `days`
 * shape or Brief 84's `{from, to}` shape (or neither — the worker
 * defaults to last-30-days).
 *
 *   Returns `null` on 401/403 (no access — caller renders sign-in card).
 *   Throws on other errors (malformed response, 5xx, etc).
 */
export async function getSignupsForLocation(
  locationCode: string,
  paramsOrDays: SignupsParams | SignupDays = {}
): Promise<SignupsResponse | null> {
  const params: SignupsParams =
    typeof paramsOrDays === "number" ? { days: paramsOrDays } : paramsOrDays;
  const path =
    `/admin/api/locations/${encodeURIComponent(locationCode)}/signups` +
    buildSignupsQuery(params);
  return workerGetJson<SignupsResponse>(path);
}

/**
 * Build the CSV download URL for the `<CsvExportButton>`. The URL is
 * consumed by the user's browser, not the apps/web Worker, so it must be
 * reachable over the public internet (no service-binding shortcut). When
 * `NEXT_PUBLIC_SIGNUP_WORKER_URL` is set, return an absolute URL; otherwise
 * fall back to a same-origin relative path so production (workers + apps/
 * web on the same zone post-cutover) just works without env config.
 */
export function getSignupsCsvUrl(
  locationCode: string,
  params: Pick<SignupsParams, "from" | "to"> = {}
): string {
  const path =
    `/admin/api/locations/${encodeURIComponent(locationCode)}/signups.csv` +
    buildSignupsQuery(params);
  const base = process.env.NEXT_PUBLIC_SIGNUP_WORKER_URL;
  if (base) return `${base}${path}`;
  return path;
}
