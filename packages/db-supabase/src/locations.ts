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
 * `site` text). We resolve the slug → `pricing_simple.site` (which is the
 * denormalized site_number text — e.g., "147" — populated by the
 * trg_sync_pricing_simple trigger from locations.site_number::text), then
 * look up `locations.maintainx_id` by `site_number=eq.<that value>`.
 *
 * The earlier (broken) version of this helper queried
 * `locations.site=eq.<value>` which mismatches because `locations.site` is
 * the location name (e.g., "Oswego") not the site_number — Brief 62 fixed
 * the join key after operator confirmed every WO created since Brief 42
 * shipped without a locationId. See Brief 49 for the parallel
 * `getLocationContactInfo` fix that hit the same data-shape mismatch.
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

  // Step 2 — locations.site_number → maintainx_id (integer or null).
  // Brief 62: the join key is `site_number` (the actual integer business key,
  // surfaced as text in pricing_simple.site by trg_sync_pricing_simple), NOT
  // `locations.site` (the location name like "Oswego"). The earlier version
  // joined on `site` and silently returned null for every slug.
  const locUrl = new URL("/rest/v1/locations", env.SUPABASE_URL);
  locUrl.searchParams.set("site_number", `eq.${site}`);
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

/**
 * Brief 48 / 49 — resolve `site_email` (string or null) for a customer URL
 * slug. Used by damage-worker to populate the `site_email` field on the
 * `CUSTOMER_CLAIM_WEBHOOK_URL` payload so Power Automate can wire customer
 * confirmation-email replies to the per-location inbox via a Reply-To header.
 *
 * Single-query lookup against `pricing_simple.site_email`. The value is
 * trigger-synced from `locations.site_email` by `trg_sync_pricing_simple`
 * (one-direction: locations → pricing_simple), so the read is eventually
 * consistent with the locations row. Brief 26's package update endpoint
 * REJECTS direct PATCHes to `pricing_simple.site_email` with HTTP 400
 * specifically because of this trigger — direct edits would be silently
 * reverted on the next locations-side update, so pricing_simple's value
 * is always the locations-sourced value.
 *
 * Fail-soft: returns null on bad-shape slug, missing pricing_simple row,
 * missing/null `site_email`, fetch throw, or any non-2xx response. Caller
 * (damage-worker) emits `site_email: null` in the webhook payload on null;
 * PA gracefully no-ops the Reply-To header for those locations.
 */
export async function getLocationContactInfo(
  env: { SUPABASE_URL: string; SUPABASE_SERVICE_KEY: string },
  locationCode: string
): Promise<{ site_email: string | null }> {
  // Brief 49 — single-query against pricing_simple.site_email; the prior
  // two-step join through locations.site was broken (pricing_simple.site
  // didn't match locations.site for at least the Oswego location). The
  // trg_sync_pricing_simple trigger keeps pricing_simple.site_email
  // eventually consistent with the locations row, so this is equivalent.
  const sanitized = locationCode.trim().toLowerCase();
  if (!sanitized || !/^[a-z0-9_]+$/.test(sanitized)) {
    return { site_email: null };
  }

  const headers = {
    apikey: env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
  };

  const url = new URL("/rest/v1/pricing_simple", env.SUPABASE_URL);
  url.searchParams.set("location_code", `eq.${sanitized}`);
  url.searchParams.set("select", "site_email");
  url.searchParams.set("limit", "1");

  let response: Response;
  try {
    response = await fetch(url.toString(), { headers });
  } catch (err) {
    console.error("getLocationContactInfo: pricing_simple fetch threw", err);
    return { site_email: null };
  }
  if (!response.ok) {
    console.error(
      "getLocationContactInfo: pricing_simple returned",
      response.status
    );
    return { site_email: null };
  }

  const rows = (await response.json().catch(() => [])) as Array<{
    site_email: string | null;
  }>;
  const raw = rows[0]?.site_email;
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  return { site_email: trimmed ? trimmed : null };
}

