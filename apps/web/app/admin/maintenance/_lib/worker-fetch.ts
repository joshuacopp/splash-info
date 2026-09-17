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
export interface MaintenanceSummary {
  generated_at: string;
  cost_centres: CostCentreRow[];
  sites: SiteRow[];
  mechanics: MechanicRow[];
  tiers: TierRow[];
  crew_names: Record<string, string>;
}

export type SummaryResult =
  | { ok: true; data: MaintenanceSummary }
  | { ok: false; status: number; error: string };

export async function getMaintenanceSummary(): Promise<SummaryResult> {
  const cookieStore = await cookies();
  const headers = new Headers({ Cookie: cookieStore.toString() });

  let res: Response;
  try {
    const { env } = await getCloudflareContext({ async: true });
    // Typed in apps/web/cloudflare-env.d.ts. Optional-chained rather than
    // asserted: the binding is genuinely absent under `next dev`.
    const binding = env?.[BINDING];
    if (binding) {
      res = await binding.fetch(new Request(`https://internal${PATH}`, { headers }));
    } else {
      res = await urlFetch(headers);
    }
  } catch {
    // next dev, or the binding is unbound in this runtime.
    res = await urlFetch(headers);
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

async function urlFetch(headers: Headers): Promise<Response> {
  const base = process.env.NEXT_PUBLIC_WORKORDERS_WORKER_URL ?? "";
  return fetch(`${base}${PATH}`, { headers, cache: "no-store" });
}
