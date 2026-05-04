// Splash Dashboard Worker — SSO + forced-reset endpoints.
//
// Owned routes (workers.dev only during Step 6; production routes wire up
// in Step 7 — see wrangler.toml):
//   POST /api/login         — Supabase password grant; sets auth cookies;
//                             302s to /change-password if must_change_password,
//                             else to the sanitized redirect target.
//   POST /api/logout        — clears auth cookies; 302 to "/".
//   POST /api/forced-reset  — authenticated user fulfilling the
//                             must_change_password gate; sets new password
//                             and clears the flag.
//   GET  /api/me            — returns the caller's Session as JSON. Used by
//                             apps/web's root layout to populate the Header
//                             with email + role. Cache-Control: no-store so
//                             that out-of-band session changes (sysadmin
//                             grants a tool, etc.) are picked up on reload.
//
// AUTH GATE POSITION:
//   /api/login         — no gate (this IS the auth flow).
//   /api/logout        — no gate (cookie clear is unauthenticated-safe).
//   /api/forced-reset  — authenticate() FIRST, before any handler logic.
//   /api/me            — authenticate() only; 401 when unauthenticated so
//                        apps/web can gracefully render public chrome.
//                        NO isOriginAllowed gate: read-only GET, CSRF
//                        doesn't apply, and browsers omit `Origin` on
//                        same-origin GETs by spec — gating would 403 the
//                        common case (apps/web's server-render fetch +
//                        the browser console smoke-test path).
//
// SECURITY: this worker fixes the must_change_password bypass that exists
// in the legacy dashboard.js (which never read the flag). See
// @splash/auth/index.ts for the full security contract.
//
// SAME-ORIGIN ASSUMPTION (CSRF):
//   The /change-password page lives in apps/web. Once Step 7 wires routes,
//   apps/web and this worker share the splashcarwashes.info origin and the
//   sb-access-token cookie (Path=/, SameSite=Lax) flows automatically.
//   SameSite=Lax blocks cross-site cookie attachment for state-changing
//   POSTs from third-party origins, so no CSRF token is required for the
//   apps/web → worker call.
//   During Step 6 dev (apps/web on its workers.dev URL, this worker on its
//   own workers.dev URL — different origins), the cookie does NOT cross.
//   End-to-end testing of the bug-fix flow therefore requires same-origin
//   setup; until then, test the worker handlers in isolation via curl.
//
// SUPPORTED CONTENT TYPES on POSTs:
//   application/x-www-form-urlencoded, multipart/form-data, application/json.
//   Handler reads via readForm() — same shape as legacy/dashboard.js:161.

import {
  ACCESS_TOKEN_COOKIE,
  authenticate,
  buildAuthCookies,
  buildLogoutCookies,
  buildSessionForUser,
  requiresPasswordChange,
  supabasePasswordLogin,
  userCompleteForcedReset
} from "@splash/auth";
import type { SupabaseEnv } from "@splash/db-supabase";
import { isOriginAllowed, jsonError, readForm } from "@splash/http";

type Env = SupabaseEnv;

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    if (pathname === "/api/login" && method === "POST") {
      // Login is the lowest-CSRF-risk POST (attacker would need to know
      // valid creds to forge a request). Gating it anyway for consistency
      // with the other state-changing endpoints — Chunk 5 retrofit.
      if (!isOriginAllowed(request)) return jsonError(403, "bad origin");
      return handleLogin(request, env);
    }
    if (pathname === "/api/logout" && method === "POST") {
      if (!isOriginAllowed(request)) return jsonError(403, "bad origin");
      return handleLogout();
    }
    if (pathname === "/api/forced-reset" && method === "POST") {
      // High-risk path: an authenticated user could be tricked into
      // resetting their password to an attacker-supplied value. SameSite=Lax
      // is the primary defense; isOriginAllowed is the second layer.
      if (!isOriginAllowed(request)) return jsonError(403, "bad origin");
      return handleForcedReset(request, env);
    }
    if (pathname === "/api/me" && method === "GET") {
      // Read-only — no isOriginAllowed gate. Browsers don't send Origin on
      // same-origin GETs (spec), so gating broke the common case in 11a.
      // CSRF doesn't apply to a read with no side effects; cross-origin
      // readers without the cookie just get the 401 from authenticate().
      return handleMe(request, env);
    }

    return new Response("Not found", { status: 404 });
  }
} satisfies ExportedHandler<Env>;

/* ============================================================
 * Handlers
 * ============================================================ */

