// Beekeeper Shifts API client.
//
// Base: https://splashcarwashes.us.beekeeper.io/api/2  
// 
// Auth: every request carries
//
//     Authorization: Token <bot_token>
//
// The scheme word is the literal `Token`, NOT `Bearer`. The token is a
// Wrangler secret held only by the Worker (env.BEEKEEPER_TOKEN).
//
// Writes send `?notify=false` so staff aren't push-notified on all updates
//


import { resolveBeekeeperBaseUrl, type Env } from "./env.js";

/* ============================================================
 * Upstream shapes (real shape observed against the live tenant)
 * ============================================================ */

/** Shifts reference `userId` (internal UUID) only — no name
 *  is embedded; resolve names via the beekeeper_users cache. `userId` is absent
 *  on OPEN/UNASSIGNED shifts  */
export interface BeekeeperShift {
  id: string;
  userId?: string;
  scheduleId: string;
  /** ISO-8601 UTC (…Z). */
  start: string;
  /** ISO-8601 UTC (…Z). */
  end: string;
  title: string;
  metadata?: BeekeeperShiftMetadata;
  labels?: unknown[];
  blocks?: Record<string, unknown>;
  shiftManagerIds?: string[];
}


export interface BeekeeperShiftMetadata {
  color?: string;
  description?: string;
  [k: string]: unknown;
}


export interface BeekeeperSchedule {
  id: string;
  name: string;
  metadata?: Record<string, unknown>;
  groupIds?: string[];
  userIds?: string[];
  locationIds?: string[];
}


/**
 * One entry of a user's `custom_fields`. Beekeeper returns these as an ARRAY of
 * objects keyed by `key` — NOT as a keyed map — so reading one is a find(), not
 * a property access. See `customField` below.
 *
 * `visibility` is "public" or "admin", and that distinction is load-bearing:
 * GET /users/{id} strips every admin-visibility entry, while GET /users?limit=
 * returns all of them with the same bot token. Verified against both a tablet
 * "Location Profile" account and a human General Manager, so it is a property
 * of the endpoint, not of the user or the token. Anything read out of here must
 * therefore come from listUsers/listAllUsers, which is what the sync path uses.
 */
export interface BeekeeperCustomField {
  key: string;
  label?: string;
  required?: boolean;
  type?: string;
  value?: unknown;
  visibility?: "public" | "admin" | string;
  editable?: boolean;
}

export interface BeekeeperUser {
  id: string;
  tenantuserid?: string;
  display_name?: string;
  firstname?: string;
  lastname?: string;
  /** Location UUIDs the user belongs to. */
  org_unit_ids?: string[];
  /**
   * Beekeeper-native deactivation flag (top level, NOT a custom field, and
   * present on every user on both endpoints). Distinct from `state`, which
   * tracks the login lifecycle ("created" | "invited" | "active") and says
   * nothing about employment — a never-onboarded new hire is "created" and
   * very much still on payroll.
   */
  suspended?: boolean;
  /** ISO timestamp of suspension, null while active. */
  suspended_at?: string | null;
  /** Present on LIST reads only — see BeekeeperCustomField. */
  custom_fields?: BeekeeperCustomField[];
}

/** Raw entry for `key`, or undefined. Note that "the field does not exist" and
 *  "this endpoint stripped it" are indistinguishable here. */
export function customField(
  user: BeekeeperUser,
  key: string
): BeekeeperCustomField | undefined {
  if (!Array.isArray(user.custom_fields)) return undefined;
  return user.custom_fields.find((f) => f && f.key === key);
}

/**
 * Numeric custom field, or null when unset / blank / unparseable.
 *
 * Beekeeper declares `rate` as type "number" but has been seen returning
 * numeric values as JSON strings on some profiles, so a numeric string is
 * accepted. An empty string maps to null, NOT to 0: an unentered rate is
 * unknown cost, and collapsing it to zero is exactly what would make an
 * unpriced day look cheap instead of incomplete.
 */
export function customFieldNumber(
  user: BeekeeperUser,
  key: string
): number | null {
  const raw = customField(user, key)?.value;
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** String custom field, trimmed, or null when unset/blank. */
export function customFieldString(
  user: BeekeeperUser,
  key: string
): string | null {
  const raw = customField(user, key)?.value;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed || null;
}


export interface ShiftWriteBody {
  id: string;
  /** Omitted entirely for an OPEN/UNASSIGNED shift (matches how the tenant
   *  returns open shifts on read — no userID field. */
  userId?: string;
  scheduleId: string;
  start: string;
  end: string;
  title: string;
  metadata?: BeekeeperShiftMetadata;
  labels?: unknown[];
  blocks?: Record<string, unknown>;
  shiftManagerIds?: string[];
}


export class BeekeeperError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string
  ) {
    super(message);
    this.name = "BeekeeperError";
  }
}

