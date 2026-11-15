// Site open / closed status -- data access (supabase/site-status-01.sql).
//
// Direct PostgREST with the service key, like the rest of this worker. The
// site directory is jotform_site_lookup: one row per site_number with RD, RM,
// HRT, site email and CRD coverage already joined (and the CRD supervisor
// blanked when they are the site's own agent).

import type { Env } from "../index.js";

export const REASONS = ["weather", "power", "water", "equipment", "staffing", "other"] as const;
export type Reason = (typeof REASONS)[number];
export const REASON_LABEL: Record<Reason, string> = {
  weather: "Weather",
  power: "Power outage",
  water: "Water / plumbing",
  equipment: "Equipment failure",
  staffing: "Staffing",
  other: "Other"
};

export interface SiteInfo {
  site_number: number;
  site: string;
  rd_name: string | null;
  rd_email: string | null;
  rm_name: string | null;
  rm_email: string | null;
  hrt_email: string | null;
  site_email: string | null;
  crd_email: string | null;
  crd_supervisor_email: string | null;
  /** Has a crd_site_coverage row. Uncovered sites mail every supervisor. */
  crd_covered: boolean;
}

export interface EstimateChange {
  at: string;
  by: string;
  from: string;
  to: string;
  note?: string | null;
}

export interface Closure {
  id: string;
  site_number: number;
  site_name: string;
  rd_name: string | null;
  rd_email: string | null;
  rm_name: string | null;
  rm_email: string | null;
  reason: Reason;
  reason_detail: string | null;
  closed_at: string;
  closed_by: string;
  original_est_reopen_at: string;
  est_reopen_at: string;
  estimate_changes: EstimateChange[];
  reopened_at: string | null;
  reopened_by: string | null;
  reopened_via: "board" | "link" | "email_link" | null;
  reopen_note: string | null;
  overdue_notified_for: string | null;
}

export interface DownItem {
  id: string;
  site_number: number;
  item: string;
  note: string | null;
  reported_at: string;
  reported_by: string;
  reported_via: "board" | "link";
}

export interface Settings {
  open_token: string;
  test_email_to: string | null;
  updated_at: string;
  updated_by: string | null;
}

function h(env: Env, extra: Record<string, string> = {}): Record<string, string> {
  return {
    apikey: env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    Accept: "application/json",
    ...extra
  };
}

