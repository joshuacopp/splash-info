// TOTP MFA (Supabase GoTrue "factors") wrappers for the login/enrollment flow.
//
// These are thin, user-scoped calls to GoTrue's MFA REST surface, mirroring
// how supabasePasswordLogin (admin.ts) wraps /auth/v1/token. Every function
// here acts AS THE USER: it takes the caller's access_token (the sb-access-token
// cookie value) and sends it as the Bearer token. Nothing here uses the
// service_role key — enrollment and verification are the user's own actions.
// (Admin-side factor RESET, which DOES use service_role, is a separate helper
// added when the reset UI lands — see the MFA brief.)
//
// GoTrue MFA flow, for reference:
//   enroll  → POST /auth/v1/factors                → { id, totp:{ qr_code, secret, uri } }
//             creates an UNVERIFIED factor.
//   challenge → POST /auth/v1/factors/{id}/challenge → { id: challengeId }
//   verify  → POST /auth/v1/factors/{id}/verify     → NEW session at AAL2
//             (activates the factor on first verify; also used at login).
//
// THE AAL SUBTLETY (see brief): grant_type=password issues an AAL1 token
// regardless of enrollment. Completing a challenge/verify returns a NEW token
// pair carrying aal2. Callers that want to elevate the session must swap the
// auth cookies for the tokens returned by verifyFactor().
//
// Throw-on-failure semantics match supabasePasswordLogin — the WORKER handler
// decides whether to fail-safe (fall through to current behavior) or surface
// an error, so the policy lives at the call site, not buried here.

import type { SupabaseEnv } from "@splash/db-supabase";

export interface TotpEnrollResult {
  factorId: string;
  /** Inline SVG markup for the enrollment QR (render directly). */
  qrCode: string;
  /** Base32 seed — for manual entry when a camera isn't available. */
  secret: string;
  /** otpauth:// URI (alternative to the QR). */
  uri: string;
}

/** New token pair returned by a successful challenge+verify (AAL2). */
export interface MfaElevatedSession {
  accessToken: string;
  refreshToken: string;
}

export interface MfaFactor {
  id: string;
  status: "verified" | "unverified";
  factorType: string;
  friendlyName: string | null;
}

function userHeaders(env: SupabaseEnv, accessToken: string): HeadersInit {
  return {
    apikey: env.SUPABASE_ANON_KEY,
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json"
  };
}

async function gotrueError(r: Response, fallback: string): Promise<never> {
  const err = (await r.json().catch(() => ({}))) as {
    error_description?: string;
    msg?: string;
    message?: string;
  };
  throw new Error(err.error_description ?? err.msg ?? err.message ?? fallback);
}

/**
 * Enroll a new TOTP factor for the calling user. Returns the QR + secret to
 * display ONCE during enrollment. The factor is created UNVERIFIED; it does
 * not protect anything until a subsequent challenge+verify succeeds.
 */
export async function enrollTotpFactor(
  env: SupabaseEnv,
  accessToken: string,
  friendlyName?: string
): Promise<TotpEnrollResult> {
  const r = await fetch(`${env.SUPABASE_URL}/auth/v1/factors`, {
    method: "POST",
    headers: userHeaders(env, accessToken),
    body: JSON.stringify({
      factor_type: "totp",
      ...(friendlyName ? { friendly_name: friendlyName } : {})
    })
  });
  if (!r.ok) return gotrueError(r, "enroll failed");
  const data = (await r.json()) as {
    id: string;
    totp?: { qr_code?: string; secret?: string; uri?: string };
  };
  return {
    factorId: data.id,
    qrCode: data.totp?.qr_code ?? "",
    secret: data.totp?.secret ?? "",
    uri: data.totp?.uri ?? ""
  };
}

/**
 * Create a challenge for an existing factor. Returns the challenge id, which
 * pairs with the user's 6-digit code in verifyFactor(). Challenges are
 * short-lived (GoTrue expires them in ~5 min).
 */
export async function challengeFactor(
  env: SupabaseEnv,
  accessToken: string,
  factorId: string
): Promise<string> {
  const r = await fetch(`${env.SUPABASE_URL}/auth/v1/factors/${factorId}/challenge`, {
    method: "POST",
    headers: userHeaders(env, accessToken)
  });
  if (!r.ok) return gotrueError(r, "challenge failed");
  const data = (await r.json()) as { id: string };
  return data.id;
}

/**
 * Verify a 6-digit code against a challenge. On success GoTrue returns a NEW
 * session at AAL2 — the caller should swap the auth cookies for these tokens
 * to elevate the session. Used both at first-enrollment (activates the factor)
 * and at every subsequent login step-up.
 *
 * Throws on a bad/expired code (GoTrue 4xx) — caller maps that to a retry.
 */
export async function verifyFactor(
  env: SupabaseEnv,
  accessToken: string,
  factorId: string,
  challengeId: string,
  code: string
): Promise<MfaElevatedSession> {
  const r = await fetch(`${env.SUPABASE_URL}/auth/v1/factors/${factorId}/verify`, {
    method: "POST",
    headers: userHeaders(env, accessToken),
    body: JSON.stringify({ challenge_id: challengeId, code })
  });
  if (!r.ok) return gotrueError(r, "verify failed");
  const data = (await r.json()) as { access_token: string; refresh_token: string };
  return { accessToken: data.access_token, refreshToken: data.refresh_token };
}

/**
 * Convenience: challenge + verify in one call (the common case — the caller
 * only holds a factorId and a code, and doesn't need the challenge id).
 */
export async function challengeAndVerify(
  env: SupabaseEnv,
  accessToken: string,
  factorId: string,
  code: string
): Promise<MfaElevatedSession> {
  const challengeId = await challengeFactor(env, accessToken, factorId);
  return verifyFactor(env, accessToken, factorId, challengeId, code);
}

/**
 * List the calling user's factors (read from /auth/v1/user, which includes a
 * `factors` array). Works with an AAL1 token, so it's safe to call before the
 * MFA step to decide whether a step-up is required.
 */
export async function listFactors(
  env: SupabaseEnv,
  accessToken: string
): Promise<MfaFactor[]> {
  const r = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${accessToken}`
    }
  });
  if (!r.ok) return gotrueError(r, "list factors failed");
  const data = (await r.json()) as {
    factors?: Array<{
      id: string;
      status: string;
      factor_type?: string;
      friendly_name?: string | null;
    }>;
  };
  return (data.factors ?? []).map((f) => ({
    id: f.id,
    status: f.status === "verified" ? "verified" : "unverified",
    factorType: f.factor_type ?? "totp",
    friendlyName: f.friendly_name ?? null
  }));
}

/**
 * True when the user has at least one VERIFIED factor. This is the gate the
 * login flow and authenticate() use to decide whether a step-up is required
 * (opt-in enforcement: enrolled ⇒ must complete MFA). Unverified factors —
 * enrollment started but never confirmed — do NOT count.
 */
export async function hasVerifiedFactor(
  env: SupabaseEnv,
  accessToken: string
): Promise<boolean> {
  const factors = await listFactors(env, accessToken);
  return factors.some((f) => f.status === "verified");
}
