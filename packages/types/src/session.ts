// Authenticated session shape — populated from the `auth_unified` Supabase view.
//
// PURE DATA: no methods, no getters, no computed properties. All derivation
// (e.g. "is super_admin?", "can see all claims?") happens at the call site.
// Keeps the type JSON-serializable and trivially constructable from a plain
// row.

import type { ToolName, UserRole } from "./auth.js";
import type { DamageRole } from "./claims.js";
import type { PromoRole } from "./promo.js";

export interface Session {
  /** UUID — auth.users.id / user_permissions.user_id. */
  userId: string;

  email: string;

  /** Pricing/admin role (MAX over user_permissions rows; consistent per
   *  user in practice — one row for super_admin, N rows for location_admin). */
  role: UserRole;

  /** True if any user_permissions row has must_change_password = true.
   *  Caller MUST redirect to a password-change flow before granting access.
   *  See @splash/auth/index.ts for the security context. */
  mustChangePassword: boolean;

  /** Granted tools — subset of {pricing, claims, pertrack}. */
  tools: ToolName[];

  /** Pricing/admin location scope. Empty array {} for super_admins (their
   *  role implies global). */
  locations: string[];

  /** Damage workflow role. Null when the user has no row in
   *  damage_claim_user_roles. */
  dcRole: DamageRole | null;

  /** Damage workflow location scope. Only populated for gm/rm; empty {}
   *  for admin/super_admin (their dcRole implies global). */
  dcLocations: string[];

  /** Promotions workflow role. Null when the user has no row in
   *  promo_user_roles. Brief 153 — surfaced via the `auth_unified`
   *  view's `promo_role` column. */
  promoRole: PromoRole | null;
}
