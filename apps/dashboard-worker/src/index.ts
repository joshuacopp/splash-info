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
  hasVerifiedFactor,
  listFactors,
  PASSWORD_POLICY,
  PASSWORD_POLICY_MESSAGE,
  REFRESH_TOKEN_COOKIE,
  refreshSession,
  requiresPasswordChange,
  resolveMfaEnrollment,
  supabasePasswordLogin,
  unenrollFactor,
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
    /** MFA step-up kill-switch (see wrangler.toml + @splash/auth authenticate). */
    MFA_ENFORCE?: string;
    /** MFA enrollment-countdown kill-switch (see wrangler.toml +
     *  @splash/auth resolveMfaEnrollment). */
    MFA_ENROLL_ENFORCE?: string;
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

    // Second step of an MFA-gated login. /api/login returns mfa_required for a
    // user with a verified factor; the client collects a 6-digit code and posts
    // it here, which exchanges the AAL1 session for an AAL2 one. State-changing
    // POST behind isOriginAllowed, same contract as /api/login.
    if (pathname === "/api/login/mfa" && method === "POST") {
      if (!isOriginAllowed(request)) return jsonError(403, "bad origin");
      return handleLoginMfa(request, env);
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

  const safeNext = sanitizeRedirect(redirect);

  const headers = new Headers();
  for (const c of buildAuthCookies(loginResult.access_token, loginResult.refresh_token)) {
    headers.append("Set-Cookie", c);
  }

  // ── MFA step-up gate (layer 2) ──────────────────────────────────────────
  // If the user has a VERIFIED factor, don't finish login here. We still set
  // the AAL1 cookies (byte-for-byte today's behavior — additive), but instead
  // of 302-ing we return a 200 mfa_required signal. The client collects a
  // 6-digit code and POSTs /api/login/mfa, which challenge+verifies it and
  // swaps the cookies for an AAL2 pair. must_change_password is DEFERRED to
  // that step so a change-forced + MFA-enrolled user completes the code first.
  //
  // Fail-open: if the factors lookup errors we fall through to the normal
  // (pre-MFA) 302 login. A GoTrue hiccup must never lock a user out — the
  // real enforcement (bounce an un-elevated session) lands in layer 3
  // (authenticate() AAL2 assertion), not here.
  let mfaRequired = false;
  try {
    mfaRequired = await hasVerifiedFactor(env, loginResult.access_token);
  } catch {
    mfaRequired = false;
  }
  if (mfaRequired) {
    headers.set("Content-Type", "application/json");
    headers.set("Cache-Control", "no-store");
    return new Response(JSON.stringify({ mfa_required: true, next: safeNext }), {
      status: 200,
      headers
    });
  }

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

  // ── MFA enrollment gate (layer 3 — the enrollment countdown) ─────────────
  // We're past the step-up return above, so this user has NO verified factor.
  // If the org enrollment policy is active (MFA_ENROLL_ENFORCE) and they are
  // past their deadline, route to forced enrollment instead of the dashboard.
  // Every account created on/after the flip day is overdue on first login, so
  // this is the "new users enroll right away" path; pre-existing users only
  // hit it once their 14-day grace elapses. Within grace, enrollment is
  // undefined-or-not-overdue and we fall through to a normal login — the
  // countdown banner (rendered from session.mfaEnrollment) does the nudging.
  // Same cookie contract as must_change_password: cookies are already set and
  // every protected page re-checks session.mfaEnrollment.overdue via
  // authenticate(), so jumping past this page just hits the gate again.
  const enrollment = resolveMfaEnrollment(env, loginResult.user, false);
  if (enrollment?.overdue) {
    headers.set("Location", `/mfa/enroll?required=true&next=${encodeURIComponent(safeNext)}`);
    return new Response("", { status: 302, headers });
  }

  headers.set("Location", safeNext);
  return new Response("", { status: 302, headers });
}

/**
 * POST /api/login/mfa — second step of an MFA-gated login.
 *
 * The caller already completed /api/login, which set the AAL1 cookies and
 * returned mfa_required. This handler authenticates against that AAL1 cookie,
 * finds the user's verified factor SERVER-SIDE (never trusting a client-supplied
 * factor id), and challenge+verifies the supplied 6-digit code. On success it
 * swaps the cookies for the AAL2 pair GoTrue returns and hands back the redirect
 * target — re-checking must_change_password here so a change-forced user still
 * lands on /change-password after clearing MFA. Mirrors handleMfaEnrollVerify.
 *
 * Fields (x-www-form-urlencoded): `code` (required), `next` (redirect target).
 */
