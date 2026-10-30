// Impersonation: a super_admin seeing -- and optionally acting -- as another
// user, without ever holding that user's credentials.
//
// ===========================================================================
// THE SHAPE OF IT
// ===========================================================================
// The operator's OWN Supabase token stays in sb-access-token the whole time.
// Nothing here mints, borrows or stores a token for the target: no password
// reset, no magic link. A second cookie, sb-impersonate, carries an opaque
// random value whose SHA-256 is the key of an auth_impersonation row. On every
// request authenticate() validates the operator's token exactly as before and
// THEN, if that cookie is present, asks decideImpersonation() whether to hand
// the handler the target's Session instead of the operator's.
//
// Because every worker builds its Session through authenticate(), that one
// swap is the whole feature on the server. No worker has per-worker code.
//
// ===========================================================================
// WHAT IS RE-CHECKED ON EVERY REQUEST, AND WHY NOT JUST AT START
// ===========================================================================
//   - the grant exists, is not ended, is not past expires_at
//   - the grant belongs to the person whose token this is
//   - that person is a super_admin NOW (read live from auth_unified), so
//     removing someone's role ends their impersonation on the next click
//   - that person's token is aal2 -- a stolen aal1 cookie pair is not enough
//   - the target exists and is NOT a super_admin
// A check done once at start would survive every one of those changing.
//
// ===========================================================================
// WRITES: "view" REFUSES THEM, "act" LOGS THEM -- AND THE RECORD SAYS THE TARGET
// ===========================================================================
// In act mode session.email / session.userId ARE the target's, because every
// permission check in the codebase keys on them (current_approver_emails,
// email-on-locations, dc_locations). So whatever a write records -- workflow
// history, comments, claim activity, an "Approved" email -- names the TARGET.
// The honest record of who really did it is auth_impersonation_action: one
// row per non-read request, written HERE, before the handler runs. If that
// insert fails the request is refused. The log is the only thing that makes
// act mode truthful, so it is fail-CLOSED, unlike sysadmin_audit_log.
//
// A logged row means the request was ATTEMPTED, not that it succeeded: this
// runs before the handler, which may still reject it. A worker that calls
// authenticate() twice in one request logs twice. Both are acceptable for an
// audit trail and both are why the table is called *_action, not *_change.
//
// ===========================================================================
// AN INVALID GRANT NEVER SILENTLY BECOMES "ACT AS YOURSELF"
// ===========================================================================
// Cookie present but grant expired / ended / mismatched: reads fall back to
// the operator's own session (the banner disappears, which is the signal),
// but WRITES ARE REFUSED. Otherwise someone who thought they were acting as
// Dan, past the hour, would click Approve and have it recorded as themselves
// -- truthful, and not what they meant to do.

import type { SupabaseClient } from "@splash/db-supabase";
import type { ImpersonationInfo, ImpersonationMode, Session } from "@splash/types/session";

export const IMPERSONATE_COOKIE = "sb-impersonate";

/** One hour, matching the access-token lifetime. Not renewable: a longer
 *  session is a new grant with a new reason. */
export const IMPERSONATION_MAX_SECONDS = 60 * 60;

export type { ImpersonationInfo, ImpersonationMode };

/**
 * POSTs that only READ, and so stay allowed in view mode. Keep this short and
 * anchored: anything listed here is writable-looking traffic let through a
 * read-only gate. A missing entry fails safe (the read is refused in view
 * mode); a wrong entry does not.
 */
const READ_ONLY_POST_PATHS: readonly RegExp[] = [
  // Promo announcement preview: renders HTML, writes nothing (Brief 160).
  /^\/promo\/api\/promos\/[^/]+\/announce\/preview$/,
  // Forms render-time lookups: resolve a value for display (Briefs 93 / price grid).
  /^\/forms\/api\/lookup\/[^/]+$/,
  /^\/forms\/api\/packages\/[^/]+$/
];

export function isWriteRequest(method: string, pathname: string): boolean {
  const m = method.toUpperCase();
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") return false;
  if (m === "POST" && READ_ONLY_POST_PATHS.some((re) => re.test(pathname))) return false;
  return true;
}

/** Row shape of public.auth_impersonation, as far as the gate needs it. */
export interface ImpersonationGrantRow {
  id: string;
  actor_user_id: string;
  target_user_id: string;
  mode: ImpersonationMode;
  expires_at: string;
  ended_at: string | null;
}

