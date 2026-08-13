// Session validation. Reads the sb-access-token cookie, validates against
// /auth/v1/user, and loads the Session via @splash/db-supabase.getAuthContext
// (which reads the auth_unified view in a single query).
//
// See ./index.ts for the security contract — the auth_unified view is the
// canonical source for all auth context fields.

import { createServiceClient, getAuthContext, type SupabaseEnv } from "@splash/db-supabase";
import type { AuthUser } from "@splash/types/auth";
import type { Session } from "@splash/types/session";
import { getAccessToken } from "./cookies.js";

// Re-export Session for convenience — many consumers will only import from
// @splash/auth and shouldn't have to know that Session lives in @splash/types.
export type { Session };

export type AuthOutcome =
  | { status: "authenticated"; session: Session }
  | { status: "unauthenticated" };

/**
 * Validate the request's session.
 *
 *   - No cookie / invalid token              → "unauthenticated"
 *   - Valid token but no auth_unified row    → "unauthenticated"
 *     (user authenticated but has no permissions; treat as a non-session
 *      so the caller's gates fire normally — they can't do anything anyway)
 *   - Valid token + auth_unified row         → { authenticated, session }
 *
 * Does NOT short-circuit on must_change_password — that's the caller's
 * decision. Different workers route differently when forced reset is required.
 */
export async function authenticate(
  request: Request,
  env: SupabaseEnv & { MFA_ENFORCE?: string }
): Promise<AuthOutcome> {
  const token = getAccessToken(request);
  if (!token) return { status: "unauthenticated" };

  // Single /auth/v1/user round-trip validates the token AND surfaces whether
  // the user has a verified factor (the response carries a `factors` array).
  // No second network call for the MFA gate below.
  const validated = await getAuthUserWithFactors(env, token);
  if (!validated) return { status: "unauthenticated" };
  const { user, hasVerifiedFactor } = validated;

  // ── MFA enforcement (layer 3) ───────────────────────────────────────────
  // Flag-gated + factor-scoped. Only a user who has a VERIFIED factor is
  // required to be at aal2; everyone else is untouched. Off by default: when
  // MFA_ENFORCE is unset this block is skipped and behavior is byte-for-byte
  // identical to pre-MFA. The aal read is a local JWT decode — the token was
  // just proven authentic + unexpired by the /user call above, so reading a
  // claim off it needs no signature check. An enrolled user whose session is
  // still aal1 is treated as unauthenticated, so the caller's normal
  // login-redirect fires and they re-authenticate through the MFA step.
  if (isMfaEnforced(env) && hasVerifiedFactor && tokenAal(token) !== "aal2") {
    return { status: "unauthenticated" };
  }

  const sb = createServiceClient(env);
  const session = await getAuthContext(sb, user.id);
  if (!session) return { status: "unauthenticated" };

  return { status: "authenticated", session };
}

/** MFA enforcement is opt-in per worker via the MFA_ENFORCE env var. */
function isMfaEnforced(env: { MFA_ENFORCE?: string }): boolean {
  return env.MFA_ENFORCE === "true" || env.MFA_ENFORCE === "1";
}

/**
 * Decode the `aal` claim from a Supabase access-token JWT WITHOUT verifying the
 * signature. Safe here only because the caller has already validated the token
 * via /auth/v1/user — this just reads a claim off a token GoTrue already
 * vouched for. Returns "aal1" | "aal2" | null (null = malformed / claim absent).
 */
function tokenAal(token: string): string | null {
  const [, payloadSegment] = token.split(".");
  if (!payloadSegment) return null;
  try {
    const b64 = payloadSegment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const payload = JSON.parse(atob(padded)) as { aal?: unknown };
    return typeof payload.aal === "string" ? payload.aal : null;
  } catch {
    return null;
  }
}

/**
 * Validate an access token via /auth/v1/user and, in the same response, read
 * whether the user has at least one VERIFIED factor. Mirrors getAuthUser but
 * keeps the `factors` array that the typed AuthUser drops — used only by
 * authenticate() so the MFA gate costs no extra round-trip.
 */
async function getAuthUserWithFactors(
  env: SupabaseEnv,
  accessToken: string
): Promise<{ user: AuthUser; hasVerifiedFactor: boolean } | null> {
  const r = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${accessToken}`
    }
  });
  if (!r.ok) return null;
  const data = (await r.json()) as AuthUser & {
    factors?: Array<{ status?: string }>;
  };
  const hasVerifiedFactor =
    Array.isArray(data.factors) && data.factors.some((f) => f.status === "verified");
  return { user: data, hasVerifiedFactor };
}

/**
 * Build a Session from an already-validated AuthUser. Skips both the cookie
 * read and the /auth/v1/user round-trip. Used on the login response path —
 * supabasePasswordLogin returns the user object in hand, so there's no point
 * re-validating the token to get back to the same object.
 *
 * Returns null when the user has no auth_unified row (logged in successfully
 * but has no permissions / role assigned). Caller decides whether to set
 * cookies + show a "no access" page or reject the login.
 */
export async function buildSessionForUser(
  env: SupabaseEnv,
  user: AuthUser
): Promise<Session | null> {
  const sb = createServiceClient(env);
  return getAuthContext(sb, user.id);
}

/**
 * Readability sugar — equivalent to `session.mustChangePassword`. Use the
 * one that reads better at the call site.
 */
export function requiresPasswordChange(session: Session): boolean {
  return session.mustChangePassword;
}

/**
 * Validate an access token against /auth/v1/user. Returns null when invalid.
 * Source: legacy/dashboard.js:118, legacy/signupworker.js:715.
 */
export async function getAuthUser(env: SupabaseEnv, accessToken: string): Promise<AuthUser | null> {
  const r = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${accessToken}`
    }
  });
  if (!r.ok) return null;
  const user = (await r.json()) as AuthUser;
  return user;
}