function rest(env: Env, path: string, params: Record<string, string> = {}): string {
  const url = new URL(`/rest/v1/${path}`, env.SUPABASE_URL);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

async function getRows<T>(env: Env, path: string, params: Record<string, string>): Promise<T[]> {
  const res = await fetch(rest(env, path, params), { headers: h(env) });
  if (!res.ok) throw new Error(`[site-status] GET ${path} ${res.status}: ${await res.text().catch(() => "")}`);
  return (await res.json()) as T[];
}

const lower = (s: unknown): string | null =>
  typeof s === "string" && s.trim() ? s.trim().toLowerCase() : null;
const clean = (s: unknown): string | null => (typeof s === "string" && s.trim() ? s.trim() : null);

interface LookupRow {
  site_number: number;
  site: string | null;
  area_manager: string | null;
  am_email: string | null;
  regional_manager: string | null;
  rm_email: string | null;
  hrt_email: string | null;
  site_email: string | null;
  crd_email: string | null;
  crd_supervisor_email: string | null;
  crd_region: string | null;
}

/** Every real site (test sites dropped), by site number. */
export async function listSites(env: Env): Promise<SiteInfo[]> {
  const rows = await getRows<LookupRow>(env, "jotform_site_lookup", {
    select:
      "site_number,site,area_manager,am_email,regional_manager,rm_email,hrt_email,site_email,crd_email,crd_supervisor_email,crd_region",
    order: "site_number.asc"
  });
  return rows
    .filter((r) => Number.isInteger(r.site_number) && r.site && !/\btest\b/i.test(r.site))
    .map((r) => ({
      site_number: r.site_number,
      // A trailing "*" marks five-star sites in the directory; not part of the name.
      site: (r.site ?? "").replace(/\*+\s*$/, "").trim(),
      rd_name: clean(r.area_manager),
      rd_email: lower(r.am_email),
      rm_name: clean(r.regional_manager),
      rm_email: lower(r.rm_email),
      hrt_email: lower(r.hrt_email),
      site_email: lower(r.site_email),
      crd_email: lower(r.crd_email),
      crd_supervisor_email: lower(r.crd_supervisor_email),
      crd_covered: !!r.crd_region || !!r.crd_email
    }));
}

export async function getSite(env: Env, siteNumber: number): Promise<SiteInfo | null> {
  return (await listSites(env)).find((s) => s.site_number === siteNumber) ?? null;
}

/** Every CRD supervisor -- recipients for a site with no coverage row. */
export async function listCrdSupervisors(env: Env): Promise<string[]> {
  const rows = await getRows<{ supervisor_email: string }>(env, "crd_regions", { select: "supervisor_email" });
  return rows.map((r) => lower(r.supervisor_email)).filter((e): e is string => !!e);
}

const CLOSURE_COLS =
  "id,site_number,site_name,rd_name,rd_email,rm_name,rm_email,reason,reason_detail,closed_at,closed_by,original_est_reopen_at,est_reopen_at,estimate_changes,reopened_at,reopened_by,reopened_via,reopen_note,overdue_notified_for";

export async function listOpenClosures(env: Env): Promise<Closure[]> {
  return getRows<Closure>(env, "site_closures", {
    select: CLOSURE_COLS,
    reopened_at: "is.null",
    order: "closed_at.asc"
  });
}

/** The most recent finished closure for each site (one query, newest first, first-wins). */
export async function lastClosureBySite(env: Env): Promise<Map<number, Closure>> {
  // DISTINCT ON isn't reachable through PostgREST; the table is small (a few
  // closures per site per month), so read the last 2,000 and keep the first per site.
  const rows = await getRows<Closure>(env, "site_closures", {
    select: CLOSURE_COLS,
    reopened_at: "not.is.null",
    order: "closed_at.desc",
    limit: "2000"
  });
  const out = new Map<number, Closure>();
  for (const r of rows) if (!out.has(r.site_number)) out.set(r.site_number, r);
  return out;
}

export async function getClosure(env: Env, id: string): Promise<Closure | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const rows = await getRows<Closure>(env, "site_closures", { select: CLOSURE_COLS, id: `eq.${id}` });
  return rows[0] ?? null;
}

export async function getOpenClosureForSite(env: Env, siteNumber: number): Promise<Closure | null> {
  const rows = await getRows<Closure>(env, "site_closures", {
    select: CLOSURE_COLS,
    site_number: `eq.${siteNumber}`,
    reopened_at: "is.null"
  });
  return rows[0] ?? null;
}

/** Closures whose closed_at falls in [fromIso, toIso] (report-kit bounds are inclusive). */
export async function listClosuresBetween(env: Env, fromIso: string, toIso: string): Promise<Closure[]> {
  const url = new URL(rest(env, "site_closures", { select: CLOSURE_COLS, order: "closed_at.asc", limit: "10000" }));
  url.searchParams.append("closed_at", `gte.${fromIso}`);
  url.searchParams.append("closed_at", `lte.${toIso}`);
  const res = await fetch(url.toString(), { headers: h(env) });
  if (!res.ok) throw new Error(`[site-status] closures range ${res.status}`);
  return (await res.json()) as Closure[];
}

export type InsertClosureResult = { ok: true; closure: Closure } | { ok: false; alreadyClosed: boolean };

export async function insertClosure(env: Env, row: Omit<Closure, "id" | "estimate_changes" | "reopened_at" | "reopened_by" | "reopened_via" | "reopen_note" | "overdue_notified_for">): Promise<InsertClosureResult> {
  const res = await fetch(rest(env, "site_closures", { select: CLOSURE_COLS }), {
    method: "POST",
    headers: h(env, { "Content-Type": "application/json", Prefer: "return=representation" }),
    body: JSON.stringify(row)
  });
  if (res.status === 409) return { ok: false, alreadyClosed: true };
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    if (t.includes("23505")) return { ok: false, alreadyClosed: true };
    console.error("[site-status] insert closure failed", res.status, t);
    return { ok: false, alreadyClosed: false };
  }
  const rows = (await res.json()) as Closure[];
  return rows[0] ? { ok: true, closure: rows[0] } : { ok: false, alreadyClosed: false };
}

/**
 * PATCH a closure, conditioned on extra filters (compare-and-set). Returns the
 * updated row, or null when no row matched (someone else got there first).
 */
