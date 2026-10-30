// Impersonation start / mode / stop -- /sysadmin/api/impersonation/*.
//
// The rules that matter run on EVERY request, inside @splash/auth's
// authenticate() (see packages/auth/src/impersonation.ts). These endpoints
// only open, change and close a grant.
//
// WHY THEY SIT IN FRONT OF THIS WORKER'S NORMAL GATE
//   The normal gate calls authenticate(), which -- while impersonating --
//   returns the TARGET, who is never a super_admin, so it would 403. That is
//   correct for every other sysadmin endpoint (you see what they see) and
//   fatal here: you could never stop. All three use { ownIdentity: true }.
//
// WHY HERE AND NOT dashboard-worker
//   dashboard-worker's production routes are bound one path at a time, so a
//   new endpoint there means binding a new route. This worker owns
//   /sysadmin/api/* by wildcard, already holds user management and already
//   writes sysadmin_audit_log.

import {
  authenticate,
  buildImpersonateCookie,
  clearImpersonateCookie,
  getAccessToken,
  getCookie,
  IMPERSONATE_COOKIE,
  IMPERSONATION_MAX_SECONDS,
  newImpersonationToken,
  sha256Hex,
  tokenAal,
  type ImpersonationMode
} from "@splash/auth";
import {
  createServiceClient,
  getAuthContext,
  logSysadminAudit,
  type SupabaseEnv
} from "@splash/db-supabase";
import { isOriginAllowed, jsonError } from "@splash/http";

export const IMPERSONATION_PATH_RE = /^\/sysadmin\/api\/impersonation\/(start|mode|stop)$/;

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const REASON_MAX = 500;
const TARGET_TYPE = "auth_impersonation";

function jsonWithCookie(status: number, body: unknown, cookie: string): Response {
  const headers = new Headers({ "Content-Type": "application/json", "Cache-Control": "no-store" });
  headers.append("Set-Cookie", cookie);
  return new Response(JSON.stringify(body), { status, headers });
}

function readMode(v: unknown): ImpersonationMode | null {
  return v === "view" || v === "act" ? v : null;
}
function readReason(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 && t.length <= REASON_MAX ? t : null;
}

