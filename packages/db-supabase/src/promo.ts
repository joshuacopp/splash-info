// Brief 153: promo helpers scaffolding. Implementation lands in Brief 154+.
// These exports exist so subsequent briefs have a stable import surface.

import type { PromoRole } from "@splash/types/promo";

export interface PromoAuthGate {
  promoRole: PromoRole | null;
  isAuthorized: boolean;
}

/**
 * Server-side promo-role gate.
 *
 * Returns isAuthorized=true when the caller has at least one of the
 * required roles. Pass an empty array to require any non-null promoRole.
 *
 * Future expansion: per-promo ACL (created_by + assignees) can be added
 * by widening the signature with a promoId; v1 is role-only.
 */
export function gatePromoRole(
  promoRole: PromoRole | null,
  required: PromoRole[]
): PromoAuthGate {
  if (!promoRole) return { promoRole: null, isAuthorized: false };
  if (required.length === 0) return { promoRole, isAuthorized: true };
  return { promoRole, isAuthorized: required.includes(promoRole) };
}
