// Golden Ticket — shared data access and helpers.
//
// Schema: supabase/golden-ticket-01.sql. Everything reads through the
// service key; none of these tables or the view are exposed to anon.
//
// Two surfaces use this module:
//   admin.js   — CRD work queue API under /admin/jotform/api/golden-ticket/*
//   public.js  — no-login "already won?" lookup at /jotform/golden-ticket/{token}

export const ACCESS_TAG = "golden_ticket";

export const STATUSES = ["new", "in_progress", "done", "void"];

/** Same rule as gt_plate_norm() in SQL. Keep them identical: the lookup
 *  compares this against the view's plate_norm column. */
export function normalizePlate(raw) {
  return String(raw ?? "")
    .replace(/[^A-Za-z0-9]/g, "")
    .toUpperCase();
}

/** Today's date in America/New_York as YYYY-MM-DD. Promos are calendar days
 *  in the business's zone; a win at 9 PM Eastern on the last day counts. */
export function todayEastern() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** An ISO timestamp as Eastern wall-clock "YYYY-MM-DD HH:MM:SS" ("" when
 *  blank or unparseable) -- for the Excel export, whose writer stores the
 *  string as-is with no zone shift. */
export function easternWallClock(iso) {
  const t = Date.parse(String(iso ?? ""));
  if (!Number.isFinite(t)) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date(t));
  const get = (k) => parts.find((p) => p.type === k)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

/** Constant-time string compare (length leak accepted). */
export function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function randomToken(len = 24) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

/**
 * PostgREST call with the service key. Throws on network failure or non-2xx
 * so callers decide between a 500 and a fail-soft default; returns parsed
 * JSON (or null for an empty body).
 */
export async function sb(env, path, { method = "GET", query, body, prefer } = {}) {
  const url = new URL(`/rest/v1/${path}`, env.SUPABASE_URL);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const headers = {
    apikey: env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (prefer) headers.Prefer = prefer;
  const resp = await fetch(url.toString(), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`[golden-ticket] ${method} ${path} -> ${resp.status}: ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : null;
}

export const WIN_COLUMNS = [
  "submission_id",
  "form_id",
  "site_number",
  "site_name",
  "submitted_at",
  "won_on",
  "customer_name",
  "phone",
  "plate",
  "plate_norm",
  "barcode",
  "existing_unlimited",
  "prize",
  "prize_code",
  "ticket_serial",
  "employee_name",
  "photo_url",
  "promo_id",
  "promo_name",
  "status",
  "account_setup",
  "micrologic_tagged",
  "history",
  "crd_updated_at",
  "crd_updated_by",
  "dup_count"
].join(",");

export async function listPromos(env) {
  return (
    (await sb(env, "golden_ticket_promos", {
      query: {
        select: "id,name,starts_on,ends_on,updated_at,updated_by",
        order: "starts_on.desc"
      }
    })) ?? []
  );
}

/** The promo covering `day`, else null. Latest start wins on overlap, the
 *  same tie-break as the view. */
export function promoCovering(promos, day) {
  return (
    promos
      .filter((p) => p.starts_on <= day && day <= p.ends_on)
      .sort((a, b) => (a.starts_on < b.starts_on ? 1 : -1))[0] ?? null
  );
}

/** For the site lookup: the promo running today, else the most recent one
 *  that has already started (late redemptions after an end date still need
 *  checking against the promo they belong to). */
export function lookupPromo(promos, day) {
  return (
    promoCovering(promos, day) ??
    promos
      .filter((p) => p.starts_on <= day)
      .sort((a, b) => (a.ends_on < b.ends_on ? 1 : -1))[0] ??
    null
  );
}

export async function loadSettings(env) {
  const rows = await sb(env, "golden_ticket_settings", {
    query: { id: "eq.1", select: "lookup_token,updated_at,updated_by" }
  });
  return Array.isArray(rows) && rows[0] ? rows[0] : { lookup_token: null };
}

export function lookupPath(token) {
  return token ? `/jotform/golden-ticket/${encodeURIComponent(token)}` : null;
}
