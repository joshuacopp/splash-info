// Auth gate for splash-inventory.
//
// Mirrors beekeeper-worker's scheduleGate: authenticate() (SSO cookie ->
// session) then a tool-grant check. Unlike the other tools, inventory has three
// nested grants rather than one (see ToolName in packages/types/src/auth.ts):
//
//   inventory_view    read-only
//   inventory         read + write   (submit AND edit visits, package config,
//                                     report, resolve flags)
//   inventory_admin   read + write + admin (delete visits, products,
//                                     recipients, resend)
//
// They nest, so a user holds exactly one. The standalone app originally had
// editor/viewer tiers, they were collapsed into the single `inventory` grant on
// integration (2026-08-14), and this splits them back out (2026-08-19) — this
// time with an admin tier as well, because inventory admin used to mean
// `role === "super_admin"`, i.e. the whole platform.
//
// TIER IS NOT SCOPE. Per-location scope is unchanged and identical to
// pricing/schedule: super_admin sees everything (session.locations is empty and
// implies global); everyone else is limited to session.locations (an array of
// location_code strings). An inventory_admin granted two sites administers two
// sites. Widening someone to every location is still a separate act — add the
// user_permissions rows.
//
// ONE inventory-specific twist: the session handed back by inventoryGate has
// its `locations` EXPANDED with the inventory.locations overlay (see
// overlay.ts). Some profit centres — wash-only in-bays, self serves — exist
// as inventory locations but have no pricing_simple row and therefore no
// grantable location_code of their own. Expanding once, here, means every
// downstream check inherits it for free: userCanAccessLocation below,
// allowedCodes/inScope in db.ts, and the `locations` array GET /api/me hands
// the SPA for its own client-side filtering. Nothing else had to change.

// checkToolAccess is deliberately NOT used here: it tests a single tool name,
// and inventory access is "any of three". canReadInventory below does the same
// super_admin bypass.
import { authenticate } from "@splash/auth";
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

/** Every grant that opens the app at all, weakest first. */
const INVENTORY_GRANTS = ["inventory_view", "inventory", "inventory_admin"] as const;

/** True if the session may open the app in any capacity (read at minimum). */
export function canReadInventory(session: Session): boolean {
  if (session.role === "super_admin") return true;
  return INVENTORY_GRANTS.some((grant) => session.tools.includes(grant));
}

/**
 * True if the session may create/modify data: submit a visit, EDIT a visit,
 * save package config, send a visit report, resolve or unresolve a flag.
 *
 * Editing sits here rather than with the admin tier because the person most
 * likely to need it is the person who filed the visit — a mistyped count should
 * not require an admin to fix. Deleting a visit is the irreversible one and
 * stays with isInventoryAdmin.
 *
 * The tiers nest, so `inventory_admin` implies this without also needing the
 * `inventory` grant — otherwise every admin would need two rows and forgetting
 * the second would produce an "admin" who can delete visits but not file one.
 */
export function canWriteInventory(session: Session): boolean {
  if (session.role === "super_admin") return true;
  return session.tools.includes("inventory") || session.tools.includes("inventory_admin");
}

/**
 * True if the session has full-admin powers: DELETE a visit, upsert products,
 * manage the recipient list, resend a report. (Editing a visit is NOT here —
 * see canWriteInventory.)
 *
 * Was `role === "super_admin"` and nothing else. That is retained (a platform
 * super_admin is still an inventory admin everywhere) but is no longer the only
 * route, so inventory admin can be delegated without handing over sysadmin.
 */
export function isInventoryAdmin(session: Session): boolean {
  if (session.role === "super_admin") return true;
  return session.tools.includes("inventory_admin");
}

/** Discriminated-union outcome of the inventory gate. */
export type InventoryGate =
  | { ok: true; session: Session; sb: SupabaseClient }
  | { ok: false; response: Response };

/**
 * Common gate for every inventory API handler: authenticate + hold ANY of the
 * three inventory grants. super_admin bypasses the grant check; everyone else
 * needs an explicit grant (issued via splash sysadmin).
 *
 * This is deliberately the weakest of the three checks — it only establishes
 * "may open the app". Write and admin capability are checked per route with
 * canWriteInventory / isInventoryAdmin, because the gate cannot know whether a
 * given handler mutates. Any NEW mutating route must add its own check; the
 * gate passing is not permission to write.
 */
export async function inventoryGate(request: Request, env: Env): Promise<InventoryGate> {
  const auth = await authenticate(request, env);
  if (auth.status !== "authenticated") {
    return { ok: false, response: jsonError(401, "unauthorized") };
  }
  if (!canReadInventory(auth.session)) {
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
