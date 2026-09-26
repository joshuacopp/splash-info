// Centralized auth-cookie gate + legacy-URL redirect layer for apps/web.
//
// Order of operations on a matched request:
//   1. Static legacy redirects (308) — /admin/login, /admin/change-password,
//      /admin/logout — map to apps/web's canonical /login, /change-password,
//      /logout. Preserves bookmarks from the legacy /admin/* surface.
//   2. Dynamic legacy redirect (307, deliberately not 308 — see below) —
//      /admin/{slug} where {slug} is a
//      single segment that is NOT a known admin sub-path → /admin/pricing/{slug}.
//      This is the per-location pricing bookmark fall-through (legacy URL was
//      /admin/binghamton; canonical is /admin/pricing/binghamton).
//   3. Auth gate — runs after redirects.
//      /admin/*, /sysadmin/*, /workorders/*, /schedule/*, /forms (incl. /forms/*)
//                                            — require sb-access-token cookie
//      /change-password?required=true        — same
//      /login                                — bounce authenticated users to /admin/dashboard
//
// Note on /forms/*: the apps/web matcher includes the prefix for
// simplicity (Brief 99 Phase 5 option B), but only `/forms` itself is
// actually served by apps/web. /forms/{slug} is owned by the splash-forms
// worker via path-carved CF route — those requests never reach apps/web's
// edge, so the prefix matcher is effectively a no-op for /forms/{slug}
// while keeping a single rule to maintain on the apps/web side.
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
 * Cold-load session resume. sb-access-token has a 1-hour Max-Age while
 * sb-refresh-token has 7 days, and SessionKeepalive only refreshes while a
 * page is mounted — so with every tab closed, the access cookie ages out and
 * the gate below used to bounce the user to /login even though a valid refresh
 * token was still sitting in the jar. That re-prompted for password AND MFA,
 * which is what made the "7-day session" only ever real for people who left a
 * tab open.
 *
 * When the access cookie is gone but the refresh cookie is present, redirect
 * to dashboard-worker's /api/session-resume instead. It trades the refresh
 * token for a fresh pair and sends the browser on to `next`. GoTrue preserves
 * AAL, so an MFA'd session resumes still MFA'd — no assurance is lost here.
 *
 * Why a browser redirect rather than a fetch from inside middleware: apps/web
 * and dashboard-worker share a zone, and same-zone Worker→Worker URL fetches
 * loop through the edge and 522 after ~19s (Brief 17). Service bindings aren't
 * reachable from Edge middleware either. Bouncing the browser costs one extra
 * round-trip on a cold load and sidesteps both problems.
 *
 * `sb-resume-tried` is the worker's 10-second loop-breaker: if it's present we
 * already tried and something didn't stick, so fall through to /login rather
 * than ping-pong. See handleSessionResume in apps/dashboard-worker/src/index.ts.
 */
