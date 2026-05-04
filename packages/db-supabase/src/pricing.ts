// Pricing reads + writes. Mirrors legacy/signupworker.js:
//   listPackages, fetchOne   → fetchPricingResolved (caller filters/caches)
//   fetchAllLocationPkgs     → listLocationPkgs
//   listDistinctLocations    → listDistinctLocations
//   getCurrentMode           → getPricingMode
//   setMode                  → setPricingMode
//
// The 5min/24h cache layer that wraps fetchPricingResolved lives in the
// signup-worker (it uses caches.default + Cache API and is worker-specific).

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  PricingSimpleRow,
  PricingSimpleResolvedRow,
  PricingMode
} from "@splash/types/pricing";

/* ============================================================
 * Reads
 * ============================================================ */

const RESOLVED_COLS = "location_pretty,location_code,pkg,pretty_pkg,today,ongoing,sort";

/**
 * Read the entire `pricing_simple_resolved` view. Roughly 70 locations × N
 * packages worth of rows. The signup-worker caches this for 5 minutes.
 *
 * Source: legacy/signupworker.js:3232 fetchAndCachePricing.
 */
export async function fetchPricingResolved(
  client: SupabaseClient
): Promise<PricingSimpleResolvedRow[]> {
  const { data, error } = await client
    .from("pricing_simple_resolved")
    .select(RESOLVED_COLS);
  if (error) throw error;
  return (data ?? []) as unknown as PricingSimpleResolvedRow[];
}

/**
 * One package row from the resolved view (used by the signup form, post-cache).
 */
export async function fetchPricingResolvedOne(
  client: SupabaseClient,
  args: { locationCode: string; pkg: string }
): Promise<PricingSimpleResolvedRow | null> {
  const { data, error } = await client
    .from("pricing_simple_resolved")
    .select(RESOLVED_COLS)
    .eq("location_code", args.locationCode.toLowerCase())
    .eq("pkg", args.pkg.toLowerCase())
    .limit(1);
  if (error) throw error;
  const rows = (data ?? []) as unknown as PricingSimpleResolvedRow[];
  return rows[0] ?? null;
}

/**
 * All resolved-view rows for a single location, ordered by `sort` for the
 * package-picker UI. Single subrequest — used by the signup-worker's per-
 * location pricing cache (5 min fresh, 24 h SWR).
 *
 * Returns rows with `pricing` non-null (only show packages with active
 * pricing — matches legacy/signupworker.js listPackages filter intent).
 */
export async function fetchPricingResolvedByLocation(
  client: SupabaseClient,
  locationCode: string
): Promise<PricingSimpleResolvedRow[]> {
  const { data, error } = await client
    .from("pricing_simple_resolved")
    .select(RESOLVED_COLS)
    .eq("location_code", locationCode.toLowerCase())
    .order("sort", { ascending: true });
  if (error) throw error;
  return (data ?? []) as unknown as PricingSimpleResolvedRow[];
}

/**
 * All `pricing_simple` rows across a list of location codes (admin grid).
 * Source: legacy/signupworker.js:3075 fetchAllLocationPkgs.
 */
export async function listLocationPkgs(
  client: SupabaseClient,
  locationCodes: string[]
): Promise<PricingSimpleRow[]> {
  if (locationCodes.length === 0) return [];
  const { data, error } = await client
    .from("pricing_simple")
    .select("location_code,location_pretty,pkg,pricing,special,site_email,am_email,rm_email,updated_at")
    .in("location_code", locationCodes)
    .order("location_pretty", { ascending: true })
    .order("pkg", { ascending: true });
  if (error) throw error;
  return (data ?? []) as unknown as PricingSimpleRow[];
}

/**
 * Distinct locations (super_admin all-locations view).
 * Source: legacy/signupworker.js:3102 listDistinctLocations.
 */
