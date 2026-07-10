// Beekeeper Shifts API client.
//
// Base: https://splashcarwashes.us.beekeeper.io/api/2  (the `.us.` DC segment
// is part of the tenant address). Auth: every request carries
//
//     Authorization: Token <bot_token>
//
// The scheme word is the literal `Token`, NOT `Bearer`. The token is a
// Wrangler secret held only by the Worker (env.BEEKEEPER_TOKEN).
//
// Writes send `?notify=false` so real staff aren't push-notified — the caller
// decides whether to override this once the flow is trusted in production.
//
// Only ~4 months of shift history is retained upstream; callers must bound
// their read windows accordingly.

import { resolveBeekeeperBaseUrl, type Env } from "./env.js";

/* ============================================================
 * Upstream shapes (real shape observed against the live tenant)
 * ============================================================ */

/** A Beekeeper shift. Shifts reference `userId` (internal UUID) only — no name
 *  is embedded; resolve names via the beekeeper_users cache. `userId` is absent
 *  on OPEN/UNASSIGNED shifts (a first-class Beekeeper concept), so it is
 *  optional here — never assume it's present. */
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

/** In practice the tenant only uses `color` (occasionally `description`). The
 *  docs imply location/type keys — the tenant doesn't populate them. */
export interface BeekeeperShiftMetadata {
  color?: string;
  description?: string;
  [k: string]: unknown;
}

/** A Beekeeper schedule (the location/schedule picker). There is NO
 *  /locations route — schedules ARE the location list. */
export interface BeekeeperSchedule {
  id: string;
  name: string;
  metadata?: Record<string, unknown>;
  groupIds?: string[];
  userIds?: string[];
  locationIds?: string[];
}

/** A Beekeeper user. `tenantuserid` (lowercase) is the dashboard User-ID;
 *  everything in the tenant is keyed by the internal `id` UUID. */
export interface BeekeeperUser {
  id: string;
  tenantuserid?: string;
  display_name?: string;
  firstname?: string;
  lastname?: string;
  /** Location UUIDs the user belongs to. */
  org_unit_ids?: string[];
}

/** Body accepted by create/update. `id` is generated app-side (stable +
 *  meaningful). `tenantUserId` is intentionally omitted — the tenant keys
 *  everything by `userId`, and sending tenantUserId invites the
 *  tenantuserid/tenantUserId casing mismatch. */
export interface ShiftWriteBody {
  id: string;
  /** Omitted entirely for an OPEN/UNASSIGNED shift (matches how the tenant
   *  returns open shifts on read — with no userId field at all). */
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

/** Thrown on any non-2xx upstream response. Carries the status so handlers can
 *  map it to a sensible client status (e.g. surface a 409 overlap cleanly). */
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
    // Literal `Token` scheme — NOT `Bearer`.
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

/**
 * GET /shifts/schedules/{scheduleId}/shifts?after={ISO}&before={ISO}
 * The window params are `after`/`before` (confirmed against the live tenant +
 * docs, 2026-07-10). Plain UTC (…Z) is accepted — no TZ-offset conversion
 * needed. `start`/`end` are silently ignored, which is why an unfiltered call
 * returns the full ~4-month retention; passing after/before filters upstream.
 * Only ~4 months of history is retained regardless.
 */
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

/**
 * GET /users?limit={n}&offset={n} — paginated. Tenant-wide (~80 sites), so
 * prefer the beekeeper_users Supabase cache for name resolution; this is the
 * sync path (and cache-miss fallback).
 */
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
