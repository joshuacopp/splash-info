// Server-side helper for fetching the caller's session via dashboard-worker
// /api/me. Used by the root layout to populate the global Header (email +
// role) and by per-page server components that need to gate by the caller's
// dc_role (e.g., /admin/damage/[id] transition buttons).
//
// DUAL-MODE TRANSPORT (Brief 17):
//
//   PRODUCTION / STAGING (Cloudflare Workers runtime):
//     getCloudflareContext() returns env.DASHBOARD_WORKER (a service binding
//     declared in apps/web/wrangler.toml). We call env.DASHBOARD_WORKER.fetch
//     directly — Cloudflare routes the request internally without going back
//     through the edge. This avoids CF's same-zone Worker-to-Worker subrequest
//     gotcha (URL-based fetches from one Worker to another on the same zone
//     loop through the edge inefficiently and 522 after ~19s).
//
//   DEV (next dev outside the Workers runtime):
//     getCloudflareContext() throws or env.DASHBOARD_WORKER is undefined. We
//     fall through to the URL-based fetch path. The URL is built from the
//     NEXT_PUBLIC_DASHBOARD_WORKER_URL env var when set (cross-origin dev) or
//     the request host when unset (same-origin via next.config.mjs rewrites).
//     The well-documented dev cross-origin cookie limitation persists in this
//     mode (cookies set by dashboard-worker's origin won't reach apps/web's
//     origin under SameSite=Lax) — getMe() reliably returns null and the
//     Header gracefully falls back to "no user info."
//
// CACHING:
//   getMe() is wrapped in React's `cache()` so multiple consumers in the same
//   server render reuse a single fetch. Future briefs can call getMe() freely
//   without amplifying the network round-trip — the cache key is the function
//   identity itself (no args), so the entire request reuses one Session.
//
// HOST PLACEHOLDER:
//   Service bindings ignore the URL host — only the path matters. We use
//   `https://internal` as the placeholder host across all helpers so logs and
//   debugging output are predictable.

import { cache } from "react";
import { cookies, headers } from "next/headers";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { Session } from "@splash/types/session";
import type { UserRole } from "@splash/types/auth";

async function fetchMeViaUrl(cookieHeader: string): Promise<Response> {
  const base = process.env.NEXT_PUBLIC_DASHBOARD_WORKER_URL;
  let url: string;
  if (base) {
    url = `${base}/api/me`;
  } else {
    const headerStore = await headers();
    const host = headerStore.get("host") ?? "localhost:3000";
    const proto = headerStore.get("x-forwarded-proto") ?? "https";
    url = `${proto}://${host}/api/me`;
  }
  return fetch(url, {
    method: "GET",
    headers: { Cookie: cookieHeader },
    cache: "no-store"
  });
}

/**
 * Fetch the caller's session from dashboard-worker /api/me.
 *
 *   - Returns the parsed Session on 200.
 *   - Returns null on 401 (unauthenticated — caller renders public chrome).
 *   - Throws on other non-2xx and network errors. Callers that don't want
 *     errors propagating use `.catch(() => null)` (e.g., the root layout).
 *
 * Wrapped in React `cache()` so root layout + page components in the same
 * server render share a single fetch.
 */
export const getMe = cache(async (): Promise<Session | null> => {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore.toString();

  let resp: Response;
  try {
    const { env } = await getCloudflareContext({ async: true });
    if (env.DASHBOARD_WORKER) {
      const req = new Request("https://internal/api/me", {
        method: "GET",
        headers: { Cookie: cookieHeader }
      });
      resp = await env.DASHBOARD_WORKER.fetch(req);
    } else {
      resp = await fetchMeViaUrl(cookieHeader);
    }
  } catch {
    resp = await fetchMeViaUrl(cookieHeader);
  }

  if (resp.status === 401) return null;
  if (!resp.ok) {
    throw new Error(`Worker GET /api/me failed: ${resp.status}`);
  }
  return (await resp.json()) as Session;
});

/**
 * Map a UserRole to a human-readable label for header display. Default
 * branch handles forward-compat: any new role added to UserRole later
 * (regional_manager, etc.) renders as "Admin" until a label lands here.
 */
export function roleLabelFor(role: UserRole): string {
  switch (role) {
    case "super_admin":
      return "Super Admin";
    case "location_admin":
      return "Location Admin";
    default:
      return "Admin";
  }
}