export async function listDistinctLocations(
  client: SupabaseClient
): Promise<{ location_code: string; location_pretty: string; pricing: string }[]> {
  const { data, error } = await client
    .from("pricing_simple")
    .select("location_code,location_pretty,pricing")
    .order("location_pretty", { ascending: true });
  if (error) throw error;
  const rows = (data ?? []) as unknown as Array<{
    location_code: string | null;
    location_pretty: string | null;
    pricing: string | null;
  }>;

  const seen = new Map<string, { location_code: string; location_pretty: string; pricing: string }>();
  for (const row of rows) {
    const code = (row.location_code ?? "").toLowerCase();
    if (code && !seen.has(code)) {
      seen.set(code, {
        location_code: code,
        location_pretty: row.location_pretty ?? code,
        pricing: row.pricing ?? ""
      });
    }
  }
  return Array.from(seen.values());
}

/**
 * Locations a non-super-admin user can manage, matched by email on
 * site_email / am_email / rm_email (any one).
 *
 * Source: legacy/signupworker.js:768 location-by-email lookup.
 */
export async function listLocationsForUser(
  client: SupabaseClient,
  email: string
): Promise<{ location_code: string; location_pretty: string; pricing: string }[]> {
  const e = email.toLowerCase();
  // Note: PostgREST OR-filter values are not URL-encoded by supabase-js
  // when interpolated into the OR string. Email values containing commas
  // would break the filter — emails legally cannot contain "," outside
  // exotic quoted local parts, so we accept the risk and match legacy.
  const { data, error } = await client
    .from("pricing_simple")
    .select("location_code,location_pretty,pricing")
    .or(`site_email.eq.${e},am_email.eq.${e},rm_email.eq.${e}`);
  if (error) throw error;
  const rows = (data ?? []) as unknown as Array<{
    location_code: string | null;
    location_pretty: string | null;
    pricing: string | null;
  }>;

  const seen = new Map<string, { location_code: string; location_pretty: string; pricing: string }>();
  for (const row of rows) {
    const code = (row.location_code ?? "").toLowerCase();
    if (code && !seen.has(code)) {
      seen.set(code, {
        location_code: code,
        location_pretty: row.location_pretty ?? code,
        pricing: row.pricing ?? ""
      });
    }
  }
  return Array.from(seen.values());
}

/**
 * Current pricing mode for a single location (returns the first row's
 * `pricing` value). Source: legacy/signupworker.js:3129 getCurrentMode.
 */
export async function getPricingMode(
  client: SupabaseClient,
  locationCode: string
): Promise<string | null> {
  const { data, error } = await client
    .from("pricing_simple")
    .select("pricing")
    .eq("location_code", locationCode)
    .limit(1);
  if (error) throw error;
  const rows = (data ?? []) as unknown as Array<{ pricing: string | null }>;
  return rows[0]?.pricing ?? null;
}

/* ============================================================
 * Writes
 * ============================================================ */

/**
 * Update pricing mode (and optionally the special-price column) on the
 * pricing_simple rows for a location. If `pkgList` is provided, only those
 * package rows are updated; otherwise all packages at the location.
 *
 * Source: legacy/signupworker.js:3145 setMode.
 *
 * NOTE: cache invalidation (caches.default.delete) is the caller's job —
 * it's worker-specific, not part of the data layer.
 */
export async function setPricingMode(
  client: SupabaseClient,
  args: {
    locationCode: string;
    mode: PricingMode;
    pkgList?: readonly string[] | null;
    specialPrice?: number | null;
  }
): Promise<boolean> {
  const updateBody: { pricing: PricingMode; updated_at: string; special?: number } = {
    pricing: args.mode,
    updated_at: new Date().toISOString()
  };
  if (args.mode === "special" && args.specialPrice != null) {
    updateBody.special = args.specialPrice;
  }

  let q = client
    .from("pricing_simple")
    .update(updateBody)
    .eq("location_code", args.locationCode);

  if (args.pkgList && args.pkgList.length > 0) {
    q = q.in("pkg", args.pkgList as string[]);
  }

  const { error } = await q;
  if (error) {
    console.error("setPricingMode failed:", error);
    return false;
  }
  return true;
}
