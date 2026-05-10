// Lookup resolver — single source of truth for resolving a Lookup field's
// value given a key. Used by both `splash-forms` (`POST /forms/api/lookup/{slug}`
// at render time, plus the submit-time re-resolve in
// `POST /forms/api/submit/{slug}`) and the admin API (`/forms/admin/api/forms/{id}`
// preview rendering).
//
// Brief 93 — real implementation. Dispatches on sourceTable:
//   - `pricing_simple` → direct SELECT WHERE keyColumn = keyValue.
//   - `locations`      → two-hop. First derive `pricing_simple.site` from
//                        pricing_simple WHERE keyColumn = keyValue. Then
//                        SELECT FROM locations WHERE site_number = <that>.
//
// The Brief 62 fix established that `locations.site_number` is the right
// join column (NOT `locations.site`, which is the location name). The
// resolver hides the two-hop from callers — they specify
// `sourceTable: 'locations'` and `keyColumn: 'pricing_simple.location_code'`,
// and the helper figures out the rest.
//
// Caching: none. `pricing_simple` / `locations` are point reads on indexed
// columns; sub-10ms latency. Adding cache invalidation complexity for the
// marginal speedup isn't worth it.

import type { LookupSource, LookupKeyColumn } from "@splash/forms-schema";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface ResolveLookupArgs {
  client: SupabaseClient;
  source: LookupSource;
  keyColumn: LookupKeyColumn;
  keyValue: string;
}

/**
 * Resolve a lookup field's value given a key. Returns:
 *   - string representation of the column value
 *   - null if no row matches OR the matched row's column value is null
 *   - null + log on Supabase error / unknown source table
 */
export async function resolveLookup(args: ResolveLookupArgs): Promise<string | null> {
  const { client, source, keyColumn, keyValue } = args;

  if (!keyValue || keyValue.trim() === "") return null;

  const keyColumnName = keyColumn.split(".")[1]; // "location_code" or "site"
  if (!keyColumnName) {
    console.error("[forms.lookup] malformed keyColumn", { keyColumn });
    return null;
  }

  if (source.table === "pricing_simple") {
    // Direct: SELECT {column} FROM pricing_simple WHERE {keyColumn} = keyValue.
    // limit=1 because pricing_simple has multiple rows per location_code (one
    // per package); the denormalized columns (am_email, area_manager, …) are
    // identical across them.
    const { data, error } = await client
      .from("pricing_simple")
      .select(source.column)
      .eq(keyColumnName, keyValue)
      .limit(1)
      .maybeSingle();
    if (error) {
      console.error("[forms.lookup] pricing_simple resolve error", {
        source,
        keyColumn,
        keyValue,
        error
      });
      return null;
    }
    if (!data) return null;
    const value = (data as unknown as Record<string, unknown>)[source.column];
    return value == null ? null : String(value);
  }

  if (source.table === "locations") {
    // Two-hop: derive `pricing_simple.site` from pricing_simple
    // WHERE keyColumn = keyValue, then SELECT FROM locations
    // WHERE site_number = <that>.
    let siteNumber: string | null;

    if (keyColumnName === "site") {
      // Already a site number; skip the first hop.
      siteNumber = keyValue;
    } else {
      // keyColumnName === "location_code" — first hop.
      const { data: psData, error: psErr } = await client
        .from("pricing_simple")
        .select("site")
        .eq("location_code", keyValue)
        .limit(1)
        .maybeSingle();
      if (psErr) {
        console.error("[forms.lookup] pricing_simple first-hop error", {
          keyValue,
          error: psErr
        });
        return null;
      }
      if (!psData) return null;
      siteNumber = (psData as { site: string | null }).site ?? null;
      if (!siteNumber) return null;
    }

    // Second hop.
    const { data, error } = await client
      .from("locations")
      .select(source.column)
      .eq("site_number", siteNumber)
      .limit(1)
      .maybeSingle();
    if (error) {
      console.error("[forms.lookup] locations second-hop error", {
        siteNumber,
        source,
        error
      });
      return null;
    }
    if (!data) return null;
    const value = (data as unknown as Record<string, unknown>)[source.column];
    return value == null ? null : String(value);
  }

  // Unreachable — sourceTable is a union of two literal strings, but a
  // hand-edited form_versions.schema could land here.
  console.warn("[forms.lookup] unknown source table", source);
  return null;
}
