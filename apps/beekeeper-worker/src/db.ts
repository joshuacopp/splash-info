// Supabase cache access for beekeeper-worker.
//
// Reads/writes the beekeeper_users + beekeeper_schedules tables (created by
// 20260710_beekeeper_shift_worker.sql) via the shared service-role client.
// Name resolution and the roster are served from here so the read path never
// scans the tenant-wide /users endpoint live (the sync keeps the cache warm).

import { createServiceClient, type SupabaseClient } from "@splash/db-supabase";
import type { Env } from "./env.js";
import type { BeekeeperSchedule, BeekeeperUser } from "./beekeeper.js";

export function sbClient(env: Env): SupabaseClient {
  return createServiceClient(env);
}

/* ============================================================
 * Row shapes
 * ============================================================ */

export interface BeekeeperUserRow {
  id: string;
  tenantuserid: string | null;
  display_name: string | null;
  firstname: string | null;
  lastname: string | null;
  org_unit_ids: string[];
}

export interface BeekeeperScheduleRow {
  schedule_id: string;
  name: string | null;
  location_ids: string[];
  user_ids: string[];
  location_code: string | null;
}

/** Best-effort display name from a cache row, falling back through the fields. */
export function nameFromRow(row: BeekeeperUserRow | undefined, userId: string): string {
  if (!row) return `User ${userId.slice(0, 8)}`;
  if (row.display_name) return row.display_name;
  const joined = [row.firstname, row.lastname].filter(Boolean).join(" ").trim();
  return joined || `User ${userId.slice(0, 8)}`;
}

/* ============================================================
 * Schedule <-> location_code mapping (drives the route)
 * ============================================================ */

/** Resolve the Splash location_code -> the mapped Beekeeper schedule row. */
export async function resolveScheduleByLocationCode(
  sb: SupabaseClient,
  locationCode: string
): Promise<BeekeeperScheduleRow | null> {
  const code = locationCode.trim().toLowerCase();
  if (!code) return null;
  const { data, error } = await sb
    .from("beekeeper_schedules")
    .select("schedule_id,name,location_ids,user_ids,location_code")
    .eq("location_code", code)
    .limit(1);
  if (error) throw new Error(`resolveScheduleByLocationCode: ${error.message}`);
  return (data?.[0] as BeekeeperScheduleRow | undefined) ?? null;
}

/** One schedule row by its Beekeeper schedule id. */
export async function getScheduleRow(
  sb: SupabaseClient,
  scheduleId: string
): Promise<BeekeeperScheduleRow | null> {
  const { data, error } = await sb
    .from("beekeeper_schedules")
    .select("schedule_id,name,location_ids,user_ids,location_code")
    .eq("schedule_id", scheduleId)
    .limit(1);
  if (error) throw new Error(`getScheduleRow: ${error.message}`);
  return (data?.[0] as BeekeeperScheduleRow | undefined) ?? null;
}

/** All schedules that have been mapped to a Splash location_code (the picker). */
export async function listMappedSchedules(
  sb: SupabaseClient
): Promise<BeekeeperScheduleRow[]> {
  const { data, error } = await sb
    .from("beekeeper_schedules")
    .select("schedule_id,name,location_ids,user_ids,location_code")
    .not("location_code", "is", null)
    .order("name", { ascending: true });
  if (error) throw new Error(`listMappedSchedules: ${error.message}`);
  return (data as BeekeeperScheduleRow[]) ?? [];
}

/* ============================================================
 * Name resolution
 * ============================================================ */

/** Bulk-resolve users by id for a shift list. Empty input -> empty Map. */
export async function getUsersByIds(
  sb: SupabaseClient,
  ids: string[]
): Promise<Map<string, BeekeeperUserRow>> {
  const distinct = [...new Set(ids.filter(Boolean))];
  if (distinct.length === 0) return new Map();
  const { data, error } = await sb
    .from("beekeeper_users")
    .select("id,tenantuserid,display_name,firstname,lastname,org_unit_ids")
    .in("id", distinct);
  if (error) throw new Error(`getUsersByIds: ${error.message}`);
  const out = new Map<string, BeekeeperUserRow>();
  for (const r of (data as BeekeeperUserRow[]) ?? []) out.set(r.id, r);
  return out;
}

/* ============================================================
 * Roster (assignable employees for a schedule)
 * ============================================================ */

/**
 * Assignable roster for a schedule: members whose org_unit_ids contains the
 * schedule's primary location, UNION the schedule's own userIds[]. Built from
 * the cache — NOT from whoever currently appears in the grid — so employees
 * with no current shifts are still assignable.
 */
export async function getRoster(
  sb: SupabaseClient,
  primaryLocationId: string | undefined,
  scheduleUserIds: string[]
): Promise<BeekeeperUserRow[]> {
  const byId = new Map<string, BeekeeperUserRow>();

  if (primaryLocationId) {
    const { data, error } = await sb
      .from("beekeeper_users")
      .select("id,tenantuserid,display_name,firstname,lastname,org_unit_ids")
      .contains("org_unit_ids", [primaryLocationId]);
    if (error) throw new Error(`getRoster(location): ${error.message}`);
    for (const r of (data as BeekeeperUserRow[]) ?? []) byId.set(r.id, r);
  }

  const missing = scheduleUserIds.filter((id) => id && !byId.has(id));
  if (missing.length > 0) {
    const extra = await getUsersByIds(sb, missing);
    for (const [id, r] of extra) byId.set(id, r);
  }

  return [...byId.values()].sort((a, b) =>
    nameFromRow(a, a.id).localeCompare(nameFromRow(b, b.id))
  );
}

/* ============================================================
 * Sync upserts (Beekeeper-owned columns only)
 * ============================================================ */

export async function upsertBeekeeperUsers(
  sb: SupabaseClient,
  users: BeekeeperUser[]
): Promise<number> {
  const rows = users
    .filter((u) => typeof u.id === "string" && u.id.length > 0)
    .map((u) => ({
      id: u.id,
      tenantuserid: u.tenantuserid ?? null,
      display_name: u.display_name ?? null,
      firstname: u.firstname ?? null,
      lastname: u.lastname ?? null,
      org_unit_ids: Array.isArray(u.org_unit_ids) ? u.org_unit_ids : [],
      synced_at: new Date().toISOString()
    }));
  if (rows.length === 0) return 0;
  // Chunk to stay under PostgREST payload limits on the ~80-site tenant.
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await sb
      .from("beekeeper_users")
      .upsert(rows.slice(i, i + CHUNK), { onConflict: "id" });
    if (error) throw new Error(`upsertBeekeeperUsers: ${error.message}`);
  }
  return rows.length;
}

/** Upsert Beekeeper-owned schedule columns. NEVER writes location_code — that
 *  is the operator-set Splash mapping and must survive syncs. */
export async function upsertBeekeeperSchedules(
  sb: SupabaseClient,
  schedules: BeekeeperSchedule[]
): Promise<number> {
  const rows = schedules
    .filter((s) => typeof s.id === "string" && s.id.length > 0)
    .map((s) => ({
      schedule_id: s.id,
      name: s.name ?? null,
      location_ids: Array.isArray(s.locationIds) ? s.locationIds : [],
      user_ids: Array.isArray(s.userIds) ? s.userIds : [],
      synced_at: new Date().toISOString()
    }));
  if (rows.length === 0) return 0;
  const { error } = await sb
    .from("beekeeper_schedules")
    .upsert(rows, { onConflict: "schedule_id" });
  if (error) throw new Error(`upsertBeekeeperSchedules: ${error.message}`);
  return rows.length;
}
