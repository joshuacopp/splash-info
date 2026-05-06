// Supabase locations queries. Used by performance-worker (search),
// damage-worker (auth scope: which site_numbers does this user manage,
// plus customer-claim-form slug resolution per Brief 33), and the
// sysadmin-worker locations editor.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { SupabaseLocationRow } from "@splash/types/locations";

/**
 * Customer-URL slug resolution result. Returned by `getActiveLocationByCode`.
 *
 * Brief 33 replaced the legacy D1-backed helper of the same name. The Supabase
 * source-of-truth for "which location_codes are valid customer URLs" is the
 * `pricing_simple` table — a row exists iff the location has been provisioned
 * with at least one package, which is the equivalent of the old D1 `is_active`
 * gate. `pricing_simple.location_code` matches the URL shape exactly.
 */
export interface ResolvedLocation {
  location_code: string;
  location_pretty: string;
}

/**
 * Resolve `(location_code, location_pretty)` for a customer URL slug, querying
 * Supabase `pricing_simple` directly via REST + service-role key. Returns null
 * when the slug doesn't match any provisioned location, when the slug fails
 * the `[a-z0-9_]+` regex, or when Supabase returns a non-2xx.
 *
 * Same env shape as the rest of `@splash/db-supabase`: callers pass the
 * worker `env` (which extends SupabaseEnv) and we read `SUPABASE_URL` +
 * `SUPABASE_SERVICE_KEY` off it.
 *
 * Brief 33: this helper replaces the legacy D1 `getActiveLocationByCode`
 * (deleted from `@splash/db-d1`).
 */
export async function getActiveLocationByCode(
  env: { SUPABASE_URL: string; SUPABASE_SERVICE_KEY: string },
  locationCode: string
): Promise<ResolvedLocation | null> {
  const sanitized = locationCode.trim().toLowerCase();
  if (!sanitized || !/^[a-z0-9_]+$/.test(sanitized)) return null;

  const url = new URL("/rest/v1/pricing_simple", env.SUPABASE_URL);
  url.searchParams.set("location_code", `eq.${sanitized}`);
  url.searchParams.set("select", "location_code,location_pretty");
  url.searchParams.set("limit", "1");

  const response = await fetch(url.toString(), {
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
    }
  });
  if (!response.ok) {
    console.error(
      "getActiveLocationByCode: Supabase returned",
      response.status
    );
    return null;
  }
  const rows = (await response.json()) as ResolvedLocation[];
  return rows[0] ?? null;
}

/**
 * Brief 42 — resolve `locations.maintainx_id` (integer) for a customer URL
 * slug. Used by damage-worker to populate the `locationId` field on each
 * MaintainX work order created when `equipment_related === 1` on the
 * customer claim form.
 *
 * Two-step lookup because the `locations` table doesn't carry a
 * `location_code` column (the unique business key is `site_number`; the
 * `trg_sync_pricing_simple` trigger denormalizes into `pricing_simple` by
 * `site` text). We resolve the slug → `site` via `pricing_simple` first,
 * then look up `locations.maintainx_id` by that `site`.
 *
 * Fail-soft: returns null on bad-shape slug, missing pricing_simple row,
 * missing locations row, missing/null `maintainx_id`, or any non-2xx
 * response. Caller (damage-worker) omits `locationId` from the WO body
 * when null — MaintainX accepts WOs without a location, and we'd rather
 * have a WO than fail because a location was added in Supabase but
 * didn't get its `maintainx_id` populated yet.
 */
export async function getMaintainXLocationId(
  env: { SUPABASE_URL: string; SUPABASE_SERVICE_KEY: string },
  locationCode: string
): Promise<number | null> {
  const sanitized = locationCode.trim().toLowerCase();
  if (!sanitized || !/^[a-z0-9_]+$/.test(sanitized)) return null;

  const headers = {
    apikey: env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
  };

  // Step 1 — pricing_simple.location_code → site (text).
  const psUrl = new URL("/rest/v1/pricing_simple", env.SUPABASE_URL);
  psUrl.searchParams.set("location_code", `eq.${sanitized}`);
  psUrl.searchParams.set("select", "site");
  psUrl.searchParams.set("limit", "1");
  let psResponse: Response;
  try {
    psResponse = await fetch(psUrl.toString(), { headers });
  } catch (err) {
    console.error("getMaintainXLocationId: pricing_simple fetch threw", err);
    return null;
  }
  if (!psResponse.ok) {
    console.error(
      "getMaintainXLocationId: pricing_simple returned",
      psResponse.status
    );
    return null;
  }
  const psRows = (await psResponse.json().catch(() => [])) as Array<{
    site: string | null;
  }>;
  const site = psRows[0]?.site;
  if (!site) return null;

  // Step 2 — locations.site → maintainx_id (integer or null).
  const locUrl = new URL("/rest/v1/locations", env.SUPABASE_URL);
  locUrl.searchParams.set("site", `eq.${site}`);
  locUrl.searchParams.set("select", "maintainx_id");
  locUrl.searchParams.set("limit", "1");
  let locResponse: Response;
  try {
    locResponse = await fetch(locUrl.toString(), { headers });
  } catch (err) {
    console.error("getMaintainXLocationId: locations fetch threw", err);
    return null;
  }
  if (!locResponse.ok) {
    console.error(
      "getMaintainXLocationId: locations returned",
      locResponse.status
    );
    return null;
  }
  const locRows = (await locResponse.json().catch(() => [])) as Array<{
    maintainx_id: number | null;
  }>;
  const id = locRows[0]?.maintainx_id;
  return typeof id === "number" && Number.isFinite(id) ? id : null;
}

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
