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

/** One row of mt_cost_day: a (day, kind, site) bucket on the punch basis. */
export interface CostDayRow {
  work_date: string;
  kind: "SITE" | "CAPX" | "MANAGEMENT" | "PTO" | "UNASSIGNED";
  site_number: number | null;
  /** BILLED. What the punch claimed -- the cost basis since 2026-09-18. */
  punched_h: number;
  /** CORROBORATION. Vehicle inside the CLAIMED site's fence during the punch.
   *  Never the basis for a charge; expected to be well below punched_h. */
  gps_onsite_h: number;
  punches: number;
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
  /** Joined on id, never on name: the two systems disagree
   *  ("Charles Zimmer" here, "Chuck Zimmer" in MaintainX). */
  maintainx_user_id: number | null;
}
export interface WorkloadRow {
  connecteam_user_id: number;
  display_name: string;
  open_assigned: number;
  open_in_progress: number;
  open_on_hold: number;
  open_over_30d: number;
  closed_7d: number;
  closed_30d: number;
  median_days_to_close: number | null;
  mean_days_to_close: number | null;
}
export interface MechanicDayRow {
  work_date: string;
  connecteam_user_id: number;
  display_name: string;
  job_title: string | null;
  work_kind: "SITE" | "CAPX" | "OVERHEAD" | "PTO";
  claimed_site: number | null;
  claimed_site_name: string | null;
  /**
   * CODE    = the Connecteam job's own cost code. Independent of GPS.
   * DERIVED = mt_connecteam_job_site, which is itself derived FROM GPS, so
   *           "was the truck at the claimed site" is partly circular here.
   * Surface this in the UI; never let a DERIVED row read as independent
   * evidence of compliance.
   */
  site_source: "CODE" | "DERIVED" | "UNKNOWN" | null;
  derived_confidence: string | null;
  punch_h: number;
  at_claimed_site_h: number;
  at_other_site_h: number;
  stopped_offsite_h: number;
  moving_or_no_gps_h: number;
  other_sites: string | null;
  wo_closed_at_claimed_site: number;
  wo_closed_elsewhere: number;
  wo_titles: string | null;
  evidence_flag: string;
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

/**
 * Reporting periods.
 *
 * Resolved on the WORKER, not the page, so every caller gets the same
 * boundaries and a bookmarked `?period=` means the same thing tomorrow as
 * today. `from` is inclusive, `to` is exclusive.
 *
 * All arithmetic is on the EASTERN calendar day. Every tracked mechanic is in
 * that zone and mt_cost_day buckets on their local day; resolving the range in
 * UTC would put "this week" a few hours out of step with the rows it filters,
 * which is invisible until a Sunday evening shift lands in the wrong week.
 */
export const MAINTENANCE_PERIODS = [
  "this_week",
  "last_week",
  "current_month",
  "past_30",
  "qtd",
  "last_quarter",
  "ytd"
] as const;
export type MaintenancePeriod = (typeof MAINTENANCE_PERIODS)[number];

const PERIOD_LABEL: Record<MaintenancePeriod, string> = {
  this_week: "This week",
  last_week: "Last week",
  current_month: "Current month",
  past_30: "Past 30 days",
  qtd: "Quarter to date",
  last_quarter: "Last quarter",
  ytd: "Year to date"
};

/** Today in America/New_York as [y, m, d], independent of the worker's clock. */
function easternToday(now: Date): [number, number, number] {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(now);
  // Indexed access is checked in this project, so parse explicitly rather
  // than destructuring a possibly-short array.
  const bits = parts.split("-");
  return [Number(bits[0]), Number(bits[1]), Number(bits[2])];
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
/** Plain calendar arithmetic on a UTC-midnight Date standing for an ET day. */
const day = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));
const addDays = (d: Date, n: number) =>
  new Date(d.getTime() + n * 86_400_000);

export function resolvePeriod(
  raw: string | null,
  now: Date = new Date()
): { id: MaintenancePeriod; label: string; from: string; to: string } {
  const id = (MAINTENANCE_PERIODS as readonly string[]).includes(raw ?? "")
    ? (raw as MaintenancePeriod)
    : "current_month";
  const [y, m, d] = easternToday(now);
  const today = day(y, m, d);
  const tomorrow = addDays(today, 1);
  // Weeks run Monday-Sunday. getUTCDay() is 0 for Sunday, so Sunday maps to 6.
  const dow = (today.getUTCDay() + 6) % 7;
  const monday = addDays(today, -dow);
  const q = Math.floor((m - 1) / 3);

  let from: Date;
  let to: Date;
  switch (id) {
    case "this_week":     from = monday;                       to = tomorrow; break;
    case "last_week":     from = addDays(monday, -7);          to = monday;   break;
    case "current_month": from = day(y, m, 1);                 to = tomorrow; break;
    // 30 days INCLUDING today, so from is today minus 29.
    case "past_30":       from = addDays(today, -29);          to = tomorrow; break;
    case "qtd":           from = day(y, q * 3 + 1, 1);         to = tomorrow; break;
    case "last_quarter": {
      const ly = q === 0 ? y - 1 : y;
      const lq = q === 0 ? 3 : q - 1;
      from = day(ly, lq * 3 + 1, 1);
      to = day(y, q * 3 + 1, 1);
      break;
    }
    case "ytd":           from = day(y, 1, 1);                 to = tomorrow; break;
  }
  return { id, label: PERIOD_LABEL[id], from: iso(from), to: iso(to) };
}