/* ============================================================
 * Low-level fetch
 * ============================================================ */

type Query = Record<string, string | number | boolean | undefined>;

function buildUrl(base: string, path: string, query?: Query): string {
  const url = new URL(base.replace(/\/+$/, "") + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

async function bkFetch<T>(
  env: Env,
  method: string,
  path: string,
  opts: { query?: Query; body?: unknown } = {}
): Promise<T> {
  const base = resolveBeekeeperBaseUrl(env);
  const url = buildUrl(base, path, opts.query);

  const headers: Record<string, string> = {

    Authorization: `Token ${env.BEEKEEPER_TOKEN}`,
    Accept: "application/json"
  };
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(opts.body);
  }

  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) {
    throw new BeekeeperError(
      `Beekeeper ${method} ${path} -> ${res.status}`,
      res.status,
      text
    );
  }
  // DELETE and some writes may return an empty body.
  if (!text) return undefined as unknown as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined as unknown as T;
  }
}

/* ============================================================
 * Reads
 * ============================================================ */

/** GET /shifts/schedules — all schedules (the location/schedule picker). */
export function listSchedules(env: Env): Promise<BeekeeperSchedule[]> {
  return bkFetch<BeekeeperSchedule[]>(env, "GET", "/shifts/schedules");
}

/** GET /shifts/schedules/{scheduleId} — one schedule object. */
export function getSchedule(
  env: Env,
  scheduleId: string
): Promise<BeekeeperSchedule> {
  return bkFetch<BeekeeperSchedule>(
    env,
    "GET",
    `/shifts/schedules/${encodeURIComponent(scheduleId)}`
  );
}


export function listShifts(
  env: Env,
  scheduleId: string,
  startIso: string,
  endIso: string
): Promise<BeekeeperShift[]> {
  return bkFetch<BeekeeperShift[]>(
    env,
    "GET",
    `/shifts/schedules/${encodeURIComponent(scheduleId)}/shifts`,
    { query: { after: startIso, before: endIso } }
  );
}


export function listUsers(
  env: Env,
  limit: number,
  offset: number
): Promise<BeekeeperUser[]> {
  return bkFetch<BeekeeperUser[]>(env, "GET", "/users", {
    query: { limit, offset }
  });
}

/** Drain the whole /users pagination into a single array. Stops when a page
 *  returns fewer than `pageSize` rows (or an empty page). Guard-capped so a
 *  bad upstream can't loop forever. */
export async function listAllUsers(
  env: Env,
  pageSize = 200,
  maxPages = 100
): Promise<BeekeeperUser[]> {
  const out: BeekeeperUser[] = [];
  for (let page = 0; page < maxPages; page++) {
    const batch = await listUsers(env, pageSize, page * pageSize);
    if (!Array.isArray(batch) || batch.length === 0) break;
    out.push(...batch);
    if (batch.length < pageSize) break;
  }
  return out;
}

/* ============================================================
 * Writes — all send ?notify=false while the flow is being trusted.
 * ============================================================ */

/** POST /shifts/schedules/{scheduleId}/shifts?notify=false — add a shift. */
export function createShift(
  env: Env,
  scheduleId: string,
  body: ShiftWriteBody,
  notify = false
): Promise<BeekeeperShift> {
  return bkFetch<BeekeeperShift>(
    env,
    "POST",
    `/shifts/schedules/${encodeURIComponent(scheduleId)}/shifts`,
    { query: { notify }, body }
  );
}

/**
 * PUT /shifts/schedules/{scheduleId}/shifts/{shiftId}?notify=false — edit.
 * PUT is a FULL REPLACE: send the whole object, not a partial patch.
 */
export function updateShift(
  env: Env,
  scheduleId: string,
  shiftId: string,
  body: ShiftWriteBody,
  notify = false
): Promise<BeekeeperShift> {
  return bkFetch<BeekeeperShift>(
    env,
    "PUT",
    `/shifts/schedules/${encodeURIComponent(scheduleId)}/shifts/${encodeURIComponent(shiftId)}`,
    { query: { notify }, body }
  );
}

/**
 * DELETE /shifts/schedules/{scheduleId}/shifts/{shiftId}?notify=false.
 * VERIFY: conventional route, not yet exercised against the tenant. If the
 * tenant rejects it, the fallback is a PUT that moves the shift out of range
 * or a tombstone convention — revisit once confirmed.
 */
export function deleteShift(
  env: Env,
  scheduleId: string,
  shiftId: string,
  notify = false
): Promise<void> {
  return bkFetch<void>(
    env,
    "DELETE",
    `/shifts/schedules/${encodeURIComponent(scheduleId)}/shifts/${encodeURIComponent(shiftId)}`,
    { query: { notify } }
  );
}