export async function handleImpersonation(
  request: Request,
  env: SupabaseEnv,
  action: "start" | "mode" | "stop"
): Promise<Response> {
  if (request.method !== "POST") return jsonError(405, "POST required");
  if (!isOriginAllowed(request)) return jsonError(403, "bad origin");

  const auth = await authenticate(request, env, { ownIdentity: true });
  if (auth.status !== "authenticated") return jsonError(401, "unauthorized");
  const me = auth.session;
  const sb = createServiceClient(env);

  // ── stop ─────────────────────────────────────────────────────────────────
  // Deliberately NOT super_admin-gated: someone whose role was removed while
  // impersonating must still be able to clear the cookie. It can only end a
  // grant that is theirs.
  if (action === "stop") {
    const token = getCookie(request, IMPERSONATE_COOKIE);
    if (token) {
      const { data } = await sb
        .from("auth_impersonation")
        .update({ ended_at: new Date().toISOString(), ended_reason: "stopped" })
        .eq("token_hash", await sha256Hex(token))
        .eq("actor_user_id", me.userId)
        .is("ended_at", null)
        .select("id,target_user_id,target_email,mode");
      const ended = (data ?? [])[0] as
        | { id: string; target_user_id: string; target_email: string; mode: string }
        | undefined;
      if (ended) {
        await logSysadminAudit(sb, {
          actor: { id: me.userId, email: me.email },
          action: "impersonation_stop",
          target_type: TARGET_TYPE,
          target_id: ended.target_user_id,
          after: { grant_id: ended.id, target_email: ended.target_email, mode: ended.mode }
        });
      }
    }
    // Cleared whatever happened above: stopping must always work.
    return jsonWithCookie(200, { ok: true }, clearImpersonateCookie());
  }

  // ── start / mode: super_admin at aal2, every time ────────────────────────
  if (me.role !== "super_admin") return jsonError(403, "forbidden");
  const accessToken = getAccessToken(request);
  if (!accessToken || tokenAal(accessToken) !== "aal2") {
    return jsonError(403, "Two-factor sign-in is required to view as another user.");
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonError(400, "Invalid JSON");
  }
  const mode = readMode(body.mode);
  if (!mode) return jsonError(400, "mode must be 'view' or 'act'");
  const reason = readReason(body.reason);

  if (action === "mode") {
    // Every switch needs a reason; act is the one that matters, and asking
    // for it on the way back to view too keeps the log readable as a story.
    if (!reason) return jsonError(400, `reason required (1-${REASON_MAX} characters)`);
    const token = getCookie(request, IMPERSONATE_COOKIE);
    if (!token) return jsonError(409, "not impersonating");
    const { data, error } = await sb
      .from("auth_impersonation")
      .update({ mode })
      .eq("token_hash", await sha256Hex(token))
      .eq("actor_user_id", me.userId)
      .is("ended_at", null)
      .gt("expires_at", new Date().toISOString())
      .select("id,target_user_id,target_email,expires_at");
    if (error) return jsonError(500, "mode change failed");
    const row = (data ?? [])[0] as
      | { id: string; target_user_id: string; target_email: string; expires_at: string }
      | undefined;
    if (!row) return jsonError(409, "impersonation has ended");
    await logSysadminAudit(sb, {
      actor: { id: me.userId, email: me.email },
      action: "impersonation_mode",
      target_type: TARGET_TYPE,
      target_id: row.target_user_id,
      after: { grant_id: row.id, target_email: row.target_email, mode },
      notes: reason
    });
    return new Response(
      JSON.stringify({ ok: true, mode, target_email: row.target_email, expires_at: row.expires_at }),
      { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } }
    );
  }

  // ── start ────────────────────────────────────────────────────────────────
  if (!reason) return jsonError(400, `reason required (1-${REASON_MAX} characters)`);
  const targetId = typeof body.user_id === "string" ? body.user_id.trim() : "";
  if (!UUID_RE.test(targetId)) return jsonError(400, "user_id must be a UUID");
  if (targetId === me.userId) return jsonError(400, "You can't view as yourself.");

  const target = await getAuthContext(sb, targetId);
  if (!target) {
    return jsonError(404, "That user has no permissions record, so there is nothing to see as them.");
  }
  // Checked again on every request; refused here so the error is legible.
  if (target.role === "super_admin") {
    return jsonError(403, "Super admins can't be impersonated.");
  }

  // One live grant per operator: starting a new one ends the old, so a
  // forgotten tab can't leave a second identity quietly valid.
  const nowIso = new Date().toISOString();
  await sb
    .from("auth_impersonation")
    .update({ ended_at: nowIso, ended_reason: "superseded" })
    .eq("actor_user_id", me.userId)
    .is("ended_at", null);

  const token = newImpersonationToken();
  const expiresAt = new Date(Date.now() + IMPERSONATION_MAX_SECONDS * 1000).toISOString();
  const { data: inserted, error } = await sb
    .from("auth_impersonation")
    .insert({
      token_hash: await sha256Hex(token),
      actor_user_id: me.userId,
      actor_email: me.email,
      target_user_id: target.userId,
      target_email: target.email,
      mode,
      reason,
      expires_at: expiresAt
    })
    .select("id")
    .single();
  if (error || !inserted) {
    console.error("[sysadmin.impersonation] grant insert failed", error);
    return jsonError(500, "Could not start impersonation.");
  }

  await logSysadminAudit(sb, {
    actor: { id: me.userId, email: me.email },
    action: "impersonation_start",
    target_type: TARGET_TYPE,
    target_id: target.userId,
    after: {
      grant_id: (inserted as { id: string }).id,
      target_email: target.email,
      mode,
      expires_at: expiresAt
    },
    notes: reason
  });

  return jsonWithCookie(
    200,
    { ok: true, target_email: target.email, mode, expires_at: expiresAt },
    buildImpersonateCookie(token)
  );
}
