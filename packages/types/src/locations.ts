// Location row types — Supabase and D1 schemas DIFFER.
// Both are real tables; the migration plan §1 (Data layer split) is explicit.

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

/**
 * Row shape of the D1 `locations` table.
 *
 * Source:
 *   - legacy/damagemanager.js:358 SELECT location_pretty FROM locations WHERE location_code = ? AND is_active = 1
 *   - legacy/damagemanager.js:3071 SELECT location_code, location_pretty, site_number FROM locations WHERE is_active = 1
 *
 * D1 stores booleans as integer 0/1 — `is_active` is 1 for active, 0 for inactive.
 *
 * The plan calls out (Data layer split table): locations columns are
 * `is_active`, `site_number`, `location_pretty`, `location_code` — matches
 * the legacy queries exactly.
 */
export interface D1LocationRow {
  location_code: string;
  location_pretty: string;
  /** Stringified or numeric — D1 SQLite is dynamically typed; legacy treats as scalar. */
  site_number: string | number;
  is_active: 0 | 1;
}
