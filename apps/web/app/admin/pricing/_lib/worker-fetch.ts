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
 * Brief 56 — per-location signups viewer types + helper
 * ============================================================
 *
 * Signups read-only viewer reuses the same SIGNUP_WORKER service binding
 * + URL fallback transport (workerGetJson above) — adding the domain
 * wrapper here keeps the signup-worker-side adapter colocated. The
 * signups pages live under apps/web/app/admin/signups/ and import this
 * helper.
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
  since: string;
  days: number;
  limit_hit: boolean;
}

/**
 * Fetch recent signups for a location.
 *
 *   Returns `null` on 401/403 (no access — caller renders sign-in card).
 *   Throws on other errors (malformed response, 5xx, etc).
 */
export async function getSignupsForLocation(
  locationCode: string,
  days: SignupDays
): Promise<SignupsResponse | null> {
  const path =
    `/admin/api/locations/${encodeURIComponent(locationCode)}/signups` +
    `?days=${days}`;
  return workerGetJson<SignupsResponse>(path);
}
