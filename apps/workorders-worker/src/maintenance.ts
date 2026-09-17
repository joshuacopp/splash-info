/**
 * Maintenance tracker read surface — GET /workorders/api/maintenance/summary
 *
 * WHY THIS LIVES ON workorders-worker AND NOT A NEW WORKER
 *   CLAUDE.md: future MaintainX surfaces pick one of the two workers already
 *   holding MAINTAINX_API_KEY rather than spawning a third. This one also
 *   already holds SUPABASE_SERVICE_KEY and already owns the MaintainX mirror
 *   the tracker reads, so a new worker would mean a second copy of both
 *   bindings for one read endpoint.
 *
 * WHY apps/web CANNOT READ THESE VIEWS DIRECTLY
 *   apps/web has no SUPABASE_SERVICE_KEY binding (see the Brief 158a note in
 *   CLAUDE.md, where the same gap forced the promo user-lookup stub). Every
 *   Supabase read from a page goes through a worker.
 *
 * PERMISSION DOMAIN — ADMIN TIER, DELIBERATELY NOT email-on-locations
 *   The MaintainX read path next door scopes by whose email sits on a
 *   location, which is right for work orders: a GM should see their own site's
 *   jobs. It is wrong here. This surface reports where named mechanics were
 *   and how their paid hours decompose, across every site at once, and a
 *   per-location gate would hand a site manager a colleague's week. Admin tier
 *   (super_admin, or dc_role admin/super_admin) is the whole audience.
 *
 * EVERYTHING HERE IS A VIEW. No table is written and no figure is cached. The
 * numbers move as the event log accumulates and the site crosswalk improves,
 * which is intended — a snapshot would silently go stale and read as current.
 */
import type { Session } from "@splash/auth";
import { json, jsonError } from "@splash/http";

export interface MaintenanceEnv {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
}

/**
 * Admin tier. Mirrors the fleet (Brief 83) and forms (Brief 94) gates rather
 * than inventing a fourth spelling of the same idea.
 */
export function isMaintenanceViewer(session: Session): boolean {
  return (
    session.role === "super_admin" ||
    session.dcRole === "admin" ||
    session.dcRole === "super_admin"
  );
}

async function pgSelect<T>(
  env: MaintenanceEnv,
  path: string
): Promise<{ ok: true; rows: T[] } | { ok: false; error: string }> {
  try {
    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        Accept: "application/json"
      },
      signal: AbortSignal.timeout(10_000)
    });
    if (!res.ok) {
      return { ok: false, error: `${res.status} ${(await res.text()).slice(0, 200)}` };
    }
    return { ok: true, rows: (await res.json()) as T[] };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface CostCentreRow {
  month: string;
  kind: "SITE" | "MANAGEMENT" | "UNATTRIBUTED";
  site_number: number | null;
  cost_centre: string;
  onsite_h: number;
  travel_h: number;
  hours: number;
}
export interface SiteRow {
  month: string;
  site_number: number;
  onsite_h: number;
  inbound_travel_h: number;
  total_h: number;
  pct_drive_time: number | null;
}
export interface MechanicRow {
  connecteam_user_id: number;
  week_starting: string;
  punches: number;
  paid_h: number;
  onsite_h: number;
  billable_travel_h: number;
  overhead_travel_h: number;
  unaccounted_h: number;
  no_gps_h: number;
  billable_travel_pct: number | null;
  no_gps_pct: number | null;
}
export interface TierRow {
  evidence_tier: string;
  rows: number;
  logged_hours: number;
}
export interface DeviceHealthRow {
  device_id: string;
  display_name: string;
  connecteam_user_id: number;
  last_gps: string | null;
  last_punch: string | null;
  days_since_gps: number | null;
  gps_days_21d: number;
  punch_days_21d: number;
  device_status: "OK" | "NOT_WORKING" | "TRANSPONDER_SILENT" | "TRANSPONDER_PATCHY";
}
export interface SiteWorkOrderRow {
  month: string;
  site_number: number;
  id: number;
  sequential_id: number | null;
  title: string | null;
  priority: string | null;
  status: string | null;
  completed_at: string;
  labor_h: number | null;
  total_cost_cents: number | null;
  completer_id: number | null;
  completed_by: string | null;
  closer_role: string;
  expense_to: string;
  implies_site_visit: boolean;
}

