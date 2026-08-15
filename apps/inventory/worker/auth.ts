// Auth gate for splash-inventory.
//
// Mirrors beekeeper-worker's scheduleGate: authenticate() (SSO cookie -> session)
// then checkToolAccess(session, "inventory"). The editor/viewer tiers the
// standalone app used to have are collapsed into this single grant — anyone
// with the `inventory` grant can view + submit for their locations; super_admin
// gets full admin (products, package config, recipients, edit/delete visits).
//
// Per-location scope is identical to pricing/schedule: super_admin sees
// everything (session.locations is empty and implies global); everyone else is
// limited to session.locations (an array of location_code strings).
//
// ONE inventory-specific twist: the session handed back by inventoryGate has
// its `locations` EXPANDED with the inventory.locations overlay (see
// overlay.ts). Some profit centres — wash-only in-bays, self serves — exist
// as inventory locations but have no pricing_simple row and therefore no
// grantable location_code of their own. Expanding once, here, means every
// downstream check inherits it for free: userCanAccessLocation below,
// allowedCodes/inScope in db.ts, and the `locations` array GET /api/me hands
// the SPA for its own client-side filtering. Nothing else had to change.

import { authenticate, checkToolAccess } from "@splash/auth";
import { createServiceClient, type SupabaseClient } from "@splash/db-supabase";
import { jsonError } from "@splash/http";
import type { Session } from "@splash/types/session";
import type { Env } from "./env.js";
import { expandGrantedCodes, loadOverlay } from "./overlay.js";

/** True if the session may read/write inventory for the given location_code. */
export function userCanAccessLocation(session: Session, locationCode: string): boolean {
  if (session.role === "super_admin") return true;
  const code = locationCode.trim().toLowerCase();
  return session.locations.some((l) => l.toLowerCase() === code);
}

/** True if the session has full-admin powers (products, config, recipients,
 *  edit/delete visits). Collapsed model: super_admin only. */
export function isInventoryAdmin(session: Session): boolean {
  return session.role === "super_admin";
}

/** Discriminated-union outcome of the inventory gate. */
export type InventoryGate =
  | { ok: true; session: Session; sb: SupabaseClient }
  | { ok: false; response: Response };

/**
 * Common gate for every inventory API handler: authenticate + `inventory`
 * tool grant. super_admin bypasses the grant check inside checkToolAccess;
 * everyone else needs an explicit `inventory` grant (managed via splash
 * sysadmin). Returns a service-role Supabase client on success.
 */
export async function inventoryGate(request: Request, env: Env): Promise<InventoryGate> {
  const auth = await authenticate(request, env);
  if (auth.status !== "authenticated") {
    return { ok: false, response: jsonError(401, "unauthorized") };
  }
  if (!checkToolAccess(auth.session, "inventory")) {
    return { ok: false, response: jsonError(403, "forbidden") };
  }

  const sb = createServiceClient(env);

  // super_admin's locations array is empty and implies global, so expanding it
  // would be both pointless and wrong (expandGrantedCodes returns [] for an
  // empty input rather than every child in the table). Skip the read for them.
  if (auth.session.role === "super_admin" || auth.session.locations.length === 0) {
    return { ok: true, session: auth.session, sb };
  }

  const overlay = await loadOverlay(sb);
  const locations = expandGrantedCodes(auth.session.locations, overlay);
  return { ok: true, session: { ...auth.session, locations }, sb };
}
