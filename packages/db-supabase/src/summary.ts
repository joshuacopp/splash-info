// Brief 65 (2026-05-07) — daily open-claims summary helpers.
//
// Two read-only helpers used by damage-worker's `scheduled` handler to build
// per-recipient digests of open damage claims:
//
//   - listSummaryRecipients: pulls every gm / rm / admin / super_admin out of
//     auth_unified for the cron's recipient list.
//   - fetchLocationRoster:   pulls per-location RD/RM contact info out of
//     pricing_simple, returned as a Map keyed by location_code so the
//     scheduled handler's grouping loop is O(1) per claim.
//
// Both helpers are fail-soft: any thrown error returns an empty result and
// logs to console so the cron still completes (vs aborting the whole
// batch). The auth-context view shape is verified in
// `packages/db-supabase/src/auth-context.ts` — `auth_unified` exposes
// (user_id, email, role, locations, must_change_password, tools, dc_role,
// dc_locations). It does NOT currently expose a `name` column; the brief
// noted "first/last name when auth.users carries it; null otherwise", and
// since the view doesn't surface it, every recipient gets `name: null`
// today. PA can fall back to the email's local-part for greeting purposes,
// or the operator can later extend the view to expose
// `auth.users.raw_user_meta_data->>'full_name'` (or similar) and the
// helper's interface stays compatible because `name` is already nullable.

import type { DamageRole } from "@splash/types/claims";

/** Subset of dc_role values that receive the daily summary email. */
export type DcRoleForSummary = DamageRole;

export interface SummaryRecipient {
  user_id: string;
  email: string;
  /** First/last name when auth.users carries it. Null today — see file
   *  docblock for why. */
  name: string | null;
  dc_role: DcRoleForSummary;
  /** [] for admin / super_admin (those roles bypass scoping by design). */
  dc_locations: string[];
}

/**
 * List every gm / rm / admin / super_admin for the daily-summary cron.
 *
 * Reads `auth_unified` directly via PostgREST (matches the rest of this
 * package; no supabase-js dependency). Filters server-side on `dc_role` so
 * users with no DC role at all are skipped before the wire transfer.
 *
 * Ordering: dc_role asc, email asc — stable order so cron logs are
 * grep-able across days.
 *
 * Fail-soft: any thrown error / non-2xx response returns [] and logs.
 */
export async function listSummaryRecipients(env: {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
}): Promise<SummaryRecipient[]> {
  const url = new URL("/rest/v1/auth_unified", env.SUPABASE_URL);
  url.searchParams.set("select", "user_id,email,dc_role,dc_locations");
  // PostgREST `in.(...)` filter; values are CHECK-constrained on the view.
  url.searchParams.set("dc_role", "in.(gm,rm,admin,super_admin)");
  url.searchParams.set("order", "dc_role.asc,email.asc");
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
    console.error("listSummaryRecipients: fetch threw", err);
    return [];
  }
  if (!response.ok) {
    console.error("listSummaryRecipients: returned", response.status);
    return [];
  }

  const rows = (await response.json().catch(() => [])) as Array<{
    user_id: string | null;
    email: string | null;
    dc_role: DcRoleForSummary | null;
    dc_locations: string[] | null;
  }>;

  const recipients: SummaryRecipient[] = [];
  for (const row of rows) {
    if (!row.user_id || !row.email || !row.dc_role) continue;
    recipients.push({
      user_id: row.user_id,
      email: row.email,
      name: null,
      dc_role: row.dc_role,
      dc_locations: row.dc_locations ?? []
    });
  }
  return recipients;
}

export interface LocationRosterEntry {
  location_code: string;
  location_pretty: string;
  /** pricing_simple.am_email — the Regional Director's email (label-vs-data
   *  divergence: the column stores the RD per the org's relabel). */
  rd_email: string | null;
  /** pricing_simple.area_manager — the Regional Director's name. */
  rd_name: string | null;
  /** pricing_simple.rm_email — the Regional Manager's email. */
  rm_email: string | null;
  /** pricing_simple.regional_manager — the Regional Manager's name. */
  rm_name: string | null;
}

/**
 * Pull the per-location RD/RM contact roster from pricing_simple, keyed by
 * location_code. Used by the scheduled handler to bucket each claim under
 * its RD → RM in one Map lookup.
 *
 * Returns an empty Map on any failure — the scheduled handler still POSTs
 * per recipient, but every claim falls into the "(unassigned)" bucket
 * (Phase 3.4 sentinel handling).
 */
export async function fetchLocationRoster(env: {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
}): Promise<Map<string, LocationRosterEntry>> {
  const url = new URL("/rest/v1/pricing_simple", env.SUPABASE_URL);
  url.searchParams.set(
    "select",
    "location_code,location_pretty,am_email,area_manager,rm_email,regional_manager"
  );
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
    console.error("fetchLocationRoster: fetch threw", err);
    return new Map();
  }
  if (!response.ok) {
    console.error("fetchLocationRoster: returned", response.status);
    return new Map();
  }

  const rows = (await response.json().catch(() => [])) as Array<{
    location_code: string | null;
    location_pretty: string | null;
    am_email: string | null;
    area_manager: string | null;
    rm_email: string | null;
    regional_manager: string | null;
  }>;

  // Multiple pricing_simple rows can share a location_code (one row per
  // package). We collapse on first-seen — the columns we read are
  // location-level (synced from `locations` by trg_sync_pricing_simple),
  // so every row for a given code carries the same values.
  const map = new Map<string, LocationRosterEntry>();
  for (const row of rows) {
    const code = typeof row.location_code === "string" ? row.location_code.trim() : "";
    if (!code) continue;
    if (map.has(code)) continue;
    const trimOrNull = (v: string | null): string | null => {
      if (typeof v !== "string") return null;
      const t = v.trim();
      return t.length > 0 ? t : null;
    };
    map.set(code, {
      location_code: code,
      location_pretty: trimOrNull(row.location_pretty) ?? code,
      rd_email: trimOrNull(row.am_email),
      rd_name: trimOrNull(row.area_manager),
      rm_email: trimOrNull(row.rm_email),
      rm_name: trimOrNull(row.regional_manager)
    });
  }
  return map;
}
