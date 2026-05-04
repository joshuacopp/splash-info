// Server-side helper for fetching the caller's session via dashboard-worker
// /api/me. Used by the root layout to populate the global Header (email +
// role) and by per-page server components that need to gate by the caller's
// dc_role (e.g., /admin/damage/[id] transition buttons).
//
// CROSS-ORIGIN MODES (mirrors apps/web/app/admin/damage/_lib/worker-fetch.ts):
//
//   1. NEXT_PUBLIC_DASHBOARD_WORKER_URL is set (dev / staging cross-origin):
//      apps/web on localhost / its own workers.dev URL, dashboard-worker on
//      a different origin. Use the env var as the absolute base. Note the
//      well-documented dev limitation: the cookie set by the dashboard-worker
//      origin won't reach apps/web's origin under SameSite=Lax, so /api/me
//      reliably returns 401 in dev cross-origin. The Header gracefully falls
//      back to "no user info" in that branch.
//
//   2. NEXT_PUBLIC_DASHBOARD_WORKER_URL is empty (production same-origin):
//      apps/web AND dashboard-worker:/api/* both bound to splashcarwashes.info.
//      Build the URL from the incoming request's host so prod works without
//      env-var configuration. Cloudflare's edge routes /api/me to the
//      dashboard-worker per its wrangler.toml route binding.
//
// CACHING:
//   getMe() is wrapped in React's `cache()` so multiple consumers in the same
//   server render reuse a single fetch. Future briefs can call getMe() freely
//   without amplifying the network round-trip — the cache key is the function
//   identity itself (no args), so the entire request reuses one Session.

import { cache } from "react";
import { cookies, headers } from "next/headers";
import type { Session } from "@splash/types/session";
import type { UserRole } from "@splash/types/auth";

async function meUrl(): Promise<string> {
  const base = process.env.NEXT_PUBLIC_DASHBOARD_WORKER_URL;
  if (base) {
    return `${base}/api/me`;
  }
  const headerStore = await headers();
  const host = headerStore.get("host") ?? "localhost:3000";
  const proto = headerStore.get("x-forwarded-proto") ?? "https";
  return `${proto}://${host}/api/me`;
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
  const url = await meUrl();

  const resp = await fetch(url, {
    method: "GET",
    headers: {
      Cookie: cookieStore.toString()
      // No Origin header needed: /api/me is read-only and the worker no
      // longer runs isOriginAllowed on it (11b). Browsers omit Origin on
      // same-origin GETs by spec; matching that posture from the server
      // fetch keeps prod and dev consistent.
    },
    cache: "no-store"
  });

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
