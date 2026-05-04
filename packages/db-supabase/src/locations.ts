// Supabase locations queries. Used by performance-worker (search) and
// damage-worker (auth scope: which site_numbers does this user manage).

import type { SupabaseClient } from "@supabase/supabase-js";
import type { SupabaseLocationRow } from "@splash/types/locations";

const LOCATION_COLS =
  "id,site_number,site,location,mla_location,area_manager,regional_manager,rm_group,rm_email,am_email,hrt_email,site_email,hrt1,hrt2,fivestar";

/**
 * Search locations by site_number / site / mla_location / location text.
 * Source: legacy/performancetracker.js:189 apiLocations.
 */
export async function searchLocations(
  client: SupabaseClient,
  query: string,
  limit = 20
): Promise<SupabaseLocationRow[]> {
  let q = client.from("locations").select(LOCATION_COLS).order("site_number", { ascending: true }).limit(limit);

  const needle = (query ?? "").trim().replace(/[(),*]/g, "");
  if (needle) {
    const clauses: string[] = [];
    if (/^\d+$/.test(needle)) {
      clauses.push(`site_number.eq.${needle}`);
    }
    clauses.push(`site.ilike.*${needle}*`);
    clauses.push(`mla_location.ilike.*${needle}*`);
    clauses.push(`location.ilike.*${needle}*`);
    q = q.or(clauses.join(","));
  }

  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as unknown as SupabaseLocationRow[];
}

/**
 * Site numbers a user manages (via site_email / am_email / rm_email).
 * Used by damage-worker:3084 to scope D1 location lookups.
 */
export async function getSiteNumbersForUser(
  client: SupabaseClient,
  email: string
): Promise<number[]> {
  const e = email.toLowerCase();
  const { data, error } = await client
    .from("locations")
    .select("site_number")
    .or(`site_email.eq.${e},am_email.eq.${e},rm_email.eq.${e}`);
  if (error) throw error;
  const rows = (data ?? []) as unknown as Array<{ site_number: number | null }>;
  return [...new Set(rows.map((r) => r.site_number).filter((n): n is number => n != null))];
}
