// Auth gate for beekeeper-worker.
//
// Mirrors apps/signup-worker/src/handlers/admin-pricing.ts (adminGate +
// userCanAccessLocation) but for the `schedule` tool, with one deliberate
// twist: the gate passes on super_admin OR a `schedule` grant OR a `pricing`
// grant. The operator decision (2026-07-10) is that anyone who can change
// MaxPass pricing for a location can also edit that location's shifts, so a
// separate grant isn't required for pricing admins — but `schedule` is ALSO an
// independently grantable/revocable tool (wired through sysadmin's existing
// grant/revoke + user_permissions location assignment).
//
// Per-location scope is identical to pricing: super_admin sees everything;
// everyone else is limited to session.locations.

import { authenticate, checkToolAccess } from "@splash/auth";
import { createServiceClient, type SupabaseClient } from "@splash/db-supabase";
import { jsonError } from "@splash/http";
import type { Session } from "@splash/types/session";
import type { Env } from "./env.js";

/** True if session may read/write shifts for the given location_code. */
export function userCanAccessLocation(session: Session, locationCode: string): boolean {
  if (session.role === "super_admin") return true;
  const code = locationCode.trim().toLowerCase();
  return session.locations.some((l) => l.toLowerCase() === code);
}

/** Discriminated-union outcome of the schedule gate. */
export type ScheduleGate =
  | { ok: true; session: Session; sb: SupabaseClient }
  | { ok: false; response: Response };

/**
 * Common gate for every schedule handler: authenticate + tool grant.
 *
 * Grant check: super_admin bypasses (inside checkToolAccess); otherwise the
 * user needs EITHER a `schedule` grant OR a `pricing` grant. The pricing
 * fallback is the "MaxPass pricing admins get shift access to their locations"
 * rule — checkToolAccess("pricing") is true for anyone who can already change
 * that location's pricing.
 *
 * Returns the session + a service-key client on success, or a typed error
 * response. CSRF is the caller's responsibility (write handlers run
 * isOriginAllowed BEFORE calling this).
 */
export async function scheduleGate(request: Request, env: Env): Promise<ScheduleGate> {
  const auth = await authenticate(request, env);
  if (auth.status !== "authenticated") {
    return { ok: false, response: jsonError(401, "unauthorized") };
  }
  const allowed =
    checkToolAccess(auth.session, "schedule") || checkToolAccess(auth.session, "pricing");
  if (!allowed) {
    return { ok: false, response: jsonError(403, "forbidden") };
  }
  return { ok: true, session: auth.session, sb: createServiceClient(env) };
}