/** One (kind, site) bucket of the punch-based cost model, summed over the period. */
export interface CostRow {
  kind: "SITE" | "CAPX" | "MANAGEMENT" | "PTO" | "UNASSIGNED";
  site_number: number | null;
  punched_h: number;
  gps_onsite_h: number;
  punches: number;
}

export async function handleMaintenanceSummary(
  env: MaintenanceEnv,
  session: Session,
  periodRaw: string | null = null
): Promise<Response> {
  if (!isMaintenanceViewer(session)) {
    return jsonError(403, "maintenance tracker requires admin");
  }
  if (!env.SUPABASE_SERVICE_KEY) {
    return jsonError(503, "service key unbound");
  }

  const period = resolvePeriod(periodRaw);
  // PostgREST range: work_date >= from AND work_date < to.
  const range = `&work_date=gte.${period.from}&work_date=lt.${period.to}`;

  // Independent reads, issued together. They share no ordering and the page
  // needs all of them before it can render anything, so sequential would just
  // add up the latencies.
  const [costDays, mechanics, tiers, crew, siteNames, workOrders, devices, workload, mechanicDays] =
    await Promise.all([
    // One day-grained fact, summed on the page into both the cost-centre
    // cards and the per-site table. Two reads would be two chances for the
    // headline and the breakdown to disagree.
    pgSelect<CostDayRow>(env, `mt_cost_day?select=*${range}`),
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
      `mt_site_work_orders?select=*&completed_at=gte.${period.from}` +
        `&completed_at=lt.${period.to}&order=completed_at.desc`
    ),
    pgSelect<DeviceHealthRow>(env, "mt_device_health?select=*&order=device_status,device_id"),
    pgSelect<WorkloadRow>(env, "mt_mechanic_workload?select=*&order=closed_30d.desc"),
    // Scoped to the same window as the work orders. The drill-down is a
    // "what happened lately" surface; the full history is ~900 rows that
    // would be shipped and thrown away on every load.
    pgSelect<MechanicDayRow>(
      env,
      `mt_mechanic_day?select=*${range}&order=work_date.desc,display_name.asc`
    )
  ]);

  const firstError = [
    costDays, mechanics, tiers, crew, siteNames, workOrders, devices, workload,
    mechanicDays
  ].find((r) => !r.ok);
  if (firstError && !firstError.ok) {
    console.error("[maintenance.summary] read failed:", firstError.error);
    return jsonError(502, "maintenance read failed");
  }
  if (
    !costDays.ok || !mechanics.ok || !tiers.ok || !crew.ok ||
    !siteNames.ok || !workOrders.ok || !devices.ok || !workload.ok ||
    !mechanicDays.ok
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

  // Summed here rather than shipped per-day: the page wants totals, and a
  // year-to-date range is a few hundred day rows it would only fold anyway.
  const costMap = new Map<string, CostRow>();
  for (const r of costDays.rows) {
    const key = `${r.kind}|${r.site_number ?? ""}`;
    const cur = costMap.get(key) ?? {
      kind: r.kind,
      site_number: r.site_number,
      punched_h: 0,
      gps_onsite_h: 0,
      punches: 0
    };
    cur.punched_h += Number(r.punched_h ?? 0);
    cur.gps_onsite_h += Number(r.gps_onsite_h ?? 0);
    cur.punches += Number(r.punches ?? 0);
    costMap.set(key, cur);
  }
  const costRows = [...costMap.values()].sort((a, b) => b.punched_h - a.punched_h);

  return json({
    generated_at: new Date().toISOString(),
    period,
    cost_rows: costRows,
    mechanics: mechanics.rows,
    tiers: tierRows,
    crew_names: names,
    site_names: siteNameMap,
    work_orders: workOrders.rows,
    devices: devices.rows,
    workload: workload.rows,
    mechanic_days: mechanicDays.rows
  });
}

