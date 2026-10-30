// CRD coverage as a visibility scope (2026-10-29).
//
// CRD agents and supervisors see submissions (JotForm, MaxPass signups) for the
// sites they cover, read LIVE from crd_site_coverage / crd_regions on every
// request -- the same rule the Golden Ticket queue uses
// (apps/jotform-worker/src/golden-ticket/admin.js callerCoverage):
//
//   agent      -- sites where crd_site_coverage.crd_email is the caller
//   supervisor -- every site in a region they supervise (crd_regions), PLUS
//                 every site with NO coverage row. Uncovered sites' reports go
//                 to every supervisor, so they see those too (operator
//                 2026-10-29).
//
// LIVE, NOT GRANTED. Nothing is written to user_permissions. Reassigning a site
// in crd_site_coverage moves visibility on the next request, with no sign-out
// and no stale grant left behind on the old agent -- which a sync trigger
// cannot give, because trg_sync_user_permissions is additive-only.
//
// FAILS CLOSED: any read error yields an empty scope (logged), never "all".

export interface CrdCoverage {
  /** Integer site numbers the caller covers. */
  siteNumbers: number[];
  /** Lowercased pricing_simple.location_code values for those sites. */
  locationCodes: string[];
  isAgent: boolean;
  isSupervisor: boolean;
}

const EMPTY: CrdCoverage = { siteNumbers: [], locationCodes: [], isAgent: false, isSupervisor: false };

type Env = { SUPABASE_URL: string; SUPABASE_SERVICE_KEY: string };

async function get<T>(env: Env, path: string, params: Record<string, string>): Promise<T[]> {
  const url = new URL(`/rest/v1/${path}`, env.SUPABASE_URL);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), {
    headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}` }
  });
  if (!res.ok) throw new Error(`${path} returned ${res.status}`);
  return (await res.json()) as T[];
}

/**
 * Custom forms switched on for CRD (`forms.crd_visible`). CRD reads those
 * forms' submissions at their covered sites only. Callers check this FIRST and
 * skip the coverage read when it is empty, so while no form is flagged the
 * cost to everyone else is this one indexed read.
 *
 * FAILS CLOSED: an error yields [] (logged).
 */
export async function listCrdVisibleFormIds(env: Env): Promise<string[]> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) return [];
  try {
    const rows = await get<{ id: string }>(env, "forms", { select: "id", crd_visible: "is.true" });
    return rows.map((r) => r.id).filter((id) => typeof id === "string" && id.length > 0);
  } catch (err) {
    console.error("[crd-coverage] crd_visible forms read failed — treating as none", err);
    return [];
  }
}

export async function getCrdCoverageForEmail(env: Env, email: string): Promise<CrdCoverage> {
  const me = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (!me || !env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) return EMPTY;

  try {
    const [coverage, regions] = await Promise.all([
      get<{ site_number: number; crd_email: string | null; crd_region: string | null }>(
        env,
        "crd_site_coverage",
        { select: "site_number,crd_email,crd_region" }
      ),
      get<{ region: string; supervisor_email: string | null }>(env, "crd_regions", {
        select: "region,supervisor_email"
      })
    ]);

    const myRegions = new Set(
      regions
        .filter((r) => (r.supervisor_email ?? "").trim().toLowerCase() === me)
        .map((r) => r.region)
    );
    const isSupervisor = myRegions.size > 0;

    const sites = new Set<number>();
    const covered = new Set<number>();
    let isAgent = false;
    for (const c of coverage) {
      if (typeof c.site_number !== "number") continue;
      covered.add(c.site_number);
      if ((c.crd_email ?? "").trim().toLowerCase() === me) {
        sites.add(c.site_number);
        isAgent = true;
      }
      if (c.crd_region && myRegions.has(c.crd_region)) sites.add(c.site_number);
    }

    if (isSupervisor) {
      const all = await get<{ site_number: number | null }>(env, "locations", { select: "site_number" });
      for (const l of all) {
        if (typeof l.site_number === "number" && !covered.has(l.site_number)) sites.add(l.site_number);
      }
    }

    if (sites.size === 0) return { ...EMPTY, isAgent, isSupervisor };

    const siteNumbers = [...sites].sort((a, b) => a - b);
    const padded = siteNumbers.map((n) => String(n).padStart(3, "0"));
    const pricing = await get<{ location_code: string | null }>(env, "pricing_simple", {
      select: "location_code",
      site: `in.(${padded.join(",")})`
    });
    const locationCodes = [
      ...new Set(pricing.map((p) => (p.location_code ?? "").toLowerCase()).filter(Boolean))
    ];

    return { siteNumbers, locationCodes, isAgent, isSupervisor };
  } catch (err) {
    console.error("[crd-coverage] read failed — treating as no coverage", err);
    return EMPTY;
  }
}
