// Required topics (2026-11-18, Monthly Safety Meeting).
//
// A committee sets, per month, the topics every site must cover at its
// monthly safety meeting. Table `form_required_topics` (see
// supabase/safety-meeting-01.sql), keyed (list_key, month) with month the
// first of the month. No row, or an empty list = no mandatory topics.
//
// Three surfaces, one table:
//   - public:  POST /forms/api/required-topics/{slug}  {field_key, date}
//              -> the list for that date's month, for the form to show;
//   - submit:  resolveRequiredTopics re-reads the list for the SUBMITTED date
//              and refuses the submit unless every topic was ticked;
//   - admin:   GET/PUT /forms/admin/api/required-topics (admin tier or the
//              list's form_access_grants tag, e.g. safety_committee).

import { isOriginAllowed, jsonError } from "@splash/http";
import { authenticate } from "@splash/auth";
import {
  REQUIRED_TOPIC_LISTS,
  REQUIRED_TOPIC_MAX,
  REQUIRED_TOPIC_MAX_LEN,
  isRequiredTopicListKey,
  type FormSchema,
  type RequiredTopicsField,
  type RequiredTopicsValue
} from "@splash/forms-schema";
import type { Env } from "../index.js";
import { getFormBySlug, getCurrentVersion } from "../db/forms.js";

interface SupabaseEnv {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
}

const headers = (env: SupabaseEnv): Record<string, string> => ({
  apikey: env.SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
});

const DATE_RE = /^(\d{4})-(\d{2})-\d{2}$/;
const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** "2026-12-03" -> "2026-12"; null when not a date. */
export function monthOf(date: string): string | null {
  const m = DATE_RE.exec(date);
  if (!m) return null;
  const mm = Number(m[2]);
  if (mm < 1 || mm > 12) return null;
  return `${m[1]}-${m[2]}`;
}

/* ------------------------------------------------------------------------- *
 * DB
 * ------------------------------------------------------------------------- */

interface TopicRow {
  month: string; // "2026-12-01"
  topics: string[];
  updated_at: string | null;
  updated_by_email: string | null;
}

export async function readTopics(env: SupabaseEnv, listKey: string, month: string): Promise<string[]> {
  const url = new URL("/rest/v1/form_required_topics", env.SUPABASE_URL);
  url.searchParams.set("select", "topics");
  url.searchParams.set("list_key", `eq.${listKey}`);
  url.searchParams.set("month", `eq.${month}-01`);
  url.searchParams.set("limit", "1");
  const resp = await fetch(url.toString(), { headers: headers(env) });
  if (!resp.ok) throw new Error(`[forms.required-topics] read ${resp.status}`);
  const rows = (await resp.json().catch(() => [])) as { topics: string[] | null }[];
  return (rows[0]?.topics ?? []).filter((t) => typeof t === "string" && t.trim() !== "");
}

async function readRange(env: SupabaseEnv, listKey: string, from: string, to: string): Promise<TopicRow[]> {
  const url = new URL("/rest/v1/form_required_topics", env.SUPABASE_URL);
  url.searchParams.set("select", "month,topics,updated_at,updated_by_email");
  url.searchParams.set("list_key", `eq.${listKey}`);
  url.searchParams.append("month", `gte.${from}-01`);
  url.searchParams.append("month", `lte.${to}-01`);
  url.searchParams.set("order", "month.asc");
  const resp = await fetch(url.toString(), { headers: headers(env) });
  if (!resp.ok) throw new Error(`[forms.required-topics] range ${resp.status}`);
  return (await resp.json().catch(() => [])) as TopicRow[];
}

async function writeTopics(
  env: SupabaseEnv,
  listKey: string,
  month: string,
  topics: string[],
  by: { userId: string | null; email: string }
): Promise<void> {
  const url = new URL("/rest/v1/form_required_topics", env.SUPABASE_URL);
  url.searchParams.set("on_conflict", "list_key,month");
  const resp = await fetch(url.toString(), {
    method: "POST",
    headers: {
      ...headers(env),
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal"
    },
    body: JSON.stringify({
      list_key: listKey,
      month: `${month}-01`,
      topics,
      updated_by: by.userId,
      updated_by_email: by.email,
      updated_at: new Date().toISOString()
    })
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`[forms.required-topics] write ${resp.status} ${text.slice(0, 200)}`);
  }
}

