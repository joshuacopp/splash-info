// Centralized auth-cookie gate + legacy-URL redirect layer for apps/web.
//
// Order of operations on a matched request:
//   1. Static legacy redirects (308) — /admin/login, /admin/change-password,
//      /admin/logout — map to apps/web's canonical /login, /change-password,
//      /logout. Preserves bookmarks from the legacy /admin/* surface.
//   2. Dynamic legacy redirect (308) — /admin/{slug} where {slug} is a
//      single segment that is NOT a known admin sub-path → /admin/pricing/{slug}.
//      This is the per-location pricing bookmark fall-through (legacy URL was
//      /admin/binghamton; canonical is /admin/pricing/binghamton).
//   3. Auth gate — runs after redirects.
//      /admin/*, /sysadmin/*           — require sb-access-token cookie
//      /change-password?required=true  — same
//      /login                          — bounce authenticated users to /admin/dashboard
//
// Does NOT run on:
//   /, /signup/*, /q/*, /join/*, /claims/*  — public customer-facing
//   anything not in `matcher` below
//
// Validation is presence-only (cookie set vs not). The actual JWT validity
// check lives on the dashboard-worker (every page that calls a /admin/api/*
// endpoint will see a 401 if the cookie is stale, and the per-page render
// will show the unauthenticated state). Middleware is fast-path; deep
// validation is per-page.
//
// Cookie name matches @splash/auth's ACCESS_TOKEN_COOKIE export — kept in
// sync manually because middleware runs in the Edge runtime and importing
// from workspace packages adds bundling complexity without value here.
//
// Why all redirects live here (vs. next.config.mjs `redirects()`):
//   - The /admin/{slug} catch-all needs a programmatic exclusion list
//     (known sub-paths) which is cleaner in code than a path-to-regexp
//     negative lookahead.
//   - Localizing all URL policy in one file means future briefs only need
//     to look in one place when adjusting routes.

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const ACCESS_TOKEN_COOKIE = "sb-access-token";
const DEFAULT_AUTHED_LANDING = "/admin/dashboard";

/**
 * Static legacy → canonical mapping. Each entry is a 308 (permanent +
 * method-preserving) redirect from a legacy URL to its apps/web equivalent.
 */
const LEGACY_REDIRECTS: Readonly<Record<string, string>> = {
  "/admin/login": "/login",
  "/admin/change-password": "/change-password",
  "/admin/logout": "/logout"
};

/**
 * Single-segment slugs under /admin/ that are real apps/web tool routes
 * (not legacy location bookmarks). Anything NOT in this list is treated
 * as a legacy `/admin/{location_code}` bookmark and redirected to
 * `/admin/pricing/{location_code}`.
 *
 * Keep this list in sync with the page directories under apps/web/app/admin/
 * (plus the static legacy redirects above whose first segment also lives
 * under /admin/).
 */
const ADMIN_KNOWN_SUBPATHS = new Set<string>([
  "dashboard",
  "damage",
  "performance",
  "pricing",
  "sysadmin",
  "api",
  // legacy redirect targets — also live under /admin/, must not be re-redirected
  "login",
  "logout",
  "change-password"
]);

export function middleware(request: NextRequest) {
  const { pathname, searchParams } = request.nextUrl;

  // ── 1. Static legacy redirects ──────────────────────────────────────────
  const staticTarget = LEGACY_REDIRECTS[pathname];
  if (staticTarget) {
    const url = request.nextUrl.clone();
    url.pathname = staticTarget;
    // Preserve query string — e.g. /admin/change-password?required=true
    // becomes /change-password?required=true.
    return NextResponse.redirect(url, 308);
  }

  // ── 2. Dynamic legacy /admin/{location} → /admin/pricing/{location} ─────
  if (pathname.startsWith("/admin/")) {
    const rest = pathname.slice("/admin/".length);
    // Only single-segment paths qualify. Multi-segment paths like
    // /admin/pricing/binghamton or /admin/dashboard/foo fall through.
    if (rest.length > 0 && !rest.includes("/")) {
      if (!ADMIN_KNOWN_SUBPATHS.has(rest)) {
        const url = request.nextUrl.clone();
        url.pathname = `/admin/pricing/${rest}`;
        return NextResponse.redirect(url, 308);
      }
    }
  }

  const hasCookie = request.cookies.get(ACCESS_TOKEN_COOKIE)?.value;

  // ── 3. Auth gate ────────────────────────────────────────────────────────

  // /login: if the user already has a session cookie, send them past it.
  if (pathname === "/login") {
    if (hasCookie) {
      const url = request.nextUrl.clone();
      url.pathname = DEFAULT_AUTHED_LANDING;
      url.search = "";
      return NextResponse.redirect(url);
    }
    return NextResponse.next();
  }

  // /change-password: only gate the forced-reset path. Voluntary use
  // doesn't exist as a UX surface today; if it ships later, revisit.
  if (pathname === "/change-password") {
    if (searchParams.get("required") === "true" && !hasCookie) {
      return redirectToLogin(request);
    }
    return NextResponse.next();
  }

  // /logout: always pass through. The route handler clears cookies and
  // redirects to /login itself; gating on cookie presence would just
  // bounce already-logged-out users to /login (which is what /logout
  // does anyway, so harmless either way — leaving it ungated keeps the
  // behavior consistent for both authed and unauthed callers).
  if (pathname === "/logout") {
    return NextResponse.next();
  }

  // /admin/* and /sysadmin/* — always gated.
  if (!hasCookie) {
    return redirectToLogin(request);
  }
  return NextResponse.next();
}

function redirectToLogin(request: NextRequest): NextResponse {
  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = "/login";
  // Preserve full original path + query so the user lands back where they
  // started after authenticating. Note: dashboard-worker's sanitizeRedirect
  // re-validates the `redirect` form field, so even a tampered ?return
  // value can't redirect off-allowlist post-login.
  const fullPath =
    request.nextUrl.pathname +
    (request.nextUrl.search ? request.nextUrl.search : "");
  loginUrl.search = `?return=${encodeURIComponent(fullPath)}`;
  return NextResponse.redirect(loginUrl);
}

/**
 * Matcher tells Next which paths to invoke this middleware for. Anything
 * not listed here skips middleware entirely (faster, and avoids accidental
 * gating of public routes).
 *
 * NOTE: matcher patterns use path-to-regexp syntax. ":path*" matches zero
 * or more additional segments — so "/admin/:path*" matches both "/admin"
 * and "/admin/anything/nested".
 *
 * /logout is included so the matcher fires on it; the middleware itself
 * passes through (the route handler does the actual work).
 */
export const config = {
  matcher: [
    "/admin/:path*",
    "/sysadmin/:path*",
    "/change-password",
    "/login",
    "/logout"
  ]
};
