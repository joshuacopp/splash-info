// D1 locations queries. Source: legacy/damagemanager.js.
//
// The D1 locations table is parallel to (and named the same as) the Supabase
// locations table — but with a different, narrower schema. See
// @splash/types/locations for the column split.

import type { D1LocationRow } from "@splash/types/locations";

/**
 * Resolve location_pretty for a code, only if active.
 * Returns null when the code is unknown or the row is inactive.
 *
 * Source: legacy/damagemanager.js:357.
 */
export async function getActiveLocationByCode(
  db: D1Database,
  locationCode: string
): Promise<Pick<D1LocationRow, "location_code" | "location_pretty"> | null> {
  const row = await db
    .prepare("SELECT location_pretty FROM locations WHERE location_code = ? AND is_active = 1")
    .bind(locationCode.toLowerCase())
    .first<{ location_pretty: string }>();
  if (!row) return null;
  return { location_code: locationCode.toLowerCase(), location_pretty: row.location_pretty };
}

/**
 * All active locations, sorted by location_pretty.
 * Source: legacy/damagemanager.js:3071 (admin path — all locations).
 */
export async function listActiveLocations(
  db: D1Database
): Promise<Array<Pick<D1LocationRow, "location_code" | "location_pretty" | "site_number">>> {
  const result = await db
    .prepare(
      "SELECT location_code, location_pretty, site_number FROM locations WHERE is_active = 1 ORDER BY location_pretty ASC"
    )
    .all<Pick<D1LocationRow, "location_code" | "location_pretty" | "site_number">>();
  return result.results ?? [];
}

/**
 * Active locations matching a list of site_numbers (used to scope a non-admin
 * user's claims view).
 * Source: legacy/damagemanager.js:3100.
 */
export async function listActiveLocationsBySiteNumbers(
  db: D1Database,
  siteNumbers: ReadonlyArray<string | number>
): Promise<Array<Pick<D1LocationRow, "location_code" | "location_pretty" | "site_number">>> {
  if (siteNumbers.length === 0) return [];
  const placeholders = siteNumbers.map(() => "?").join(",");
  const result = await db
    .prepare(
      `SELECT location_code, location_pretty, site_number FROM locations WHERE site_number IN (${placeholders}) AND is_active = 1 ORDER BY location_pretty ASC`
    )
    .bind(...siteNumbers)
    .all<Pick<D1LocationRow, "location_code" | "location_pretty" | "site_number">>();
  return result.results ?? [];
}