async function handleLoginMfa(request: Request, env: Env): Promise<Response> {
  // enforceMfa: false — this IS the elevation step. It legitimately runs on an
  // aal1 session and turns it into aal2, so it must not be blocked by the aal2
  // gate (that would deadlock: you'd need aal2 to obtain aal2).
  const auth = await authenticate(request, env, { enforceMfa: false });
  if (auth.status !== "authenticated") {
    return jsonError(401, "unauthorized");
  }
  const accessToken = getAccessToken(request);
  if (!accessToken) {
    return jsonError(401, "unauthorized");
  }

  const form = await readForm(request);
  const code = (form.get("code") ?? "").trim();
  const next = (form.get("next") ?? "").trim();
  if (!code) {
    return jsonError(400, "code required");
  }

  // Resolve the factor to step up on from the SERVER's view of the user's
  // factors — a client-supplied id would let a caller point verification at an
  // arbitrary factor. Pick the first verified TOTP factor.
  let factorId: string | null = null;
  try {
    const factors = await listFactors(env, accessToken);
    factorId = factors.find((f) => f.status === "verified")?.id ?? null;
  } catch {
    return jsonError(500, "Could not load your authenticator. Please try again.");
  }
  if (!factorId) {
    // No verified factor — step 1 gated on hasVerifiedFactor, so this only
    // happens if the factor was removed mid-flow. Fail closed rather than loop.
    return jsonError(400, "no_verified_factor");
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
  headers.set("Cache-Control", "no-store");

  // Deferred must_change_password check, evaluated on the session we loaded
  // above. The client navigates to whatever we return.
  const safeNext = sanitizeRedirect(next);
  const redirect = requiresPasswordChange(auth.session)
    ? `/change-password?required=true&next=${encodeURIComponent(safeNext)}`
    : safeNext;
  return new Response(JSON.stringify({ ok: true, redirect }), { status: 200, headers });
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
 *
 * First prunes the caller's own leftover unverified factors — see the block
 * comment on that loop for why an abandoned enrollment otherwise wedges the
 * user out of MFA permanently.
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

  // Clear the caller's own UNVERIFIED factors before creating a new one.
  //
  // Why this is necessary: GoTrue refuses an enroll whose friendly_name matches
  // an existing factor's ("A factor with the friendly name \"\" for this user
  // already exists"). We send no friendly_name, so every factor is stored with
  // an empty one and the SECOND enroll always collides with the first. Anyone
  // who started enrollment and walked away — closed the tab, scanned the QR but
  // never typed the code, hit refresh — was locked out of enrollment forever,
  // with no way back except an admin reset. Unverified factors also count
  // toward GoTrue's cap of 10 per user, so they creep toward a second wall.
  //
  // Why deleting them is safe: an unverified factor protects nothing. It is
  // invisible to hasVerifiedFactor(), so no gate anywhere consults it, and it
  // cannot be the factor anyone authenticates with — verification is what
  // activates it, and this user never got there. The status filter is the whole
  // safety argument: DO NOT widen it to all factors. A verified factor is a
  // user's working second device, and someone enrolling a SECOND authenticator
  // hits this exact path — deleting verified factors here would silently strip
  // MFA off them mid-flow.
  //
  // Why it's best-effort: the prune is a repair, not a precondition. If listing
  // or deleting fails we swallow it and enroll anyway — the worst outcome is
  // the same collision error the user already gets today, which is no
  // regression, whereas letting it throw would turn a hiccup in cleanup into a
  // 500 on a working enrollment. Deliberately swallowed; please leave it.
  try {
    const existing = await listFactors(env, accessToken);
    for (const factor of existing) {
      if (factor.status !== "unverified") continue;
      try {
        await unenrollFactor(env, accessToken, factor.id);
      } catch {
        // One stubborn factor shouldn't abort the rest of the sweep.
      }
    }
  } catch {
    // Couldn't read the factor list — fall through and let the enroll try.
  }

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
 *
 * MUST STAY IN SYNC with two other lists, or deep links silently break:
 *   - apps/web/middleware.ts `config.matcher` — every prefix that bounces an
 *     unauthenticated user to /login?return=<path> has to be accepted here,
 *     otherwise the return path survives the whole login flow and then gets
 *     thrown away at the last step. That was the bug for /workorders,
 *     /schedule and /forms: middleware preserved the path, this function
 *     dropped it, and the user landed on the public homepage.
 *   - apps/web/app/login/page.tsx `sanitizeReturn` — same list, so the form
 *     shows the user the same target this function will honour.
 *
 * /inventory is NOT in apps/web's matcher — it's path-carved to the
 * splash-inventory worker and never reaches Next middleware — but the SPA
 * bounces to /login?return=<path> itself (see its AuthContext), so it needs
 * a seat here all the same.
 *
 * /sysadmin is deliberately absent: it's an API prefix, not a page surface.
 * The sysadmin UI lives at /admin/sysadmin and is covered by /admin.
 */
const REDIRECT_ALLOWED_PREFIXES = [
  "/admin",
  "/manage",
  "/pertrack",
  "/inventory",
  "/workorders",
  "/schedule",
  "/forms"
];

function sanitizeRedirect(target: string): string {
  if (!target) return "/";
  if (!target.startsWith("/")) return "/";
  if (target.startsWith("//")) return "/"; // protocol-relative — reject
  for (const prefix of REDIRECT_ALLOWED_PREFIXES) {
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
