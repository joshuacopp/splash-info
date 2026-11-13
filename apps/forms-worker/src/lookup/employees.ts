// Employee field (PLAN_FORMS_PERSONNEL.md phase 2).
//
//   POST /forms/api/employees/{slug}
//     body {field_key, key_value, q}
//     -> {group, site_label, matches: Person[], elsewhere: Person[]}
//
// Searches the Beekeeper roster of the site the form's site field names, or
// the 011 / 101 office groups (typed as site "011" / "101"). When nobody at
// the site matches and q is 3+ letters, `elsewhere` offers matches from the
// whole company so a transfer or a misfiled employee can still be picked.
//
// Exposure is deliberately narrow: name, job title and location label only,
// at most 10 + 5 rows, 2+ letters required, same-origin only, and ONLY for a
// published form whose current schema has this employee field. Public-audience
// forms are refused outright -- the roster must never be searchable from a
// link anyone on the internet can open.
//
// The real work is in SQL (supabase/personnel-placements-03-employee-search.sql);
// execute on those functions is granted to service_role only.
//
// resolveEmployees() is the submit-time half: a picked person is re-read from
// the roster (the page's copy of name/title is never trusted), and a typed
// name is refused when it closely matches a real employee, so typing cannot be
// used to dodge that person's real org level.

import { isOriginAllowed, jsonError } from "@splash/http";
import { normalizeSiteKey } from "@splash/db-supabase";
import type { EmployeeField, EmployeeValue, FormSchema, LookupKeyColumn } from "@splash/forms-schema";
import type { Env } from "../index.js";
import { getFormBySlug, getCurrentVersion } from "../db/forms.js";

interface SupabaseEnv {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
}

export interface RosterPerson {
  beekeeper_user_id: string;
  display_name: string;
  job_title: string | null;
  location_label: string | null;
}