/* ------------------------------------------------------------------------- *
 * Public: the list for a date's month
 * ------------------------------------------------------------------------- */

export async function handleRequiredTopicsLookup(env: Env, req: Request, slug: string): Promise<Response> {
  if (!isOriginAllowed(req)) return jsonError(403, "bad_origin");
  const form = await getFormBySlug(env, slug);
  if (!form) return jsonError(404, "form_not_found");
  if (form.status !== "published" || !form.currentVersionId) return jsonError(410, "form_not_accepting");
  const version = await getCurrentVersion(env, form.id, form.currentVersionId);
  if (!version) return jsonError(500, "form_version_missing");

  let body: { field_key?: unknown; date?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return jsonError(400, "bad_json");
  }
  const field = version.schema.fields.find(
    (f) => f.key === body.field_key && f.type === "required_topics"
  ) as RequiredTopicsField | undefined;
  if (!field) return jsonError(400, "unknown_field");
  const month = typeof body.date === "string" ? monthOf(body.date) : null;
  if (!month) return json({ month: null, topics: [] });
  try {
    return json({ month, topics: await readTopics(env, field.listKey, month) });
  } catch (err) {
    console.error("[forms.required-topics] lookup failed", err);
    return jsonError(502, "topics_unavailable");
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}

/* ------------------------------------------------------------------------- *
 * Submit
 * ------------------------------------------------------------------------- */

type ResolveResult =
  | { ok: true }
  | { ok: false; status: number; fields: Record<string, string> };

/**
 * Replace each required_topics entry ({ticked}) with the canonical
 * RequiredTopicsValue, read for the month of the SUBMITTED date. Refuses the
 * submit while any topic for that month is un-ticked. A date that is missing
 * or invalid is left to the date field's own validation.
 */
export async function resolveRequiredTopics(
  env: SupabaseEnv,
  schema: FormSchema,
  payload: Record<string, unknown>
): Promise<ResolveResult> {
  const fields: Record<string, string> = {};
  for (const f of schema.fields) {
    if (f.type !== "required_topics") continue;
    const raw = payload[f.key] as { ticked?: unknown } | undefined;
    const ticked = new Set(
      Array.isArray(raw?.ticked) ? (raw!.ticked as unknown[]).filter((t): t is string => typeof t === "string") : []
    );
    const dateVal = payload[f.dateFieldKey];
    const month = typeof dateVal === "string" ? monthOf(dateVal) : null;
    if (!month) {
      delete payload[f.key];
      fields[f.key] = "Enter the meeting date first";
      continue;
    }
    let topics: string[];
    try {
      topics = await readTopics(env, f.listKey, month);
    } catch (err) {
      console.error("[forms.required-topics] submit read failed", err);
      return { ok: false, status: 502, fields: { [f.key]: "Couldn't load this month's required topics. Try again." } };
    }
    const missing = topics.filter((t) => !ticked.has(t));
    if (missing.length > 0) {
      fields[f.key] =
        missing.length === 1
          ? `Tick "${missing[0]}" once it has been covered`
          : `Tick each required topic once it has been covered (${missing.length} not ticked)`;
    }
    const value: RequiredTopicsValue = { month, topics };
    payload[f.key] = value;
  }
  return Object.keys(fields).length ? { ok: false, status: 422, fields } : { ok: true };
}

/* ------------------------------------------------------------------------- *
 * Admin: view / edit a list
 * ------------------------------------------------------------------------- */

async function hasGrant(env: SupabaseEnv, userId: string, tag: string): Promise<boolean> {
  const url = new URL("/rest/v1/form_access_grants", env.SUPABASE_URL);
  url.searchParams.set("select", "tag");
  url.searchParams.set("user_id", `eq.${userId}`);
  url.searchParams.set("tag", `eq.${tag}`);
  url.searchParams.set("limit", "1");
  const resp = await fetch(url.toString(), { headers: headers(env) });
  if (!resp.ok) throw new Error(`[forms.required-topics] grant read ${resp.status}`);
  const rows = (await resp.json().catch(() => [])) as unknown[];
  return rows.length > 0;
}

function addMonths(month: string, n: number): string {
  const m = MONTH_RE.exec(month)!;
  const idx = Number(m[1]) * 12 + (Number(m[2]) - 1) + n;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`;
}

function easternMonth(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit"
  }).formatToParts(new Date());
  const y = parts.find((p) => p.type === "year")?.value ?? "1970";
  const mo = parts.find((p) => p.type === "month")?.value ?? "01";
  return `${y}-${mo}`;
}

/**
 * GET  /forms/admin/api/required-topics?list=safety_meeting
 *   -> { list, label, can_edit, current_month, months: [{month, topics, updated_at, updated_by_email}] }
 *      (3 months back through 12 ahead; months without a row come back empty)
 * PUT  /forms/admin/api/required-topics  {list, month, topics}
 *
 * Anyone with a session may READ (site managers can see what is coming up);
 * editing needs admin tier or the list's access tag.
 */
export async function handleRequiredTopicsAdmin(env: Env, req: Request): Promise<Response> {
  if (!env.SUPABASE_SERVICE_KEY) return jsonError(503, "service_key_unbound");
  const auth = await authenticate(req, env);
  if (auth.status !== "authenticated") return jsonError(401, "unauthorized");
  const session = auth.session;
  const adminTier =
    session.role === "super_admin" || session.dcRole === "admin" || session.dcRole === "super_admin";

  const url = new URL(req.url);
  const listParam = req.method === "GET" ? url.searchParams.get("list") ?? "safety_meeting" : null;

  async function canEdit(listKey: keyof typeof REQUIRED_TOPIC_LISTS): Promise<boolean> {
    if (adminTier) return true;
    if (!session.userId) return false;
    return hasGrant(env, session.userId, REQUIRED_TOPIC_LISTS[listKey].accessTag);
  }

  try {
    if (req.method === "GET") {
      if (!listParam || !isRequiredTopicListKey(listParam)) return jsonError(400, "unknown_list");
      const current = easternMonth();
      const from = addMonths(current, -3);
      const to = addMonths(current, 12);
      const rows = await readRange(env, listParam, from, to);
      const byMonth = new Map(rows.map((r) => [r.month.slice(0, 7), r]));
      const months = [];
      for (let m = from; m <= to; m = addMonths(m, 1)) {
        const r = byMonth.get(m);
        months.push({
          month: m,
          topics: r?.topics ?? [],
          updated_at: r?.updated_at ?? null,
          updated_by_email: r?.updated_by_email ?? null
        });
      }
      return json({
        list: listParam,
        label: REQUIRED_TOPIC_LISTS[listParam].label,
        can_edit: await canEdit(listParam),
        current_month: current,
        months
      });
    }

    if (req.method === "PUT") {
      if (!isOriginAllowed(req)) return jsonError(403, "bad_origin");
      let body: { list?: unknown; month?: unknown; topics?: unknown };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return jsonError(400, "bad_json");
      }
      const list = typeof body.list === "string" ? body.list : "";
      if (!isRequiredTopicListKey(list)) return jsonError(400, "unknown_list");
      const month = typeof body.month === "string" && MONTH_RE.test(body.month) ? body.month : null;
      if (!month) return jsonError(400, "bad_month");
      if (!Array.isArray(body.topics)) return jsonError(400, "bad_topics");
      const seen = new Set<string>();
      const topics: string[] = [];
      for (const t of body.topics) {
        if (typeof t !== "string") return jsonError(400, "bad_topics");
        const clean = t.replace(/\s+/g, " ").trim();
        if (!clean) continue;
        if (clean.length > REQUIRED_TOPIC_MAX_LEN) return jsonError(400, "topic_too_long");
        if (seen.has(clean.toLowerCase())) continue;
        seen.add(clean.toLowerCase());
        topics.push(clean);
      }
      if (topics.length > REQUIRED_TOPIC_MAX) return jsonError(400, "too_many_topics");
      if (!(await canEdit(list))) return jsonError(403, "forbidden");
      await writeTopics(env, list, month, topics, { userId: session.userId ?? null, email: session.email });
      return json({ ok: true, month, topics });
    }

    return jsonError(405, "method_not_allowed");
  } catch (err) {
    console.error("[forms.required-topics] admin failed", err);
    return jsonError(500, "required_topics_failed");
  }
}
