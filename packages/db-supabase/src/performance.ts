// performance_tracking queries. Mirrors legacy/performancetracker.js
// apiCreateSubmission and apiListSubmissions.

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  PerformanceTrackingInsert,
  PerformanceTrackingRow
} from "@splash/types/performance";

/**
 * Insert a performance_tracking row. Returns the inserted row.
 * Source: legacy/performancetracker.js:226 apiCreateSubmission.
 */
export async function insertPerformanceSubmission(
  client: SupabaseClient,
  row: PerformanceTrackingInsert
): Promise<PerformanceTrackingRow> {
  const { data, error } = await client
    .from("performance_tracking")
    .insert(row)
    .select()
    .single();
  if (error) throw error;
  return data as unknown as PerformanceTrackingRow;
}

export interface PerformanceListFilters {
  date_from?: string | null;
  date_to?: string | null;
  location_id?: number | null;
  gm_on_site?: boolean | null;
  agm_on_site?: boolean | null;
  greeter?: string | null;
  gm_name?: string | null;
  agm_name?: string | null;
  regional_manager?: string | null;
  area_manager?: string | null;
  rm_group?: string | null;
  fivestar?: string | null;
  limit?: number;
}

/**
 * Embedded select shape — joins the locations table via the !inner foreign-key
 * relationship so location-column filters drop parent rows whose location row
 * doesn't match. Source: legacy/performancetracker.js:274 list select.
 */
const SUBMISSIONS_SELECT =
  "id,visit_at,capture_rate,opportunities," +
  "greeter_1_name,greeter_2_name,greeter_3_name," +
  "greeter_1_shift_start,greeter_1_shift_end," +
  "greeter_2_shift_start,greeter_2_shift_end," +
  "greeter_3_shift_start,greeter_3_shift_end," +
  "gm_on_site,gm_name,agm_on_site,agm_name," +
  "comments,submitted_by_email,created_at," +
  "location:locations!inner(id,site_number,site,mla_location,location,area_manager,regional_manager,rm_group,rm_email,am_email,hrt_email,site_email,hrt1,hrt2,fivestar)";

/**
 * List submissions with filters. Mirrors apiListSubmissions exactly —
 * date range, location, GM/AGM presence, greeter/gm/agm name search,
 * embedded-locations filters (regional_manager, area_manager, rm_group, fivestar).
 *
 * Source: legacy/performancetracker.js:268.
 */
export async function listPerformanceSubmissions(
  client: SupabaseClient,
  filters: PerformanceListFilters = {}
): Promise<unknown[]> {
  let q = client
    .from("performance_tracking")
    .select(SUBMISSIONS_SELECT)
    .order("visit_at", { ascending: false })
    .limit(filters.limit ?? 200);

  if (filters.date_from) q = q.gte("visit_at", filters.date_from);
  if (filters.date_to) q = q.lte("visit_at", filters.date_to);
  if (filters.location_id != null) q = q.eq("location_id", filters.location_id);
  if (filters.gm_on_site != null) q = q.eq("gm_on_site", filters.gm_on_site);
  if (filters.agm_on_site != null) q = q.eq("agm_on_site", filters.agm_on_site);

  // Name searches across greeter columns (OR), and ilike on gm/agm names.
  if (filters.greeter && filters.greeter.trim()) {
    const g = filters.greeter.replace(/[(),]/g, "");
    q = q.or(`greeter_1_name.ilike.*${g}*,greeter_2_name.ilike.*${g}*,greeter_3_name.ilike.*${g}*`);
  }
  if (filters.gm_name && filters.gm_name.trim()) {
    q = q.ilike("gm_name", `*${filters.gm_name.replace(/[(),]/g, "")}*`);
  }
  if (filters.agm_name && filters.agm_name.trim()) {
    q = q.ilike("agm_name", `*${filters.agm_name.replace(/[(),]/g, "")}*`);
  }

  // Filters on the embedded locations resource — supabase-js exposes these
  // via dotted column names on `.eq` / `.ilike`.
  if (filters.regional_manager && filters.regional_manager.trim()) {
    const rm = filters.regional_manager.replace(/[(),]/g, "");
    q = q.ilike("locations.regional_manager", `*${rm}*`);
  }
  if (filters.area_manager && filters.area_manager.trim()) {
    const am = filters.area_manager.replace(/[(),]/g, "");
    q = q.ilike("locations.area_manager", `*${am}*`);
  }
  if (filters.rm_group) q = q.eq("locations.rm_group", filters.rm_group);
  if (filters.fivestar) q = q.eq("locations.fivestar", filters.fivestar);

  const { data, error } = await q;
  if (error) throw error;
  return data ?? [];
}
