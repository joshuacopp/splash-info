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
export async function authenticate(request: Request, env: SupabaseEnv): Promise<AuthOutcome> {
  const token = getAccessToken(request);
  if (!token) return { status: "unauthenticated" };

  const user = await getAuthUser(env, token);
  if (!user) return { status: "unauthenticated" };

  const sb = createServiceClient(env);
  const session = await getAuthContext(sb, user.id);
  if (!session) return { status: "unauthenticated" };

  return { status: "authenticated", session };
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
