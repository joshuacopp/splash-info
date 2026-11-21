// Giveaways -- data access (supabase/giveaways-01.sql). Direct PostgREST with
// the service key, like the rest of this worker.

import {
  readGiveawayFields,
  type GiveawayEntry,
  type GiveawayFields,
  type GiveawaySettings,
  type GiveawaySmsConsent
} from "@splash/forms-schema";
import type { Env } from "../index.js";

const headers = (env: Env): Record<string, string> => ({
  apikey: env.SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
});

export interface Giveaway {
  id: string;
  token: string;
  title: string;
  prize: string | null;
  starts_on: string | null;
  ends_on: string | null;
  fields: GiveawayFields;
  sms_consent: GiveawaySmsConsent;
  one_per_person: boolean;
  archived_at: string | null;
  created_at: string;
  created_by_email: string | null;
  updated_at: string;
  updated_by_email: string | null;
}

const COLS =
  "id,token,title,prize,starts_on,ends_on,fields,sms_consent,one_per_person,archived_at,created_at,created_by_email,updated_at,updated_by_email";

type Row = Omit<Giveaway, "fields"> & { fields: unknown };

function fromRow(r: Row): Giveaway {
  return { ...r, fields: readGiveawayFields(r.fields) };
}

async function get<T>(env: Env, table: string, params: Record<string, string>): Promise<T[]> {
  const url = new URL(`/rest/v1/${table}`, env.SUPABASE_URL);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const resp = await fetch(url.toString(), { headers: headers(env) });
  if (!resp.ok) throw new Error(`[giveaways] read ${table} ${resp.status}`);
  return (await resp.json()) as T[];
}

/** 24 URL-safe characters (144 random bits). */
export function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function getGiveawayByToken(env: Env, token: string): Promise<Giveaway | null> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const rows = await get<Row>(env, "giveaways", { select: COLS, token: `eq.${token}`, limit: "1" });
  return rows[0] ? fromRow(rows[0]) : null;
}

export async function getGiveaway(env: Env, id: string): Promise<Giveaway | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const rows = await get<Row>(env, "giveaways", { select: COLS, id: `eq.${id}`, limit: "1" });
  return rows[0] ? fromRow(rows[0]) : null;
}

export async function listGiveaways(env: Env): Promise<Giveaway[]> {
  return (await get<Row>(env, "giveaways", { select: COLS, order: "created_at.desc", limit: "500" })).map(fromRow);
}

/** Exact row count for a filter (Prefer: count=exact, no rows fetched). */
async function countRows(env: Env, table: string, params: Record<string, string>): Promise<number> {
  const url = new URL(`/rest/v1/${table}`, env.SUPABASE_URL);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("select", "id");
  url.searchParams.set("limit", "0");
  const resp = await fetch(url.toString(), { headers: { ...headers(env), Prefer: "count=exact" } });
  if (!resp.ok) throw new Error(`[giveaways] count ${table} ${resp.status}`);
  const total = /\/(\d+)$/.exec(resp.headers.get("Content-Range") ?? "")?.[1];
  return total ? Number(total) : 0;
}

/** Entry and SMS opt-in counts for one giveaway. Counted, never by reading
 *  rows: PostgREST returns at most 1000 rows per request (db-max-rows). */
export async function entryCounts(env: Env, giveawayId: string): Promise<{ entries: number; sms: number }> {
  const [entries, sms] = await Promise.all([
    countRows(env, "giveaway_entries", { giveaway_id: `eq.${giveawayId}` }),
    countRows(env, "giveaway_entries", { giveaway_id: `eq.${giveawayId}`, sms_consent: "eq.true" })
  ]);
  return { entries, sms };
}

