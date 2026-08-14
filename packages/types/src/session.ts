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

  /** MFA enrollment countdown state. Populated by authenticate() /
   *  buildSessionForUser from the user's created_at + verified-factor status,
   *  measured against the org-wide enrollment policy (see
   *  @splash/auth/mfa-policy). Undefined when the enrollment policy is not
   *  active for this build (MFA_ENROLL_ENFORCE unset) or when the user already
   *  has a verified factor (nothing to enroll). When present, the caller shows
   *  the countdown banner and, if `overdue`, routes to /mfa/enroll. */
  mfaEnrollment?: MfaEnrollmentStatus;
}

/** Per-user MFA enrollment countdown, derived from the org enrollment policy.
 *  Pure data — computed fresh on each authenticate(); never persisted. */
export interface MfaEnrollmentStatus {
  /** True when the user still needs to enroll a factor. (Currently equivalent
   *  to "has no verified factor" — enrollment is mandatory for all roles.) */
  required: boolean;

  /** ISO calendar date (YYYY-MM-DD) by which the user must enroll a factor.
   *  Pre-existing accounts: POLICY_START + GRACE_DAYS. Accounts created on or
   *  after POLICY_START: their creation date (must enroll on first login). */
  deadline: string;

  /** True once `deadline` has passed. The caller MUST block dashboard access
   *  and route to /mfa/enroll?required=true. Unlike mustChangePassword this is
   *  annotation-only inside authenticate() — the session stays authenticated so
   *  the enroll page itself remains reachable (no login redirect loop). */
  overdue: boolean;

  /** Whole days from `now` until `deadline`; 0 on the due date, negative once
   *  overdue. Drives the "N days left" banner copy. */
  daysRemaining: number;
}