/**
 * Brief 59 — single entry on the AM/RM contact roster used by damage-worker
 * to power the Regional Director / Regional Manager filters and the
 * Reporting tab.
 *
 * Label-vs-data divergence (per CLAUDE.md): the org's `area_manager` field
 * stores the Regional Director's name; `regional_manager` stores the
 * Regional Manager's name. Field names stay; UI labels become
 * "Regional Director" / "Regional Manager".
 */
export interface ContactRosterEntry {
  email: string;
  name: string;
  location_codes: string[];
}

/**
 * Brief 59 — list distinct AM/RM emails (with display name + assigned
 * location_codes) from `pricing_simple`. Used by damage-worker's
 * `/manage/api/contact-roster` endpoint.
 *
 * Reads pricing_simple (single source of truth post-Brief 33; the
 * `trg_sync_pricing_simple` trigger keeps it eventually consistent with
 * the locations row).
 *
 * Grouping: by canonical email. If two rows share the same email but
 * different names (rare data-hygiene case), pick the most-common name;
 * ties broken lexicographically.
 *
 * Fail-soft: any thrown error returns `[]` so the caller's filter UI
 * degrades to "(any)" rather than 5xxing.
 */
export async function listContactRoster(
  env: { SUPABASE_URL: string; SUPABASE_SERVICE_KEY: string },
  role: "regional_director" | "regional_manager"
): Promise<ContactRosterEntry[]> {
  const emailField = role === "regional_director" ? "am_email" : "rm_email";
  const nameField = role === "regional_director" ? "area_manager" : "regional_manager";

  const url = new URL("/rest/v1/pricing_simple", env.SUPABASE_URL);
  url.searchParams.set(
    "select",
    "location_code,am_email,area_manager,rm_email,regional_manager"
  );
  url.searchParams.set(emailField, "not.is.null");
  url.searchParams.set("order", `${nameField}.asc`);
  url.searchParams.set("limit", "1000");

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
      }
    });
  } catch (err) {
    console.error("listContactRoster: fetch threw", err);
    return [];
  }
  if (!response.ok) {
    console.error("listContactRoster: returned", response.status);
    return [];
  }
  const rows = (await response.json().catch(() => [])) as Array<{
    location_code: string | null;
    am_email: string | null;
    area_manager: string | null;
    rm_email: string | null;
    regional_manager: string | null;
  }>;

  // Group: email → { nameCounts, location_codes }.
  const groups = new Map<
    string,
    { nameCounts: Map<string, number>; codes: Set<string> }
  >();
  for (const row of rows) {
    const rawEmail = role === "regional_director" ? row.am_email : row.rm_email;
    const email = typeof rawEmail === "string" ? rawEmail.trim().toLowerCase() : "";
    if (!email) continue;
    const code = typeof row.location_code === "string" ? row.location_code.trim() : "";
    if (!code) continue;
    const rawName = role === "regional_director" ? row.area_manager : row.regional_manager;
    const name = typeof rawName === "string" ? rawName.trim() : "";

    let bucket = groups.get(email);
    if (!bucket) {
      bucket = { nameCounts: new Map(), codes: new Set() };
      groups.set(email, bucket);
    }
    bucket.codes.add(code);
    if (name) {
      bucket.nameCounts.set(name, (bucket.nameCounts.get(name) ?? 0) + 1);
    }
  }

  const entries: ContactRosterEntry[] = [];
  for (const [email, bucket] of groups.entries()) {
    let chosenName = "";
    let chosenCount = -1;
    for (const [n, c] of bucket.nameCounts.entries()) {
      if (c > chosenCount || (c === chosenCount && n.localeCompare(chosenName) < 0)) {
        chosenName = n;
        chosenCount = c;
      }
    }
    entries.push({
      email,
      name: chosenName || email,
      location_codes: [...bucket.codes].sort()
    });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
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