export async function createGiveaway(env: Env, s: GiveawaySettings, by: string): Promise<Giveaway> {
  const url = new URL("/rest/v1/giveaways", env.SUPABASE_URL);
  const resp = await fetch(url.toString(), {
    method: "POST",
    headers: { ...headers(env), "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify({ ...s, token: newToken(), created_by_email: by, updated_by_email: by })
  });
  if (!resp.ok) throw new Error(`[giveaways] create ${resp.status} ${(await resp.text()).slice(0, 200)}`);
  const rows = (await resp.json()) as Row[];
  return fromRow(rows[0]!);
}

export async function patchGiveaway(env: Env, id: string, patch: Record<string, unknown>, by: string): Promise<boolean> {
  const url = new URL("/rest/v1/giveaways", env.SUPABASE_URL);
  url.searchParams.set("id", `eq.${id}`);
  const resp = await fetch(url.toString(), {
    method: "PATCH",
    headers: { ...headers(env), "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString(), updated_by_email: by })
  });
  if (!resp.ok) throw new Error(`[giveaways] patch ${resp.status} ${(await resp.text()).slice(0, 200)}`);
  return ((await resp.json()) as unknown[]).length > 0;
}

const ENTRY_COLS = "id,created_at,site_number,site_name,name,email,phone,plate,barcode,sms_consent";

/** Every entry, newest first, paged 1000 at a time (the PostgREST cap) up to
 *  ENTRY_CAP. `capped` says the list stopped there. */
export const ENTRY_CAP = 20000;

export async function listEntries(env: Env, giveawayId: string): Promise<{ entries: GiveawayEntry[]; capped: boolean }> {
  const out: GiveawayEntry[] = [];
  const PAGE = 1000;
  for (let offset = 0; offset < ENTRY_CAP; offset += PAGE) {
    const page = await get<GiveawayEntry>(env, "giveaway_entries", {
      select: ENTRY_COLS,
      giveaway_id: `eq.${giveawayId}`,
      order: "created_at.desc,id.desc",
      limit: String(PAGE),
      offset: String(offset)
    });
    out.push(...page);
    if (page.length < PAGE) return { entries: out, capped: false };
  }
  return { entries: out, capped: true };
}

export async function deleteEntry(env: Env, giveawayId: string, entryId: string): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(entryId)) return false;
  const url = new URL("/rest/v1/giveaway_entries", env.SUPABASE_URL);
  url.searchParams.set("id", `eq.${entryId}`);
  url.searchParams.set("giveaway_id", `eq.${giveawayId}`);
  const resp = await fetch(url.toString(), {
    method: "DELETE",
    headers: { ...headers(env), Prefer: "return=representation" }
  });
  if (!resp.ok) throw new Error(`[giveaways] delete entry ${resp.status}`);
  return ((await resp.json()) as unknown[]).length > 0;
}

export interface NewEntry {
  giveaway_id: string;
  site_number: number | null;
  site_name: string | null;
  name: string | null;
  email: string | null;
  phone: string | null;
  plate: string | null;
  barcode: string | null;
  sms_consent: boolean;
  sms_consent_text: string | null;
  ip: string | null;
  user_agent: string | null;
}

/** Which of the entry's identifiers already appear in this giveaway (one-per-person). */
export async function findDuplicate(
  env: Env,
  e: Pick<NewEntry, "giveaway_id" | "phone" | "email" | "plate" | "barcode">
): Promise<"phone" | "email" | "plate" | "barcode" | null> {
  const ors: string[] = [];
  // Every value is validated before this (digits / [A-Z0-9] / a checked email /
  // the barcode's limited character set -- no quotes, commas or parentheses),
  // and the two that may hold dots are quoted for or=(...).
  if (e.phone) ors.push(`phone.eq.${e.phone}`);
  if (e.plate) ors.push(`plate.eq.${e.plate}`);
  if (e.email) ors.push(`email.eq."${e.email}"`);
  if (e.barcode) ors.push(`barcode.eq."${e.barcode}"`);
  if (ors.length === 0) return null;
  const rows = await get<{ phone: string | null; email: string | null; plate: string | null; barcode: string | null }>(
    env,
    "giveaway_entries",
    { select: "phone,email,plate,barcode", giveaway_id: `eq.${e.giveaway_id}`, or: `(${ors.join(",")})`, limit: "1" }
  );
  const r = rows[0];
  if (!r) return null;
  if (e.phone && r.phone === e.phone) return "phone";
  if (e.email && r.email === e.email) return "email";
  if (e.plate && r.plate === e.plate) return "plate";
  if (e.barcode && r.barcode === e.barcode) return "barcode";
  return e.phone ? "phone" : e.email ? "email" : e.plate ? "plate" : "barcode";
}

export async function insertEntry(env: Env, e: NewEntry): Promise<void> {
  const url = new URL("/rest/v1/giveaway_entries", env.SUPABASE_URL);
  const resp = await fetch(url.toString(), {
    method: "POST",
    headers: { ...headers(env), "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify(e)
  });
  if (!resp.ok) throw new Error(`[giveaways] insert entry ${resp.status} ${(await resp.text()).slice(0, 200)}`);
}

/** Today's date in Eastern time, YYYY-MM-DD. */
export function easternToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export type GiveawayState = "open" | "not_started" | "ended" | "archived";

export function giveawayState(g: Pick<Giveaway, "starts_on" | "ends_on" | "archived_at">, today: string): GiveawayState {
  if (g.archived_at) return "archived";
  if (g.starts_on && today < g.starts_on) return "not_started";
  if (g.ends_on && today > g.ends_on) return "ended";
  return "open";
}