export async function handleMaintenanceSummary(
  env: MaintenanceEnv,
  session: Session
): Promise<Response> {
  if (!isMaintenanceViewer(session)) {
    return jsonError(403, "maintenance tracker requires admin");
  }
  if (!env.SUPABASE_SERVICE_KEY) {
    return jsonError(503, "service key unbound");
  }

  // Independent reads, issued together. They share no ordering and the page
  // needs all of them before it can render anything, so sequential would just
  // add up the latencies.
  const [costs, sites, mechanics, tiers, crew, siteNames, workOrders, devices] =
    await Promise.all([
    pgSelect<CostCentreRow>(
      env,
      "mt_cost_centre_month?select=*&order=month.desc,hours.desc"
    ),
    pgSelect<SiteRow>(env, "mt_site_month?select=*&order=month.desc,total_h.desc"),
    pgSelect<MechanicRow>(
      env,
      "mt_mechanic_week?select=*&order=week_starting.desc,paid_h.desc"
    ),
    pgSelect<{ evidence_tier: string; logged_seconds: number }>(
      env,
      "mt_work_attribution?select=evidence_tier,logged_seconds"
    ),
    // display_name is joined here rather than on the page because
    // mt_device_person is the single source of truth for who the crew are,
    // and apps/web cannot read it.
    pgSelect<{ connecteam_user_id: number; display_name: string; is_mechanic: boolean }>(
      env,
      "mt_device_person?select=connecteam_user_id,display_name,is_mechanic"
    ),
    pgSelect<{ site_number: number; site_name: string }>(
      env,
      "mt_site_name?select=site_number,site_name"
    ),
    // Scoped to the current and previous month rather than everything: the
    // page only ever renders one month, and the full history is ~1,100 rows of
    // titles that would be shipped and thrown away on every load.
    pgSelect<SiteWorkOrderRow>(
      env,
      "mt_site_work_orders?select=*&completed_at=gte." +
        firstOfPreviousMonth(new Date()) +
        "&order=completed_at.desc"
    ),
    pgSelect<DeviceHealthRow>(env, "mt_device_health?select=*&order=device_status,device_id")
  ]);

  const firstError = [
    costs, sites, mechanics, tiers, crew, siteNames, workOrders, devices
  ].find((r) => !r.ok);
  if (firstError && !firstError.ok) {
    console.error("[maintenance.summary] read failed:", firstError.error);
    return jsonError(502, "maintenance read failed");
  }
  if (
    !costs.ok || !sites.ok || !mechanics.ok || !tiers.ok || !crew.ok ||
    !siteNames.ok || !workOrders.ok || !devices.ok
  ) {
    return jsonError(502, "maintenance read failed");
  }

  // Tier counts are rolled up here rather than in a fifth view: the shape is
  // trivial and a view would be one more thing to keep in step with the tier
  // definitions in mt_work_attribution.
  const tierMap = new Map<string, { rows: number; seconds: number }>();
  for (const t of tiers.rows) {
    const cur = tierMap.get(t.evidence_tier) ?? { rows: 0, seconds: 0 };
    cur.rows += 1;
    cur.seconds += Number(t.logged_seconds ?? 0);
    tierMap.set(t.evidence_tier, cur);
  }
  const tierRows: TierRow[] = [...tierMap.entries()]
    .map(([evidence_tier, v]) => ({
      evidence_tier,
      rows: v.rows,
      logged_hours: Math.round(v.seconds / 3600)
    }))
    .sort((a, b) => b.rows - a.rows);

  const names: Record<string, string> = {};
  for (const c of crew.rows) names[String(c.connecteam_user_id)] = c.display_name;

  const siteNameMap: Record<string, string> = {};
  for (const r of siteNames.rows) siteNameMap[String(r.site_number)] = r.site_name;

  return json({
    generated_at: new Date().toISOString(),
    cost_centres: costs.rows,
    sites: sites.rows,
    mechanics: mechanics.rows,
    tiers: tierRows,
    crew_names: names,
    site_names: siteNameMap,
    work_orders: workOrders.rows,
    devices: devices.rows
  });
}

/** First day of last month, YYYY-MM-DD, for the work-order window. */
function firstOfPreviousMonth(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return d.toISOString().slice(0, 10);
}