const REFRESH_TOKEN_COOKIE = "sb-refresh-token";
const RESUME_TRIED_COOKIE = "sb-resume-tried";
const SESSION_RESUME_PATH = "/api/session-resume";

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
  "approvals",
  "dashboard",
  "damage",
  "email-queue",
  "expenses",
  "fleet",
  "forms",
  "greeters",
  "jotform",
  "macneil-videos",
  "maintenance",
  "my-requests",
  "parts",
  "performance",
  "pricing",
  "promotions",
  "scorm-builder",
  "signups",
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
        // 307, NOT 308. This redirect is conditional on a list that changes:
        // the day a new /admin route is added to ADMIN_KNOWN_SUBPATHS, this
        // rule stops applying to that slug. 308 is permanent and browsers
        // cache it indefinitely, so anyone who hit the path BEFORE it was
        // registered keeps being sent to /admin/pricing/{slug} from cache,
        // never asking the server again — the new page is unreachable for
        // them and no redeploy can fix it. Exactly what happened with
        // /admin/macneil-videos.
        //
        // The static table above stays 308: those targets are genuinely
        // permanent and their membership does not change.
        //
        // Method-preserving either way; the only difference is cacheability.
        return NextResponse.redirect(url, 307);
      }
    }
  }

  const hasCookie = request.cookies.get(ACCESS_TOKEN_COOKIE)?.value;

  // ── 3. Auth gate ────────────────────────────────────────────────────────

  // /login: send the user past it only if their session is actually FINISHED.
  //
  // This used to bounce on cookie presence alone, and that single line cost
  // hours. A user who types their password and abandons the authenticator
  // prompt holds a valid aal1 cookie, so /login bounced them to a dashboard
  // whose every gated page then refused them -- and the one screen that could
  // have rescued them, /login itself, was the one screen they could not reach.
  // Three fixes shipped to that page before anyone noticed it was unreachable.
  //
  // aal2 means both factors are proven, so that session is complete and the
  // convenience bounce is right. Anything else -- aal1, or a token with no aal
  // claim at all -- is either half way through a login or unreadable, and both
  // are better served by being shown the login page than by being sent
  // somewhere that will refuse them without saying why. /login decides what to
  // render: it asks dashboard-worker whether a code step is owed and shows the
  // code field instead of the password form when it is.
  //
  // Read locally off the JWT: a base64 decode, no network. Middleware runs on
  // the Edge where service bindings are unreachable and a same-zone URL fetch
  // 522s (Brief 17), so a claim read is the only affordable check here. It is
  // not a security decision -- every worker still validates the token properly.
  // It only decides which of two screens to show.
  if (pathname === "/login") {
    if (hasCookie && tokenAal(hasCookie) === "aal2") {
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
      return resumeOrLogin(request);
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

  // /admin/*, /sysadmin/*, /workorders/*, /action-items/*, /schedule/*,
  // /forms (and /forms/*) — always gated.
  if (!hasCookie) {
    return resumeOrLogin(request);
  }
  return NextResponse.next();
}

/**
 * The gate's "no access cookie" branch. Prefers resuming a still-valid
 * refresh-token session over forcing a full re-login (+ MFA). Falls back to
 * /login when there's no refresh cookie to trade, or when the breadcrumb says
 * we already tried this a moment ago.
 *
 * Deliberately NOT used on /login: someone who navigates there explicitly may
 * be trying to switch accounts, and silently bouncing them into the previous
 * session would take that away.
 */
function resumeOrLogin(request: NextRequest): NextResponse {
  const hasRefresh = request.cookies.get(REFRESH_TOKEN_COOKIE)?.value;
  const alreadyTried = request.cookies.get(RESUME_TRIED_COOKIE)?.value;
  if (!hasRefresh || alreadyTried) {
    return redirectToLogin(request);
  }

  const resumeUrl = request.nextUrl.clone();
  resumeUrl.pathname = SESSION_RESUME_PATH;
  // dashboard-worker re-validates this through sanitizeRedirect's allow-list,
  // so a tampered value can't turn this into an open redirect.
  resumeUrl.search = `?next=${encodeURIComponent(originalPath(request))}`;
  return NextResponse.redirect(resumeUrl, 307);
}

/** Path + query the user was actually trying to reach. */
function originalPath(request: NextRequest): string {
  return request.nextUrl.pathname + (request.nextUrl.search ? request.nextUrl.search : "");
}

function redirectToLogin(request: NextRequest): NextResponse {
  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = "/login";
  // Preserve full original path + query so the user lands back where they
  // started after authenticating. Note: dashboard-worker's sanitizeRedirect
  // re-validates the `redirect` form field, so even a tampered ?return
  // value can't redirect off-allowlist post-login.
  loginUrl.search = `?return=${encodeURIComponent(originalPath(request))}`;
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
    "/workorders/:path*",
    "/action-items/:path*",
    "/schedule/:path*",
    "/forms/:path*",
    "/change-password",
    "/login",
    "/logout"
  ]
};

/**
 * Read the `aal` claim off a Supabase access token WITHOUT verifying it.
 *
 * Safe for what it is used for: choosing between the login form and a redirect.
 * No access is granted on the strength of this -- every worker re-validates the
 * token against GoTrue. Returns null for a malformed or claimless token, which
 * callers must treat as "not complete" rather than as "fine".
 */
function tokenAal(token: string): string | null {
  const parts = token.split(".");
  if (parts.length < 2 || !parts[1]) return null;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const payload = JSON.parse(atob(padded)) as { aal?: unknown };
    return typeof payload.aal === "string" ? payload.aal : null;
  } catch {
    return null;
  }
}