export async function patchClosure(
  env: Env,
  id: string,
  patch: Record<string, unknown>,
  where: Record<string, string> = {}
): Promise<Closure | null> {
  const res = await fetch(rest(env, "site_closures", { id: `eq.${id}`, select: CLOSURE_COLS, ...where }), {
    method: "PATCH",
    headers: h(env, { "Content-Type": "application/json", Prefer: "return=representation" }),
    body: JSON.stringify(patch)
  });
  if (!res.ok) {
    console.error("[site-status] patch closure failed", res.status, await res.text().catch(() => ""));
    return null;
  }
  const rows = (await res.json()) as Closure[];
  return rows[0] ?? null;
}

// ---- down items -----------------------------------------------------------

const DOWN_COLS = "id,site_number,item,note,reported_at,reported_by,reported_via";

export async function listOpenDownItems(env: Env, siteNumber?: number): Promise<DownItem[]> {
  const params: Record<string, string> = { select: DOWN_COLS, cleared_at: "is.null", order: "reported_at.asc" };
  if (siteNumber !== undefined) params.site_number = `eq.${siteNumber}`;
  return getRows<DownItem>(env, "site_down_items", params);
}

export async function insertDownItem(
  env: Env,
  row: { site_number: number; item: string; note: string | null; reported_by: string; reported_via: "board" | "link" }
): Promise<DownItem | null> {
  const res = await fetch(rest(env, "site_down_items", { select: DOWN_COLS }), {
    method: "POST",
    headers: h(env, { "Content-Type": "application/json", Prefer: "return=representation" }),
    body: JSON.stringify(row)
  });
  if (!res.ok) {
    console.error("[site-status] insert down item failed", res.status, await res.text().catch(() => ""));
    return null;
  }
  return ((await res.json()) as DownItem[])[0] ?? null;
}

export async function getDownItem(env: Env, id: string): Promise<DownItem | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const rows = await getRows<DownItem>(env, "site_down_items", { select: DOWN_COLS, id: `eq.${id}`, cleared_at: "is.null" });
  return rows[0] ?? null;
}

export async function clearDownItem(env: Env, id: string, by: string, via: "board" | "link"): Promise<boolean> {
  const res = await fetch(rest(env, "site_down_items", { id: `eq.${id}`, cleared_at: "is.null", select: "id" }), {
    method: "PATCH",
    headers: h(env, { "Content-Type": "application/json", Prefer: "return=representation" }),
    body: JSON.stringify({ cleared_at: new Date().toISOString(), cleared_by: by, cleared_via: via })
  });
  if (!res.ok) return false;
  return ((await res.json()) as unknown[]).length > 0;
}

// ---- settings ---------------------------------------------------------------

export async function getSettings(env: Env): Promise<Settings | null> {
  try {
    const rows = await getRows<Settings>(env, "site_status_settings", {
      select: "open_token,test_email_to,updated_at,updated_by",
      id: "eq.1"
    });
    return rows[0] ?? null;
  } catch (err) {
    console.error("[site-status] settings read failed", err);
    return null;
  }
}

export async function patchSettings(env: Env, patch: Partial<Settings>): Promise<Settings | null> {
  const res = await fetch(
    rest(env, "site_status_settings", { id: "eq.1", select: "open_token,test_email_to,updated_at,updated_by" }),
    {
      method: "PATCH",
      headers: h(env, { "Content-Type": "application/json", Prefer: "return=representation" }),
      body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() })
    }
  );
  if (!res.ok) return null;
  return ((await res.json()) as Settings[])[0] ?? null;
}

// ---- emailed manage links ----------------------------------------------------

export async function insertClosureLink(
  env: Env,
  row: { closure_id: string; token_hash: string; recipient: string; expires_at: string }
): Promise<boolean> {
  const res = await fetch(rest(env, "site_closure_links"), {
    method: "POST",
    headers: h(env, { "Content-Type": "application/json", Prefer: "return=minimal" }),
    body: JSON.stringify(row)
  });
  return res.ok;
}

export async function findClosureLink(
  env: Env,
  tokenHash: string
): Promise<{ closure_id: string; recipient: string; expires_at: string } | null> {
  const rows = await getRows<{ closure_id: string; recipient: string; expires_at: string }>(env, "site_closure_links", {
    select: "closure_id,recipient,expires_at",
    token_hash: `eq.${tokenHash}`
  });
  return rows[0] ?? null;
}
