// Maintenance tracker — SSR reads against splash-workorders.
//
// Service-binding first (`WORKORDERS_WORKER` in apps/web/wrangler.toml), with
// a URL fallback for `next dev`, where getCloudflareContext() throws because
// the Next dev server runs outside the Workers runtime. Brief 17 pattern.
//
// Everything this returns is computed by Postgres views; nothing is cached
// here. See supabase/mt-*.sql for what each figure means and — more
// importantly — what it does not mean.
import { cookies } from "next/headers";
import { getCloudflareContext } from "@opennextjs/cloudflare";

const BINDING = "WORKORDERS_WORKER" as const;
const PATH = "/workorders/api/maintenance/summary";

/** One (kind, site) bucket of the punch-based cost model, summed over the period. */
export interface CostRow {
  kind: "SITE" | "CAPX" | "MANAGEMENT" | "PTO" | "UNASSIGNED";
  site_number: number | null;
  /** BILLED -- the cost basis. What mechanics punched. */
  punched_h: number;
  /** CORROBORATION -- vehicle inside the CLAIMED fence. Never a charge. */
  gps_onsite_h: number;
  punches: number;
}

export const MAINTENANCE_PERIODS = [
  { id: "this_week", label: "This week" },
  { id: "last_week", label: "Last week" },
  { id: "current_month", label: "Current month" },
  { id: "past_30", label: "Past 30 days" },
  { id: "qtd", label: "Quarter to date" },
  { id: "last_quarter", label: "Last quarter" },
  { id: "ytd", label: "Year to date" }
] as const;
export type MaintenancePeriodId = (typeof MAINTENANCE_PERIODS)[number]["id"];

/** Resolved by the WORKER so every caller shares one definition of a week. */
export interface ResolvedPeriod {
  id: MaintenancePeriodId;
  label: string;
  from: string;
  to: string;
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
/** One punch behind a site's billed hours. Flags are "look at this". */
export interface PunchDetailRow {
  shift_id: string;
  /** NULL for overhead and leave punches. */
  site_number: number | null;
  work_date: string;
  display_name: string;
  job_title: string | null;
  work_kind: "SITE" | "CAPX" | "OVERHEAD" | "PTO";
  source_type: string | null;
  start_et: string;
  end_et: string;
  punch_h: number;
  gps_onsite_h: number;
  long_punch: boolean;
  overnight_end: boolean;
  no_gps: boolean;
  device_status: string | null;
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
   * CODE    = the job's own Connecteam cost code, independent of GPS.
   * DERIVED = mt_connecteam_job_site, itself derived FROM GPS -- so asking
   *           whether the truck was at the claimed site is partly asking GPS
   *           to confirm itself. Render the distinction; a DERIVED row is
   *           descriptive, not evidence.
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
export interface MaintenanceSummary {
  generated_at: string;
  period: ResolvedPeriod;
  cost_rows: CostRow[];
  mechanics: MechanicRow[];
  tiers: TierRow[];
  crew_names: Record<string, string>;
  site_names: Record<string, string>;
  /** site_number -> Regional Manager. Empty when unassigned. */
  site_rms: Record<string, string>;
  work_orders: SiteWorkOrderRow[];
  devices: DeviceHealthRow[];
  workload: WorkloadRow[];
  mechanic_days: MechanicDayRow[];
  punch_detail: PunchDetailRow[];
}

export type SummaryResult =
  | { ok: true; data: MaintenanceSummary }
  | { ok: false; status: number; error: string };

export async function getMaintenanceSummary(
  period?: string
): Promise<SummaryResult> {
  const qs = period ? `?period=${encodeURIComponent(period)}` : "";
  const cookieStore = await cookies();
  const headers = new Headers({ Cookie: cookieStore.toString() });

  let res: Response;
  try {
    const { env } = await getCloudflareContext({ async: true });
    // Typed in apps/web/cloudflare-env.d.ts. Optional-chained rather than
    // asserted: the binding is genuinely absent under `next dev`.
    const binding = env?.[BINDING];
    if (binding) {
      res = await binding.fetch(new Request(`https://internal${PATH}${qs}`, { headers }));
    } else {
      res = await urlFetch(headers, qs);
    }
  } catch {
    // next dev, or the binding is unbound in this runtime.
    res = await urlFetch(headers, qs);
  }

  if (!res.ok) {
    let msg = `${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) msg = body.error;
    } catch {
      /* non-JSON error body; the status alone is the message */
    }
    return { ok: false, status: res.status, error: msg };
  }
  return { ok: true, data: (await res.json()) as MaintenanceSummary };
}

async function urlFetch(headers: Headers, qs = ""): Promise<Response> {
  const base = process.env.NEXT_PUBLIC_WORKORDERS_WORKER_URL ?? "";
  return fetch(`${base}${PATH}${qs}`, { headers, cache: "no-store" });
}
