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

import { authenticate, checkToolAccess, type Session } from "@splash/auth";
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

// Widened to a structural `{ status, body }` so `submissionGate`'s failure
// shape can reuse it without importing `AdminGateResult`. Non-breaking:
// `AdminGateResult & { ok: false }` still satisfies this parameter.
export function adminGateResponse(result: { status: number; body: string }): Response {
  return new Response(result.body, {
    status: result.status,
    headers: { "Content-Type": "application/json" }
  });
}

// =============================================================================
// Submission scope gate (forms-submission location scoping)
// =============================================================================
//
// The form-builder endpoints stay super_admin / dc-admin only via `adminGate`.
// The submission-reading surface (list / csv / report / detail / PATCH /
// transition + pending-approvals) is additionally open to LOCATION ADMINS,
// scoped to their own site(s) — mirroring pricing gating in signup-worker's
// admin-pricing.ts (`checkToolAccess(session, "pricing")` +
// `userCanAccessLocation`).
//
// A caller resolves to one of two scopes:
//   - "all"                 — full admin tier (super_admin / dcRole admin /
//                             super_admin). Sees every submission; no filter.
//   - { locations: [...] }  — location admin holding the `form_submissions`
//                             tool grant. Sees only submissions whose stamped
//                             `location_code` is in their `session.locations`.
//
// Everyone else → 403. The tool-grant check is what a location admin needs;
// `session.locations` must be non-empty (a grant with no locations can't see
// anything and is treated as forbidden rather than an empty allow-list).

export const FORM_SUBMISSIONS_TOOL = "form_submissions";

/** Caller's submission-visibility scope. */
export type SubmissionScope = "all" | { locations: string[] };

export type SubmissionGateResult =
  | { ok: true; session: Session; scope: SubmissionScope }
  | { ok: false; status: number; body: string };

/** True when the session belongs to a full-admin tier (unscoped visibility). */
function isFullAdminTier(session: Session): boolean {
  return (
    session.role === "super_admin" ||
    session.dcRole === "admin" ||
    session.dcRole === "super_admin"
  );
}

/**
 * Gate for submission-reading endpoints. Returns the caller's `scope` so the
 * handler can push a `location_code=in.(...)` filter into its PostgREST query
 * (scoped callers) or run unfiltered ("all"). Location codes are lowercased to
 * match the denormalized `form_submissions.location_code` (stamped from
 * `pricing_simple` server-side, also lowercased).
 */
export async function submissionGate(
  env: Env,
  req: Request
): Promise<SubmissionGateResult> {
  const auth = await authenticate(req, env);
  if (auth.status !== "authenticated") {
    return {
      ok: false,
      status: 401,
      body: JSON.stringify({ error: "unauthenticated" })
    };
  }
  const { session } = auth;

  if (isFullAdminTier(session)) {
    return { ok: true, session, scope: "all" };
  }

  // Location admin path: needs the form_submissions tool grant AND at least
  // one location. checkToolAccess super_admin-bypasses, but super_admin is
  // already handled above, so here it's a pure grant check.
  if (checkToolAccess(session, FORM_SUBMISSIONS_TOOL) && session.locations.length > 0) {
    const locations = session.locations.map((l) => l.toLowerCase());
    return { ok: true, session, scope: { locations } };
  }

  return {
    ok: false,
    status: 403,
    body: JSON.stringify({
      error: "forbidden",
      reason:
        "Form submissions require super_admin, dc_role admin, or the form_submissions tool grant with an assigned location."
    })
  };
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
