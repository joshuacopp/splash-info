// Supply Orders gate, apps/web side: hides the tile and the "New order"
// button. The worker's canOrder is the real check; keep the two the same.
// Approving needs no grant -- the site's RM reaches an order from its email.

import type { Session } from "@splash/types/session";

export function canOrderSupplies(session: Session | null): boolean {
  if (!session) return false;
  return session.role === "super_admin" || (session.tools as readonly string[]).includes("supply_orders");
}
