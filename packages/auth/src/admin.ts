// Supabase Auth Admin API helpers.
//
// PASSWORD-SET POLICY (Josh, 2026-05-02):
//   "No @splash code path may set a password without flipping
//    must_change_password according to the action's intent."
//
// To enforce that at the API surface, the raw "set Supabase password"
// primitive is INTERNAL only. The three exported password-mutation
// functions each pair the password write with the appropriate
// must_change_password write:
//
//   adminResetPassword(userId, newPassword)
//     → must_change_password = true,  THEN  password = new
//        (flag-first ordering — see notes inline)
//
//   userCompleteForcedReset(session, newPassword)
//     → password = new,  THEN  must_change_password = false
//        (password-first ordering — see notes inline)
//
//   userChangePassword(session, currentPwd, newPwd)
//     → verify currentPwd, password = new,  flag UNCHANGED
//        (NOT YET IMPLEMENTED — no legacy equivalent; throws)
//
// IMPORTANT (gotcha #253): Password change uses
//   PUT /auth/v1/admin/users/{user_id}
// NOT an RPC. The legacy code may show an RPC pattern in older comments;
// the new code MUST use the admin REST endpoint with the service key.

import {
  createServiceClient,
  setMustChangePassword,
  type SupabaseEnv
} from "@splash/db-supabase";
import type { AuthUser } from "@splash/types/auth";
import type { Session } from "./session.js";
import { assertValidPassword } from "./password-policy.js";

interface PasswordLoginResponse {
  access_token: string;
  refresh_token: string;
  user: AuthUser;
}

/* ============================================================
 * Login (anon-key — does NOT bypass RLS)
 * ============================================================ */

/**
 * Email + password login via /auth/v1/token?grant_type=password.
 * Source: legacy/dashboard.js:69, legacy/signupworker.js:632, legacy/performancetracker.js:80.
 * Throws on failure with the Supabase error message.
 */
export async function supabasePasswordLogin(
  env: SupabaseEnv,
  email: string,
  password: string
): Promise<PasswordLoginResponse> {
  const r = await fetch(`${env.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ email, password })
  });
  if (!r.ok) {
    const err = (await r.json().catch(() => ({}))) as {
      error_description?: string;
      msg?: string;
      message?: string;
    };
    throw new Error(err.error_description ?? err.msg ?? err.message ?? "login failed");
  }
  return (await r.json()) as PasswordLoginResponse;
}

/**
 * Exchange a refresh token for a fresh access+refresh token pair via
 * /auth/v1/token?grant_type=refresh_token. This is the sliding-session
 * primitive: it mints a new 1-hour access token WITHOUT re-authenticating,
 * and — critically — GoTrue preserves the session's AAL on refresh, so an
 * aal2 (MFA-completed) session stays aal2 and an aal1 session stays aal1.
 * Refresh PRESERVES, never ELEVATES.
 *
 * GoTrue rotates the refresh token on each use (the returned refresh_token
 * differs from the input); callers must persist the NEW one. A brief reuse
 * grace window on GoTrue's side tolerates the occasional double-submit.
 *
 * Throws on failure (expired/revoked/rotated-away refresh token) with the
 * Supabase error message — caller treats that as "session over, go to login".
 */
export async function refreshSession(
  env: SupabaseEnv,
  refreshToken: string
): Promise<PasswordLoginResponse> {
  const r = await fetch(`${env.SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ refresh_token: refreshToken })
  });
  if (!r.ok) {
    const err = (await r.json().catch(() => ({}))) as {
      error_description?: string;
      msg?: string;
      message?: string;
    };
    throw new Error(err.error_description ?? err.msg ?? err.message ?? "refresh failed");
  }
  return (await r.json()) as PasswordLoginResponse;
}

/* ============================================================
 * Sanctioned password-mutation paths
 * ============================================================ */

/**
 * Admin-triggered password reset. Sets the user's password AND flips
 * must_change_password = true so the user is forced to choose a new password
 * on next login. Audit: caller's responsibility (logAudit equivalent).
 *
 * ORDERING (flag-first):
 *   1) Set must_change_password = true.
 *   2) Set new password via Admin API.
 * If step 2 fails, the user has the OLD password and flag = true. Next
 * login with old password → forced reset gate. Inconvenient but safe.
 * Reversing the order would leave a window where the new password is
 * active and the flag was not yet set — defeats the policy.
 *
 * Replaces legacy/sysadmin.js:492 apiResetPassword (which did NOT flip
 * the flag — that's the bug this fixes).
 */
export async function adminResetPassword(
  env: SupabaseEnv,
  userId: string,
  newPassword: string
): Promise<void> {
  if (!userId) throw new Error("userId required");
  assertValidPassword(newPassword);
  const sb = createServiceClient(env);
  await setMustChangePassword(sb, userId, true);
  await setSupabasePassword(env, userId, newPassword);
}

