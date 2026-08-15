// Profit-centre overlay for the inventory location list.
//
// The SPA's location list is synthesized from public.pricing_simple (see
// db.ts getLocations). That table is the customer-facing membership
// catalogue, so a profit centre with nothing to sell — a wash-only in-bay, a
// bank of self serves — cannot have a row there without appearing as a
// buyable monthly plan on the signup page. The chemical-inventory app still
// needs those as distinct locations, otherwise in-bay chemical usage is
// averaged into the tunnel's CPC over non-comparable wash counts.
//
// inventory.locations holds them. See supabase/inventory-locations-overlay.sql
// and the STEP 2 block in supabase/pricing-simple-inbays.sql.
//
// ACCESS: an overlay row's `parent_code` is a pricing_simple location_code.
// A user_permissions grant on the parent implies a grant on the child, so a
// Liverpool manager sees `liverpool_iba` without a second grant. Expansion is
// ONE level by design — a parent_code is never another overlay code, and this
// module does not follow chains.

import type { SupabaseClient } from "@splash/db-supabase";

export interface OverlayLocation {
  code: string;
  name: string;
  parent_code: string | null;
  active: boolean;
}

// Isolate-scoped cache. The overlay is a handful of rows that change roughly
// never, and it is read on every gated API call, so re-fetching per request
// would be a subrequest tax for nothing. A newly inserted overlay location can
// take up to TTL_MS to appear — acceptable for an admin-managed list, and the
// worst case is one stale isolate, not a wrong answer.
const TTL_MS = 60_000;
let cache: { rows: OverlayLocation[]; at: number } | null = null;

/** Drop the cache — call after any write to inventory.locations. */
export function invalidateOverlayCache(): void {
  cache = null;
}

/**
 * ALL overlay rows, active and not. `active: false` means sold or closed, not
 * deleted — the site's history still has to be readable, so the row is passed
 * through to the SPA with the flag intact rather than filtered out here. The
 * SPA already honours it: Layout drops `active === false` from the sidebar,
 * calc.js excludes it from company rollups, and LocationDashboard renders it
 * with an "inactive" pill if you navigate straight to its URL. Filtering here
 * would make those visits unreachable instead.
 *
 * Grant expansion covers inactive children too — whoever could see the site
 * while it was open should still be able to read its history.
 *
 * Fail-soft: on a read error we log and return [], so a transient Supabase
 * problem degrades to "the overlay locations are missing" rather than 500ing
 * every inventory page. pricing_simple locations, which are the overwhelming
 * majority, keep working.
 */
export async function loadOverlay(sb: SupabaseClient): Promise<OverlayLocation[]> {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.rows;

  const { data, error } = await sb
    .schema("inventory")
    .from("locations")
    .select("code,name,parent_code,active");

  if (error) {
    console.error("[inventory.overlay] load failed", error.message);
    return cache?.rows ?? [];
  }

  // Cast via unknown: the `inventory` schema isn't in the generated Database
  // types, so `data` comes back loosely typed (same reason db.ts's selectAll
  // casts). Shape is guaranteed by the select list above.
  const rows = (data || []) as unknown as OverlayLocation[];
  cache = { rows, at: now };
  return rows;
}

/**
 * Granted codes plus every overlay child of a granted code, lower-cased.
 *
 * Additive only — nothing already granted is ever removed, matching the
 * platform rule that grants never revoke scope. Returns a new array; the
 * caller's session is not mutated.
 */
export function expandGrantedCodes(
  granted: readonly string[],
  overlay: readonly OverlayLocation[]
): string[] {
  const out = new Set(granted.map((c) => c.trim().toLowerCase()).filter(Boolean));
  if (out.size === 0) return [];
  for (const row of overlay) {
    if (!row.parent_code) continue;
    if (out.has(row.parent_code.trim().toLowerCase())) {
      out.add(row.code.trim().toLowerCase());
    }
  }
  return [...out];
}
