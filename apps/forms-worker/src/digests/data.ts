// Digest reads: the form, its submissions in a period, per-site contacts, and
// the form_digests / form_digest_runs rows. Direct PostgREST with the service
// key, like the rest of this worker.

import type { DigestConfig, DigestSiteRole, Field, FormDigest } from "@splash/forms-schema";
import type { Env } from "../index.js";
import type { DigestSubmission, SiteInfo } from "./aggregate.js";

function headers(env: Env, extra: Record<string, string> = {}): Record<string, string> {
  return {
    apikey: env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    "Content-Type": "application/json",
    ...extra
  };
}

function rest(env: Env, path: string): URL {
  return new URL(`/rest/v1/${path}`, env.SUPABASE_URL);
}

async function getJson<T>(env: Env, url: URL, extra: Record<string, string> = {}): Promise<T> {
  const r = await fetch(url.toString(), { headers: headers(env, extra) });
  if (!r.ok) throw new Error(`${url.pathname} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json()) as T;
}

// --- form ------------------------------------------------------------------------

export interface DigestForm {
  id: string;
  slug: string;
  title: string;
  fields: Field[];
}

/** The form with the fields of its PUBLISHED version (the draft's if never published). */
export async function loadDigestForm(env: Env, formId: string): Promise<DigestForm | null> {
  const u = rest(env, "forms");
  u.searchParams.set("id", `eq.${formId}`);
  u.searchParams.set("select", "id,slug,title,current_version_id,draft_version_id");
  const rows = await getJson<
    { id: string; slug: string; title: string; current_version_id: string | null; draft_version_id: string | null }[]
  >(env, u);
  const f = rows[0];
  if (!f) return null;
  const versionId = f.current_version_id ?? f.draft_version_id;
  let fields: Field[] = [];
  if (versionId) {
    const v = rest(env, "form_versions");
    v.searchParams.set("id", `eq.${versionId}`);
    v.searchParams.set("select", "schema");
    const vr = await getJson<{ schema: { fields?: Field[] } }[]>(env, v);
    fields = vr[0]?.schema?.fields ?? [];
  }
  return { id: f.id, slug: f.slug, title: f.title, fields };
}

// --- submissions ------------------------------------------------------------------

/** Above this a digest is not a digest; the cap keeps a runaway form from eating the cron. */
export const SUBMISSION_CAP = 20_000;
const PAGE = 1000; // PostgREST db-max-rows

export async function loadSubmissions(
  env: Env,
  formId: string,
  fromUtc: string,
  toUtcExclusive: string
): Promise<{ subs: DigestSubmission[]; capped: boolean }> {
  const subs: DigestSubmission[] = [];
  for (let offset = 0; offset < SUBMISSION_CAP; offset += PAGE) {
    const u = rest(env, "form_submissions");
    u.searchParams.set("form_id", `eq.${formId}`);
    u.searchParams.append("submitted_at", `gte.${fromUtc}`);
    u.searchParams.append("submitted_at", `lt.${toUtcExclusive}`);
    u.searchParams.set("select", "id,submitted_at,location_code,payload");
    u.searchParams.set("order", "submitted_at.asc,id.asc");
    u.searchParams.set("limit", String(PAGE));
    u.searchParams.set("offset", String(offset));
    const page = await getJson<DigestSubmission[]>(env, u);
    for (const s of page) subs.push({ ...s, location_code: s.location_code?.toLowerCase() ?? null, payload: s.payload ?? {} });
    if (page.length < PAGE) return { subs, capped: false };
  }
  return { subs, capped: true };
}

// --- sites -------------------------------------------------------------------------

export interface SiteContacts extends SiteInfo {
  emails: Record<DigestSiteRole, string | null>;
}

/** Every site, keyed by lowercased location_code, with its contact emails. */
export async function loadSites(env: Env): Promise<Map<string, SiteContacts>> {
  const p = rest(env, "pricing_simple");
  p.searchParams.set("select", "location_code,location_pretty,site,rm_email,am_email,site_email");
  const l = rest(env, "locations");
  l.searchParams.set("select", "site_number,hrt_email");
  const [prices, locs] = await Promise.all([
    getJson<
      {
        location_code: string;
        location_pretty: string | null;
        site: string | null;
        rm_email: string | null;
        am_email: string | null;
        site_email: string | null;
      }[]
    >(env, p),
    getJson<{ site_number: number | string | null; hrt_email: string | null }[]>(env, l)
  ]);
  const hrt = new Map(locs.map((r) => [String(r.site_number ?? ""), r.hrt_email]));
  const out = new Map<string, SiteContacts>();
  // pricing_simple has one row per package; the location columns repeat.
  for (const r of prices) {
    const code = r.location_code?.toLowerCase();
    if (!code || out.has(code)) continue;
    const clean = (e: string | null | undefined) => (e && e.includes("@") ? e.trim().toLowerCase() : null);
    out.set(code, {
      code,
      name: r.location_pretty || code,
      number: r.site,
      emails: {
        site_email: clean(r.site_email),
        rm_email: clean(r.rm_email),
        am_email: clean(r.am_email),
        hrt_email: clean(hrt.get(String(r.site ?? "")))
      }
    });
  }
  return out;
}

// --- digests -------------------------------------------------------------------------

interface DigestRow {
  id: string;
  form_id: string;
  name: string;
  enabled: boolean;
  config: DigestConfig;
  last_sent_at: string | null;
  last_period: string | null;
  created_at: string;
  updated_at: string;
}

const DIGEST_SELECT = "id,form_id,name,enabled,config,last_sent_at,last_period,created_at,updated_at";

export async function listDigests(env: Env, filter: { formId?: string; enabledOnly?: boolean }): Promise<FormDigest[]> {
  const u = rest(env, "form_digests");
  u.searchParams.set("select", DIGEST_SELECT);
  if (filter.formId) u.searchParams.set("form_id", `eq.${filter.formId}`);
  if (filter.enabledOnly) u.searchParams.set("enabled", "is.true");
  u.searchParams.set("order", "created_at.asc");
  return getJson<DigestRow[]>(env, u);
}

export async function getDigest(env: Env, id: string): Promise<FormDigest | null> {
  const u = rest(env, "form_digests");
  u.searchParams.set("id", `eq.${id}`);
  u.searchParams.set("select", DIGEST_SELECT);
  return (await getJson<DigestRow[]>(env, u))[0] ?? null;
}

export async function insertDigest(
  env: Env,
  row: { form_id: string; name: string; enabled: boolean; config: DigestConfig; created_by: string | null }
): Promise<FormDigest> {
  const r = await fetch(rest(env, "form_digests").toString() + `?select=${DIGEST_SELECT}`, {
    method: "POST",
    headers: headers(env, { Prefer: "return=representation" }),
    body: JSON.stringify(row)
  });
  if (!r.ok) throw new Error(`form_digests insert ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return ((await r.json()) as DigestRow[])[0]!;
}

export async function updateDigest(
  env: Env,
  id: string,
  patch: Partial<{ name: string; enabled: boolean; config: DigestConfig; last_sent_at: string; last_period: string }>
): Promise<FormDigest | null> {
  const u = rest(env, "form_digests");
  u.searchParams.set("id", `eq.${id}`);
  u.searchParams.set("select", DIGEST_SELECT);
  const r = await fetch(u.toString(), {
    method: "PATCH",
    headers: headers(env, { Prefer: "return=representation" }),
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() })
  });
  if (!r.ok) throw new Error(`form_digests update ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return ((await r.json()) as DigestRow[])[0] ?? null;
}

export async function deleteDigest(env: Env, id: string): Promise<boolean> {
  const u = rest(env, "form_digests");
  u.searchParams.set("id", `eq.${id}`);
  const r = await fetch(u.toString(), { method: "DELETE", headers: headers(env, { Prefer: "return=representation" }) });
  if (!r.ok) throw new Error(`form_digests delete ${r.status}`);
  return ((await r.json()) as unknown[]).length > 0;
}

/**
 * Claim a (digest, period) for sending. Returns the run id only when THIS call
 * created the row -- the unique index makes it the lock, so overlapping cron
 * ticks cannot both send.
 */
export async function claimRun(env: Env, digestId: string, period: string): Promise<string | null> {
  const u = rest(env, "form_digest_runs");
  u.searchParams.set("on_conflict", "digest_id,period");
  u.searchParams.set("select", "id");
  const r = await fetch(u.toString(), {
    method: "POST",
    headers: headers(env, { Prefer: "resolution=ignore-duplicates,return=representation" }),
    body: JSON.stringify({ digest_id: digestId, period })
  });
  if (!r.ok) throw new Error(`form_digest_runs claim ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const rows = (await r.json()) as { id: string }[];
  return rows[0]?.id ?? null;
}

export async function finishRun(
  env: Env,
  runId: string,
  result: { recipients_sent: number; recipients_skipped: number; error?: string | null }
): Promise<void> {
  const u = rest(env, "form_digest_runs");
  u.searchParams.set("id", `eq.${runId}`);
  await fetch(u.toString(), {
    method: "PATCH",
    headers: headers(env),
    body: JSON.stringify({ ...result, error: result.error ?? null, finished_at: new Date().toISOString() })
  });
}