async function handleLogin(request: Request, env: Env): Promise<Response> {
  const form = await readForm(request);
  const email = (form.get("email") ?? "").trim();
  const password = (form.get("password") ?? "").trim();
  const redirect = (form.get("redirect") ?? "").trim();

  if (!email || !password) {
    return jsonError(400, "email and password required");
  }

  let loginResult;
  try {
    loginResult = await supabasePasswordLogin(env, email, password);
  } catch {
    // Match legacy/dashboard.js:78 — generic 401 regardless of why.
    return jsonError(401, "Invalid email or password");
  }

  // Build the session straight from the AuthUser supabasePasswordLogin
  // returns. No need to round-trip through /auth/v1/user — we already have
  // the same object. This is THE must_change_password check.
  const session = await buildSessionForUser(env, loginResult.user);

  // User authenticated but has no row in auth_unified — no permissions
  // assigned. Reject login rather than set cookies for an empty session.
  if (!session) {
    return jsonError(403, "no_permissions_assigned");
  }

  const headers = new Headers();
  for (const c of buildAuthCookies(loginResult.access_token, loginResult.refresh_token)) {
    headers.append("Set-Cookie", c);
  }

  const safeNext = sanitizeRedirect(redirect);

  if (requiresPasswordChange(session)) {
    // SECURITY: cookies ARE set here even though the gate is open. The
    // /api/forced-reset endpoint authenticates against the same cookie,
    // and every protected page calls authenticate() and re-checks
    // session.mustChangePassword — so a bookmark-jump past the
    // change-password page hits another gate immediately. The contract
    // is enforced at every gate, not only at login.
    headers.set("Location", `/change-password?required=true&next=${encodeURIComponent(safeNext)}`);
    return new Response("", { status: 302, headers });
  }

  headers.set("Location", safeNext);
  return new Response("", { status: 302, headers });
}

function handleLogout(): Response {
  const headers = new Headers();
  for (const c of buildLogoutCookies()) headers.append("Set-Cookie", c);
  headers.set("Location", "/");
  return new Response("", { status: 302, headers });
}

async function handleForcedReset(request: Request, env: Env): Promise<Response> {
  // Auth gate FIRST.
  const auth = await authenticate(request, env);
  if (auth.status !== "authenticated") {
    return jsonError(401, "unauthorized");
  }
  const { session } = auth;

  const form = await readForm(request);
  const newPassword = (form.get("new_password") ?? "").trim();
  const confirmPassword = (form.get("confirm_password") ?? "").trim();
  const next = (form.get("next") ?? "").trim();

  if (!newPassword || newPassword.length < 8) {
    return jsonError(400, "Password must be at least 8 characters");
  }
  if (newPassword !== confirmPassword) {
    return jsonError(400, "Passwords do not match");
  }

  try {
    // userCompleteForcedReset uses password-first ordering — see the
    // safety analysis in @splash/auth/admin.ts.
    await userCompleteForcedReset(env, session, newPassword);
  } catch (err) {
    return jsonError(500, err instanceof Error ? err.message : "Password update failed");
  }

  // Successful reset — redirect to the original target.
  const safeNext = sanitizeRedirect(next);
  const target = new URL(safeNext, request.url).toString();
  return Response.redirect(target, 302);
}

async function handleMe(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (auth.status !== "authenticated") {
    return jsonError(401, "unauthorized");
  }
  // Return the full Session — that's already the public-facing shape per
  // packages/types/src/session.ts. Trimming fields would create drift
  // between this endpoint and other consumers of authenticate().
  return new Response(JSON.stringify(auth.session), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    }
  });
}

/* ============================================================
 * Worker-local helpers
 * ============================================================ */

/**
 * Allowlist for redirect targets. Source: legacy/dashboard.js:135.
 * Only same-origin paths to known tools are accepted; everything else
 * defaults to "/" (which apps/web will route to the dashboard tile grid
 * post-cutover).
 */
function sanitizeRedirect(target: string): string {
  if (!target) return "/";
  if (!target.startsWith("/")) return "/";
  if (target.startsWith("//")) return "/"; // protocol-relative — reject
  const allowed = ["/admin", "/manage", "/pertrack"];
  for (const prefix of allowed) {
    if (target === prefix || target.startsWith(prefix + "/") || target.startsWith(prefix + "?")) {
      return target;
    }
  }
  return "/";
}

// Suppress unused-import warning when ACCESS_TOKEN_COOKIE happens to not
// be referenced directly (it is used via authenticate() under the hood,
// but we still re-export the name from @splash/auth for clarity at the
// call site if a future handler needs to construct a synthetic Request).
void ACCESS_TOKEN_COOKIE;
