// /logout — server-side logout endpoint.
//
// Two callers:
//   1. The 308 redirect target for legacy /admin/logout (handled in middleware).
//      A user clicking a bookmark like splashcarwashes.info/admin/logout lands
//      here via that redirect.
//   2. Direct navigation to /logout (e.g., shared link, manual URL entry).
//
// The "Sign Out" button in the global Header takes a different path: it POSTs
// directly to dashboard-worker:/api/logout (per Brief 2 spec). That keeps the
// state-changing call going to the worker that owns the auth contract.
//
// What this route does:
//   1. Clears apps/web's view of the auth cookies via Set-Cookie headers
//      with Max-Age=0 (matches @splash/auth's buildLogoutCookies attributes).
//   2. 302 redirects to /login.
//
// In production same-origin (apps/web + dashboard-worker both on
// splashcarwashes.info), the cookie clear is fully effective — the cookies
// live on that origin and any response from the origin can clear them.
//
// In dev cross-origin (apps/web on workers.dev, dashboard-worker on a
// different workers.dev), this route can only clear apps/web-origin cookies,
// not the cookies set by the dashboard-worker. That's a known dev-only
// limitation flagged in BUILD_STATE.md; the Sign Out button (which talks
// directly to the worker) is the dev path that actually works.

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const ACCESS_TOKEN_COOKIE = "sb-access-token";
const REFRESH_TOKEN_COOKIE = "sb-refresh-token";

/**
 * Cookie-clear header. Attributes match @splash/auth/buildLogoutCookies
 * verbatim so the apps/web-issued clear matches what the dashboard-worker
 * would issue. (The browser identifies cookies by name + domain + path; the
 * other attributes don't affect clearing semantics, but matching them keeps
 * intent legible and avoids any future browser quirk surprises.)
 */
function clearCookieHeader(name: string): string {
  return `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function logoutResponse(request: NextRequest): NextResponse {
  const url = request.nextUrl.clone();
  url.pathname = "/login";
  // Brief 147 — preserve ?return= through the logout round-trip so callers
  // that send the user through /logout to clear a stale cookie (e.g. the
  // "Sign in again" CTA on /admin/damage) can route back to where they
  // started. /login validates the return path against the same allowlist
  // as the dashboard-worker, so a tampered value lands at the default.
  const returnParam = request.nextUrl.searchParams.get("return");
  if (returnParam && returnParam.startsWith("/") && !returnParam.startsWith("//")) {
    url.search = `?return=${encodeURIComponent(returnParam)}`;
  } else {
    url.search = "";
  }
  const response = NextResponse.redirect(url, 302);
  response.headers.append("Set-Cookie", clearCookieHeader(ACCESS_TOKEN_COOKIE));
  response.headers.append("Set-Cookie", clearCookieHeader(REFRESH_TOKEN_COOKIE));
  return response;
}

// Both methods do the same thing — legacy /admin/logout was a GET, but a
// 308 redirect preserves method, so a POST submitter would also land here.
// Treat them identically: clear cookies, send to /login.
export function GET(request: NextRequest) {
  return logoutResponse(request);
}
export function POST(request: NextRequest) {
  return logoutResponse(request);
}