type Group =
  | { kind: "site"; site: number; label: string }
  | { kind: "office_011"; label: string }
  | { kind: "office_101"; label: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sbHeaders(env: SupabaseEnv): Record<string, string> {
  return {
    apikey: env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    "Content-Type": "application/json"
  };
}

async function rpc<T>(env: SupabaseEnv, fn: string, args: Record<string, unknown>): Promise<T> {
  const resp = await fetch(new URL(`/rest/v1/rpc/${fn}`, env.SUPABASE_URL).toString(), {
    method: "POST",
    headers: sbHeaders(env),
    body: JSON.stringify(args)
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`[forms.employees] ${fn} ${resp.status}: ${t.slice(0, 200)}`);
  }
  return (await resp.json()) as T;
}

/** What the site field's value names: a site, the 011 group, or the 101
 *  group. Null when it names nothing we know. */
export async function resolveGroup(
  env: SupabaseEnv,
  keyColumn: LookupKeyColumn,
  keyValue: string
): Promise<Group | null> {
  const raw = keyValue.trim();
  if (!raw) return null;

  if (keyColumn === "pricing_simple.site") {
    const code = normalizeSiteKey(raw);
    if (code === "011") return { kind: "office_011", label: "SMG (011)" };
    if (code === "101") return { kind: "office_101", label: "Corporate (101)" };
    if (!/^\d{3}$/.test(code)) return null;
    const site = Number(code);
    const label = await siteLabel(env, site);
    return label ? { kind: "site", site, label } : null;
  }

  // A location slug -> its site number via pricing_simple.
  const url = new URL("/rest/v1/pricing_simple", env.SUPABASE_URL);
  url.searchParams.set("select", "site,location_pretty");
  url.searchParams.set("location_code", `eq.${raw.toLowerCase()}`);
  url.searchParams.set("limit", "1");
  const resp = await fetch(url.toString(), { headers: sbHeaders(env) });
  if (!resp.ok) throw new Error(`[forms.employees] pricing_simple ${resp.status}`);
  const row = ((await resp.json().catch(() => [])) as { site: string | null; location_pretty: string | null }[])[0];
  if (!row?.site || !/^\d{1,3}$/.test(row.site.trim())) return null;
  const site = Number(row.site);
  return {
    kind: "site",
    site,
    label: `${row.location_pretty?.trim() || "Site"} (${String(site).padStart(3, "0")})`
  };
}

async function siteLabel(env: SupabaseEnv, site: number): Promise<string | null> {
  const url = new URL("/rest/v1/locations", env.SUPABASE_URL);
  url.searchParams.set("select", "site");
  url.searchParams.set("site_number", `eq.${site}`);
  url.searchParams.set("limit", "1");
  const resp = await fetch(url.toString(), { headers: sbHeaders(env) });
  if (!resp.ok) throw new Error(`[forms.employees] locations ${resp.status}`);
  const row = ((await resp.json().catch(() => [])) as { site: string | null }[])[0];
  if (!row) return null;
  return `${(row.site ?? "Site").replace(/\*/g, "").trim()} (${String(site).padStart(3, "0")})`;
}

function rosterArgs(group: Group, q: string, limit: number): Record<string, unknown> {
  return {
    p_group: group.kind,
    p_site: group.kind === "site" ? group.site : null,
    p_q: q,
    p_limit: limit
  };
}

export async function handleEmployeeSearch(
  env: Env,
  req: Request,
  slug: string
): Promise<Response> {
  if (!isOriginAllowed(req)) return jsonError(403, "bad_origin");

  const form = await getFormBySlug(env, slug);
  if (!form) return jsonError(404, "form_not_found");
  if (form.status !== "published" || !form.currentVersionId) {
    return jsonError(410, "form_not_accepting");
  }
  if (form.audience === "public") return jsonError(403, "not_on_public_forms");
  const version = await getCurrentVersion(env, form.id, form.currentVersionId);
  if (!version) return jsonError(500, "form_version_missing");

  let body: { field_key?: unknown; key_value?: unknown; q?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return jsonError(400, "bad_json");
  }
  const field = version.schema.fields.find(
    (f) => f.key === body.field_key && f.type === "employee"
  ) as EmployeeField | undefined;
  if (!field) return jsonError(400, "unknown_field");

  const q = typeof body.q === "string" ? body.q.trim().slice(0, 60) : "";
  const keyValue = typeof body.key_value === "string" ? body.key_value : "";

  try {
    const group = await resolveGroup(env, field.keyColumn, keyValue);
    if (!group) return json({ group: null, site_label: null, matches: [], elsewhere: [] });
    if (q.length < 2) return json({ group: group.kind, site_label: group.label, matches: [], elsewhere: [] });

    const matches = await rpc<RosterPerson[]>(env, "employee_roster", rosterArgs(group, q, 10));
    const elsewhere =
      matches.length === 0 && q.length >= 3
        ? await rpc<RosterPerson[]>(env, "employee_search_anywhere", { p_q: q, p_limit: 5 })
        : [];
    return json({ group: group.kind, site_label: group.label, matches, elsewhere });
  } catch (err) {
    console.error("[forms.employees] search failed", err);
    return jsonError(502, "employees_unavailable");
  }
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}

/* ------------------------------------------------------------------------- *
 * Submit time
 * ------------------------------------------------------------------------- */

type ResolveResult =
  | { ok: true }
  | { ok: false; status: number; fields: Record<string, string> };

/**
 * Rewrite every employee field in `payload` in place.
 *
 * Accepts `{id, name}` (picked) or `{id: null, name}` (typed). A picked id is
 * re-read from the roster -- name, title and location come from there, never
 * from the page. A typed name is refused when allowTyped is false or when it
 * closely matches a current employee. Fields that are blank are removed, and
 * the normal required check then decides.
 */
export async function resolveEmployees(
  env: SupabaseEnv,
  schema: FormSchema,
  payload: Record<string, unknown>
): Promise<ResolveResult> {
  const fields: Record<string, string> = {};
  for (const f of schema.fields) {
    if (f.type !== "employee") continue;
    const raw = payload[f.key];
    if (raw === undefined || raw === null || raw === "") {
      delete payload[f.key];
      continue;
    }
    if (typeof raw !== "object" || Array.isArray(raw)) {
      fields[f.key] = "Pick an employee from the list";
      continue;
    }
    const r = raw as { id?: unknown; name?: unknown };
    const id = typeof r.id === "string" && UUID_RE.test(r.id) ? r.id : null;
    const name = typeof r.name === "string" ? r.name.replace(/\s+/g, " ").trim() : "";

    try {
      if (id) {
        const person = await readPerson(env, id);
        if (!person) {
          fields[f.key] = "That employee could not be found. Search again.";
          continue;
        }
        const value: EmployeeValue = {
          id,
          name: person.display_name,
          title: person.job_title,
          site: person.location_label,
          unverified: false
        };
        payload[f.key] = value;
        continue;
      }

      if (!name) {
        delete payload[f.key];
        continue;
      }
      if (f.allowTyped === false) {
        fields[f.key] = "Pick an employee from the list";
        continue;
      }
      if (name.length < 2 || name.length > 100) {
        fields[f.key] = "Enter the employee's full name";
        continue;
      }
      const near = await rpc<RosterPerson[]>(env, "employee_near_matches", { p_name: name });
      if (near.length > 0) {
        const n = near[0]!;
        fields[f.key] =
          `"${name}" looks like ${n.display_name}` +
          (n.location_label ? ` (${n.location_label})` : "") +
          ". Search for them and pick them from the list.";
        continue;
      }
      const value: EmployeeValue = { id: null, name, title: null, site: null, unverified: true };
      payload[f.key] = value;
    } catch (err) {
      console.error("[forms.employees] resolve failed", err);
      return { ok: false, status: 502, fields: { [f.key]: "Couldn't check the employee. Try again." } };
    }
  }
  return Object.keys(fields).length ? { ok: false, status: 422, fields } : { ok: true };
}

async function readPerson(env: SupabaseEnv, id: string): Promise<RosterPerson | null> {
  // Reuses the roster function's label logic by reading the view directly.
  const url = new URL("/rest/v1/personnel_effective", env.SUPABASE_URL);
  url.searchParams.set("select", "beekeeper_user_id,display_name,position,org_unit_ids,works_at,suspended");
  url.searchParams.set("beekeeper_user_id", `eq.${id}`);
  url.searchParams.set("limit", "1");
  const resp = await fetch(url.toString(), { headers: sbHeaders(env) });
  if (!resp.ok) throw new Error(`[forms.employees] personnel_effective ${resp.status}`);
  const row = ((await resp.json().catch(() => [])) as {
    beekeeper_user_id: string;
    display_name: string | null;
    position: string | null;
    org_unit_ids: unknown;
    works_at: string;
    suspended: boolean;
  }[])[0];
  if (!row || row.suspended || !row.display_name) return null;
  const label = await rpc<string | null>(env, "employee_location_label", {
    p_org_unit_ids: row.org_unit_ids ?? [],
    p_works_at: row.works_at
  });
  return {
    beekeeper_user_id: row.beekeeper_user_id,
    display_name: row.display_name,
    job_title: row.position,
    location_label: label
  };
}