/**
 * User fulfilling the must_change_password gate after being forced to reset.
 * Sets the new password AND clears must_change_password.
 *
 * ORDERING (password-first):
 *   1) Set new password via Admin API.
 *   2) Set must_change_password = false.
 * If step 2 fails, the user has the NEW password but flag = true. Next
 * login → still hits the forced-reset gate, they redo the change.
 * Annoying but safe. Reversing the order would clear the flag while
 * the old password is still active — a forced-reset bypass.
 *
 * Mirrors legacy/signupworker.js:656 handleChangePassword behavior (legacy
 * does not verify the current password in this path; we don't either).
 *
 * The caller should sanity-check `session.mustChangePassword === true`
 * before invoking this — but we don't enforce that, because Step 6's
 * dashboard-worker bug-fix flow may force a user through this even when
 * the cookie session predates the flag flip.
 */
export async function userCompleteForcedReset(
  env: SupabaseEnv,
  session: Session,
  newPassword: string
): Promise<void> {
  assertValidPassword(newPassword);
  await setSupabasePassword(env, session.userId, newPassword);
  const sb = createServiceClient(env);
  await setMustChangePassword(sb, session.userId, false);
}

/**
 * Voluntary user-initiated password change. Verifies the current password,
 * then sets the new one. must_change_password is left unchanged (almost
 * always already false on this path).
 *
 * NOT YET IMPLEMENTED — there is no legacy equivalent. The unified
 * /admin/change-password route in legacy/signupworker.js:656 skips
 * current-password verification AND clears the flag regardless; that
 * route maps to userCompleteForcedReset under the new model. This
 * function exists as a typed hook for when voluntary-change ships as
 * a real feature.
 *
 * When implementing:
 *   1) Call supabasePasswordLogin(env, session.email, currentPassword)
 *      to verify the current password — throws on failure.
 *   2) On success, call the internal setSupabasePassword(env,
 *      session.userId, newPassword).
 *   3) Do NOT call setMustChangePassword.
 */
export async function userChangePassword(
  env: SupabaseEnv,
  session: Session,
  currentPassword: string,
  newPassword: string
): Promise<void> {
  // Suppress unused-arg warnings until implemented.
  void env;
  void session;
  void currentPassword;
  void newPassword;
  throw new Error(
    "userChangePassword: voluntary password change is not yet implemented. " +
      "Legacy has no equivalent code path — see @splash/auth/index.ts for the design."
  );
}

/* ============================================================
 * Internal helper — NOT exported.
 * Setting a password without pairing it with a must_change_password
 * write would violate the policy at the top of this file.
 * ============================================================ */

async function setSupabasePassword(
  env: SupabaseEnv,
  userId: string,
  newPassword: string
): Promise<void> {
  const r = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
    method: "PUT",
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ password: newPassword })
  });
  if (!r.ok) {
    const err = (await r.json().catch(() => ({}))) as { msg?: string; message?: string };
    throw new Error(err.msg ?? err.message ?? `Password update failed: ${r.status}`);
  }
}

/* ============================================================
 * Read-only Admin API helpers (no password mutation)
 * ============================================================ */

/**
 * Look up a single user by id via the Admin API.
 * Source: legacy/sysadmin.js:395 (used when setting a role to confirm email).
 */
export async function adminGetUser(env: SupabaseEnv, userId: string): Promise<AuthUser> {
  const r = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
    }
  });
  if (!r.ok) throw new Error(`adminGetUser failed: ${r.status}`);
  return (await r.json()) as AuthUser;
}

/**
 * List users via the Admin API. Returns up to `perPage` rows in one call;
 * legacy uses 1000 (the practical max for an internal-tools account).
 * Source: legacy/sysadmin.js:208 fetchUsersForList.
 */
export async function adminListUsers(env: SupabaseEnv, perPage = 1000): Promise<AuthUser[]> {
  const r = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users?per_page=${perPage}`, {
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
    }
  });
  if (!r.ok) throw new Error(`adminListUsers failed: ${r.status}`);
  const body = (await r.json()) as AuthUser[] | { users?: AuthUser[] };
  if (Array.isArray(body)) return body;
  return body.users ?? [];
}

/**
 * Create a new auth user (admin path — auto-confirms email by default).
 * Source: legacy/sysadmin.js:529 apiCreateUser.
 *
 * NOTE on must_change_password at create time: this helper only creates the
 * auth.users row. The user_permissions row is inserted separately (typically
 * by the same caller, immediately after). Legacy inserts user_permissions
 * with must_change_password: FALSE — meaning admin-created users do NOT hit
 * the forced-reset gate on first login under legacy behavior. Question
 * pending: should the user_permissions insert default to TRUE under Josh's
 * new policy? Holding for direction.
 */
export async function adminCreateUser(
  env: SupabaseEnv,
  args: { email: string; password: string; emailConfirm?: boolean }
): Promise<AuthUser> {
  assertValidPassword(args.password);
  const r = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      email: args.email.trim().toLowerCase(),
      password: args.password,
      email_confirm: args.emailConfirm ?? true
    })
  });
  if (!r.ok) {
    const err = (await r.json().catch(() => ({}))) as { msg?: string; message?: string };
    throw new Error(err.msg ?? err.message ?? `Create user failed: ${r.status}`);
  }
  return (await r.json()) as AuthUser;
}