export type ImpersonationRefusal =
  /** View mode and this is a write. */
  | "impersonation_view_only"
  /** The cookie is there but the grant is not good; refuse rather than act as yourself. */
  | "impersonation_ended"
  /** Act mode, and the audit row could not be written. */
  | "impersonation_log_failed";

export type ImpersonationDecision =
  /** No usable grant and not a write: carry on as the operator. */
  | { kind: "own" }
  | { kind: "refuse"; reason: ImpersonationRefusal }
  /** Swap to the target. `logWrite` = act-mode write that must be logged first. */
  | { kind: "impersonate"; session: Session; logWrite: boolean };

/**
 * PURE. Every rule lives here so it can be tested without a network; the
 * caller does the reads and the one write.
 */
export function decideImpersonation(input: {
  own: Session;
  /** aal claim of the operator's own token. */
  ownAal: string | null;
  grant: ImpersonationGrantRow | null;
  target: Session | null;
  now: Date;
  isWrite: boolean;
}): ImpersonationDecision {
  const { own, ownAal, grant, target, now, isWrite } = input;

  const usable =
    grant !== null &&
    grant.ended_at === null &&
    new Date(grant.expires_at).getTime() > now.getTime() &&
    grant.actor_user_id === own.userId &&
    own.role === "super_admin" &&
    ownAal === "aal2" &&
    target !== null &&
    target.userId === grant.target_user_id &&
    target.userId !== own.userId &&
    target.role !== "super_admin";

  if (!usable) {
    return isWrite ? { kind: "refuse", reason: "impersonation_ended" } : { kind: "own" };
  }
  // Narrowed by `usable`; restated for the compiler.
  const g = grant!;
  const t = target!;

  if (isWrite && g.mode === "view") {
    return { kind: "refuse", reason: "impersonation_view_only" };
  }

  const impersonation: ImpersonationInfo = {
    grantId: g.id,
    actorUserId: own.userId,
    actorEmail: own.email,
    mode: g.mode,
    expiresAt: g.expires_at
  };
  return {
    kind: "impersonate",
    session: {
      ...t,
      // The operator must see the target's pages, not be marched through the
      // TARGET's forced password change or MFA enrollment -- those endpoints
      // act on whoever's token this is, i.e. the operator. Also refused
      // outright while impersonating; see dashboard-worker.
      mustChangePassword: false,
      mfaEnrollment: undefined,
      impersonation
    },
    logWrite: isWrite
  };
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 32 random bytes, base64url. The cookie value; only its hash is stored. */
export function newImpersonationToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function buildImpersonateCookie(token: string, maxAge = IMPERSONATION_MAX_SECONDS): string {
  return `${IMPERSONATE_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearImpersonateCookie(): string {
  return `${IMPERSONATE_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export async function fetchGrantByToken(
  sb: SupabaseClient,
  token: string
): Promise<ImpersonationGrantRow | null> {
  const { data, error } = await sb
    .from("auth_impersonation")
    .select("id,actor_user_id,target_user_id,mode,expires_at,ended_at")
    .eq("token_hash", await sha256Hex(token))
    .maybeSingle();
  if (error) {
    // Unreadable is treated as no grant: reads continue as the operator,
    // writes are refused by decideImpersonation. Never as a valid grant.
    console.error("[auth.impersonation] grant read failed", error);
    return null;
  }
  return (data as ImpersonationGrantRow | null) ?? null;
}

/** The act-mode write log. Returns false on failure; the caller refuses. */
export async function logImpersonatedWrite(
  sb: SupabaseClient,
  session: Session,
  request: Request
): Promise<boolean> {
  const imp = session.impersonation;
  if (!imp) return false;
  const url = new URL(request.url);
  const { error } = await sb.from("auth_impersonation_action").insert({
    impersonation_id: imp.grantId,
    actor_user_id: imp.actorUserId,
    actor_email: imp.actorEmail,
    target_user_id: session.userId,
    target_email: session.email,
    method: request.method.toUpperCase(),
    host: url.host,
    path: url.pathname + url.search
  });
  if (error) {
    console.error("[auth.impersonation] action log failed -- refusing write", error);
    return false;
  }
  return true;
}
