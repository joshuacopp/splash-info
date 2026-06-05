// Brief 158b — recipient resolution helper for the announcement compose
// modal. Brief 158a's user-lookup stub blocked because @supabase/supabase-js
// isn't in apps/web's package.json and SUPABASE_* bindings aren't on
// splash-web. Brief 158b solves the same problem by routing the read
// through the promo-worker (whose service-key binding already exists).
//
// The actual SSR caller is the `getRecipientsForPromo` helper here, which
// wraps the worker-fetch `resolveRecipientsByLocations`.

import { resolveRecipientsByLocations } from "./worker-fetch";

/**
 * Resolve the AM/RM/site emails for a set of location codes, deduped and
 * sorted. Empty input → empty list. Failures are fail-soft (worker returns
 * empty recipients on error; UI surfaces the empty list and the operator
 * can type addresses manually).
 */
export async function resolveRecipients(
  locationCodes: string[]
): Promise<string[]> {
  if (!Array.isArray(locationCodes) || locationCodes.length === 0) return [];
  return resolveRecipientsByLocations(locationCodes);
}
