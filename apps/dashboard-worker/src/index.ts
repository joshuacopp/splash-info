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
  challengeAndVerify,
  enrollTotpFactor,
  getAccessToken,
  getCookie,
  PASSWORD_POLICY,
  PASSWORD_POLICY_MESSAGE,
  REFRESH_TOKEN_COOKIE,
  refreshSession,
  requiresPasswordChange,
  supabasePasswordLogin,
  userCompleteForcedReset
} from "@splash/auth";
import type { SupabaseEnv } from "@splash/db-supabase";
import { isOriginAllowed, json, jsonError, readForm } from "@splash/http";
import { verifyTurnstile } from "./turnstile";
import { recordAndCheck, clearEmail, type RateLimitEnv } from "./rate-limit";

// Base Supabase env + the login-hardening bindings (Brief: login abuse
// protection). Both are optional so local dev works unbound (Turnstile
// fail-soft, rate-limit fail-open); production binds them via wrangler.toml.
type Env = SupabaseEnv &
  RateLimitEnv & {
    TURNSTILE_SECRET_KEY?: string;
  };

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
    // ── MFA enrollment (additive; does NOT touch the login path) ────────────
    // Both are state-changing POSTs behind authenticate() + isOriginAllowed,
    // same contract as /api/forced-reset. They let an already-authenticated
    // (AAL1) user enroll their own TOTP factor and confirm it. No enforcement
    // is wired anywhere yet, so shipping these cannot affect any existing
    // login or gated page — an un-enrolled user's flow is byte-for-byte
    // unchanged.
    if (pathname === "/api/mfa/enroll" && method === "POST") {
      if (!isOriginAllowed(request)) return jsonError(403, "bad origin");
      return handleMfaEnroll(request, env);
    }
    if (pathname === "/api/mfa/enroll/verify" && method === "POST") {
      if (!isOriginAllowed(request)) return jsonError(403, "bad origin");
      return handleMfaEnrollVerify(request, env);
    }

    // ── Sliding-session refresh (Phase 1 keepalive) ─────────────────────────
    // Trades the sb-refresh-token cookie for a fresh access+refresh pair and
    // re-sets both cookies. The apps/web client pings this on a timer + on
    // tab-refocus so an open session never hits the 1-hour access-token wall.
    // GoTrue preserves AAL on refresh, so an MFA'd session stays MFA'd — this
    // does NOT elevate an aal1 session. Additive: nothing else changes.
    if (pathname === "/api/refresh" && method === "POST") {
      if (!isOriginAllowed(request)) return jsonError(403, "bad origin");
      return handleRefresh(request, env);
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
  const turnstileToken = (form.get("cf-turnstile-response") ?? "").trim() || null;

  if (!email || !password) {
    return jsonError(400, "email and password required");
  }

  const clientIp = request.headers.get("CF-Connecting-IP");

  // ── Rate limit (defense-in-depth behind Turnstile) ──────────────────────
  // Recorded BEFORE the password grant so failed guesses count. Fail-open
  // if KV is unbound/erroring — Turnstile is still in front.
  const rl = await recordAndCheck(env, clientIp, email);
  if (!rl.allowed) {
    const res = jsonError(429, "Too many attempts. Please wait and try again.");
    res.headers.set("Retry-After", String(rl.retryAfterSec));
    return res;
  }

  // ── Turnstile ───────────────────────────────────────────────────────────
  // Fail-soft when the secret is unbound (dev); fail-closed on a bad/missing
  // token once the secret IS bound (prod), so the widget can't be stripped.
  const ts = await verifyTurnstile(env.TURNSTILE_SECRET_KEY, turnstileToken, clientIp);
  if (!ts.ok) {
    // Log the real siteverify error-code (invalid-input-response =
    // sitekey/secret pair mismatch; invalid-input-secret = bad secret;
    // timeout-or-duplicate = stale/reused token). The user only sees a
    // generic message, but Workers Logs gets the actionable reason.
    console.warn(`[dashboard] Turnstile verify failed: ${ts.reason}`);
    return jsonError(403, "Anti-abuse check failed. Please try again.");
  }

  let loginResult;
  try {
    loginResult = await supabasePasswordLogin(env, email, password);
  } catch {
    // Match legacy/dashboard.js:78 — generic 401 regardless of why.
    return jsonError(401, "Invalid email or password");
  }

  // Successful password grant — clear the per-email throttle so a legit
  // user who mistyped a few times isn't penalized on their next visit.
  await clearEmail(env, email);

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

  if (!PASSWORD_POLICY.test(newPassword)) {
    return jsonError(400, PASSWORD_POLICY_MESSAGE);
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

  const safeNext = sanitizeRedirect(next);
  const target = new URL(safeNext, request.url).toString();

  // Brief 147 — re-issue session cookies. Supabase invalidates the
  // previously-issued access_token when the password changes, so the
  // sb-access-token cookie attached to this request is now stale. Without
  // re-issuing, the next request to a protected page (e.g. /admin/damage)
  // carries a stale token, authenticate() returns "unauthenticated", and
  // the page renders its no-access branch — the failure mode 3/3 beta
  // testers hit on iOS Safari. Logging the user back in with the new
  // password yields a fresh access_token + refresh_token; we emit them as
  // Set-Cookie headers with the same attributes as /api/login so the next
  // request authenticates cleanly.
  const headers = new Headers();
  try {
    const fresh = await supabasePasswordLogin(env, session.email, newPassword);
    for (const c of buildAuthCookies(fresh.access_token, fresh.refresh_token)) {
      headers.append("Set-Cookie", c);
    }
  } catch {
    // Password DID change in Supabase, but re-login failed. Safest
    // recovery: clear cookies and bounce to /login so the user
    // authenticates with the new password.
    for (const c of buildLogoutCookies()) {
      headers.append("Set-Cookie", c);
    }
    headers.set("Location", `/login?return=${encodeURIComponent(safeNext)}`);
    return new Response("", { status: 302, headers });
  }

  headers.set("Location", target);
  return new Response("", { status: 302, headers });
}

/**
 * POST /api/mfa/enroll — start TOTP enrollment for the calling user.
 *
 * Creates an UNVERIFIED factor and returns the QR + secret to display once.
 * Purely additive: an unverified factor protects nothing and is invisible to
 * hasVerifiedFactor(), so this changes nothing about the caller's login or any
 * gated page until they complete /api/mfa/enroll/verify.
 */
async function handleMfaEnroll(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (auth.status !== "authenticated") {
    return jsonError(401, "unauthorized");
  }
  const accessToken = getAccessToken(request);
  if (!accessToken) {
    return jsonError(401, "unauthorized");
  }

  const form = await readForm(request);
  const friendlyName = (form.get("friendly_name") ?? "").trim() || undefined;

  try {
    const result = await enrollTotpFactor(env, accessToken, friendlyName);
    return json({
      factorId: result.factorId,
      qrCode: result.qrCode,
      secret: result.secret,
      uri: result.uri
    });
  } catch (err) {
    return jsonError(500, err instanceof Error ? err.message : "MFA enrollment failed");
  }
}

/**
 * POST /api/mfa/enroll/verify — confirm the freshly-enrolled factor with a
 * 6-digit code. On success GoTrue activates the factor AND returns a new AAL2
 * token pair; we swap the caller's session cookies to that pair so the browser
 * is immediately at aal2. Still additive: no gate anywhere reads aal yet, so an
 * elevated cookie has no different effect than the prior aal1 one — it just
 * primes the session for when layer-2 enforcement lands.
 */
async function handleMfaEnrollVerify(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (auth.status !== "authenticated") {
    return jsonError(401, "unauthorized");
  }
  const accessToken = getAccessToken(request);
  if (!accessToken) {
    return jsonError(401, "unauthorized");
  }

  const form = await readForm(request);
  const factorId = (form.get("factor_id") ?? "").trim();
  const code = (form.get("code") ?? "").trim();

  if (!factorId || !code) {
    return jsonError(400, "factor_id and code required");
  }

  let elevated;
  try {
    elevated = await challengeAndVerify(env, accessToken, factorId, code);
  } catch {
    // Bad or expired code — generic message, caller re-prompts.
    return jsonError(400, "Invalid or expired code. Please try again.");
  }

  const headers = new Headers();
  for (const c of buildAuthCookies(elevated.accessToken, elevated.refreshToken)) {
    headers.append("Set-Cookie", c);
  }
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}

/**
 * POST /api/refresh — sliding-session keepalive.
 *
 * Reads the sb-refresh-token cookie, exchanges it for a fresh access+refresh
 * pair (grant_type=refresh_token), and re-sets BOTH cookies (the refresh token
 * rotates, so we must persist the new one). Returns 200 {ok:true} on success,
 * 401 when there's no refresh cookie or GoTrue rejects it (expired/revoked) —
 * the client treats 401 as "session's really over" and lets the next
 * navigation fall through to the normal login redirect.
 *
 * No authenticate() call here on purpose: the whole point is to run when the
 * access token may already be dead. The refresh token IS the credential.
 */
async function handleRefresh(request: Request, env: Env): Promise<Response> {
  const refreshToken = getCookie(request, REFRESH_TOKEN_COOKIE);
  if (!refreshToken) {
    return jsonError(401, "no_refresh_token");
  }

  let refreshed;
  try {
    refreshed = await refreshSession(env, refreshToken);
  } catch {
    // Expired/revoked/rotated-away — session is genuinely over.
    return jsonError(401, "refresh_rejected");
  }

  const headers = new Headers();
  for (const c of buildAuthCookies(refreshed.access_token, refreshed.refresh_token)) {
    headers.append("Set-Cookie", c);
  }
  headers.set("Content-Type", "application/json");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
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
