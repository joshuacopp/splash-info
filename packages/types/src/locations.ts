// Supabase `locations` row type. Brief 33 retired the parallel D1 `locations`
// table; slug-to-location_pretty resolution now hits Supabase pricing_simple
// (see `@splash/db-supabase` `getActiveLocationByCode`).

/**
 * Row shape of the Supabase `locations` table.
 * Source: legacy/performancetracker.js:194 apiLocations select.
 *
 *     "id,site_number,site,location,mla_location,area_manager,
 *      regional_manager,rm_group,rm_email,am_email,hrt_email,
 *      site_email,hrt1,hrt2,fivestar"
 *
 * Used by:
 *   - performancetracker.js for location search (apiLocations)
 *   - damagemanager.js:3084 for site_number lookup by user email (auth scope)
 */
export interface SupabaseLocationRow {
  id: number;
  site_number: number;
  site: string | null;
  location: string | null;
  mla_location: string | null;
  area_manager: string | null;
  regional_manager: string | null;
  rm_group: string | null;
  rm_email: string | null;
  am_email: string | null;
  hrt_email: string | null;
  site_email: string | null;
  hrt1: string | null;
  hrt2: string | null;
  fivestar: string | null;
}
