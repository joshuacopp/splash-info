// Profit-centre overlay, damage-worker side.
//
// Mirrors apps/inventory/worker/overlay.ts deliberately — same table, same
// one-level parent expansion, same fail-soft posture. It is duplicated rather
// than shared because the two workers reach Supabase differently (inventory
// holds a supabase-js client; damage-worker talks to PostgREST directly, as
// seed-jotform.ts does). Promote both to a package the moment a third consumer
// appears.
//
// WHAT THIS IS FOR
// A location's second profit centre — a lube, an in-bay automatic, a bank of
// self serves — cannot have a public.pricing_simple row, because that table is
// the customer-facing membership catalogue and a row there becomes a buyable
// monthly plan on the signup page. inventory.locations holds those instead.
//
// Damage claims care for two reasons:
//   1. Claims arrive from JotForm carrying only a site number. Bridgeport Lube
//      is site 23; the Bridgeport tunnel is 22. Without the overlay the lube's
//      claims resolve to no location and are dropped.
//   2. user_permissions grants are keyed to pricing_simple location_codes, and
//      the permission sync trigger destructively reconciles against that table,
//      so an overlay code can never hold a durable grant of its own. A grant on
//      the PARENT has to imply the child, or claims filed at `bridgeport_lube`
//      are visible to super_admin only and sit in a queue nobody works.

import type { SupabaseEnv } from "@splash/db-supabase";

export interface OverlayLocation {
  code: string;
  name: string;
  parent_code: string | null;
  active: boolean;
  /** Ops site number from public.locations; null for rows that never appear
   *  in a site-number-keyed feed. Added for the JotForm damage seed. */
  site_number: number | null;
}

// Isolate-scoped cache, same rationale as the inventory worker: a handful of
// rows that change roughly never, read on every scoped damage request. Worst
// case is one stale isolate for a minute, not a wrong answer.
const TTL_MS = 60_000;
let cache: { rows: OverlayLocation[]; at: number } | null = null;

/** Drop the cache — call after any write to inventory.locations. */
export function invalidateOverlayCache(): void {
  cache = null;
}

type OverlayEnv = SupabaseEnv & { SUPABASE_SERVICE_KEY?: string };

/**
 * All overlay rows, active and inactive.
 *
 * Inactive means sold or closed, not deleted: a sold site's claim history must
 * stay readable and its historic claims must still resolve a location, so the
 * flag is carried rather than filtered here.
 *
 * Fail-soft — on a read error we log and fall back to the last good cache, or
 * an empty list. The overwhelming majority of claims are at pricing_simple
 * locations, and degrading to "the overlay locations are missing" beats 500ing
 * every damage queue in the company because one Supabase read blipped.
 */
export async function loadOverlay(env: OverlayEnv): Promise<OverlayLocation[]> {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.rows;

  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) return cache?.rows ?? [];

  try {
    const url = new URL("/rest/v1/locations", env.SUPABASE_URL);
    url.searchParams.set("select", "code,name,parent_code,active,site_number");
    const resp = await fetch(url.toString(), {
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        // Non-public schema — PostgREST needs this to look anywhere but public.
        "Accept-Profile": "inventory"
      }
    });
    if (!resp.ok) {
      console.error(
        "[damage.overlay] load failed",
        resp.status,
        (await resp.text().catch(() => "")).slice(0, 200)
      );
      return cache?.rows ?? [];
    }
    const rows = ((await resp.json()) as OverlayLocation[]) ?? [];
    cache = { rows, at: now };
    return rows;
  } catch (err) {
    console.error("[damage.overlay] load threw:", err);
    return cache?.rows ?? [];
  }
}

/**
 * Granted codes plus every overlay child of a granted code, lower-cased.
 *
 * Additive only, matching the platform rule that a grant never removes scope.
 * Expansion is ONE level by design — a parent_code is never another overlay
 * code, and this does not follow chains.
 *
 * An empty input stays empty: a gm/rm with no locations sees nothing, and must
 * not be handed the overlay as a consolation prize.
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
      out.add((row.code ?? "").trim().toLowerCase());
    }
  }
  return [...out].filter(Boolean);
}
