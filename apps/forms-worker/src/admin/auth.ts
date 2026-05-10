// Brief 94 — admin auth gate helper.
//
// Mirrors fleet's admin gate pattern from Brief 83 (apps/fleet-inquiry-worker/
// src/admin.js authenticateAdmin). Allow when:
//   - session.role === "super_admin"      (global admin role)
//   - session.dcRole === "admin"          (damage-claim admin tier)
//   - session.dcRole === "super_admin"    (defense-in-depth)
//
// The brief's stub assumed `authenticate(env, cookieHeader)` returning
// `Session | null`; the actual @splash/auth surface is
// `authenticate(request, env)` returning an `AuthOutcome` discriminated
// union — we use that here. Same outcome as the fleet helper, just the
// canonical surface.
//
// 503 posture for service-key-unbound matches Brief 87 (fleet) — surface
// configuration-required as a typed status rather than a confusing 500.
// Auth itself depends on the service key (createServiceClient inside
// @splash/auth reads SUPABASE_SERVICE_KEY) so a missing key collapses
// every admin endpoint to 503 anyway.

import { authenticate, type Session } from "@splash/auth";
import type { Env } from "../index.js";

export type AdminGateResult =
  | { ok: true; session: Session }
  | { ok: false; status: number; body: string };

export async function adminGate(env: Env, req: Request): Promise<AdminGateResult> {
  const auth = await authenticate(req, env);
  if (auth.status !== "authenticated") {
    return {
      ok: false,
      status: 401,
      body: JSON.stringify({ error: "unauthenticated" })
    };
  }
  const { session } = auth;
  const allowed =
    session.role === "super_admin" ||
    session.dcRole === "admin" ||
    session.dcRole === "super_admin";
  if (!allowed) {
    return {
      ok: false,
      status: 403,
      body: JSON.stringify({
        error: "forbidden",
        reason: "Form builder access requires super_admin or dc_role admin."
      })
    };
  }
  return { ok: true, session };
}

export function adminGateResponse(result: AdminGateResult & { ok: false }): Response {
  return new Response(result.body, {
    status: result.status,
    headers: { "Content-Type": "application/json" }
  });
}

/**
 * Returns a 503 response when SUPABASE_SERVICE_KEY is unbound, otherwise null.
 * Caller pattern:
 *
 *     const sk = requireServiceKey(env); if (sk) return sk;
 */
export function requireServiceKey(env: Env): Response | null {
  if (!env.SUPABASE_SERVICE_KEY) {
    return new Response(JSON.stringify({ error: "service_key_unbound" }), {
      status: 503,
      headers: { "Content-Type": "application/json" }
    });
  }
  return null;
}
