// Supabase cache access for beekeeper-worker.


import {
  createServiceClient,
  filterRosterEligible,
  type SupabaseClient
} from "@splash/db-supabase";
import type { Env } from "./env.js";
import {
  customFieldNumber,
  customFieldString,
  type BeekeeperSchedule,
  type BeekeeperUser
} from "./beekeeper.js";

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
  /** Pay rate from Beekeeper's admin-visibility `rate` custom field. null means
   *  never entered, which is NOT the same as 0 — see USER_COLUMNS. */
  rate: number | null;
  /** Beekeeper `payType`. Observed values: "Salary", "Hourly". */
  pay_type: string | null;
  /** Beekeeper-native deactivation flag. See isRosterEligible. */
  suspended: boolean | null;
  /** Beekeeper `employmentStatus` custom field. Observed: "Active", null. */
  employment_status: string | null;
  /** Last time the sync touched this row. Written on every upsert, so a row
   *  that stops advancing is a user who fell out of the tenant listing. */
  synced_at: string | null;
}

/** Single source of truth for the beekeeper_users select list. Every read of
 *  that table goes through this constant so a column can't be added to the row
 *  type and then silently omitted from one of the queries — which would surface
 *  as an undefined rate on some code paths and a real number on others.
 *
 *  Keep this a SINGLE string literal. postgrest-js parses the select list at
 *  the type level; `"a," + "b"` widens to `string`, which the parser reports
 *  back as `GenericStringError[]`, and that breaks the
 *  `data as BeekeeperUserRow[]` cast at every call site (TS2352 — fails the
 *  Cloudflare deploy typecheck gate). */
const USER_COLUMNS =
  "id,tenantuserid,display_name,firstname,lastname,org_unit_ids,rate,pay_type,suspended,employment_status,synced_at";

export interface BeekeeperScheduleRow {
  schedule_id: string;
  name: string | null;
  location_ids: string[];
  user_ids: string[];
  location_code: string | null;
}

/** Label shown for an open/unassigned shift (no userId). */
export const UNASSIGNED_LABEL = "Unassigned";

/** Best-effort display name from a cache row, falling back through the fields.
 *  `userId` may be absent (open/unassigned shift) — in that case there is no id
 *  to slice, so we return the UNASSIGNED_LABEL instead of crashing. */
export function nameFromRow(
  row: BeekeeperUserRow | undefined,
  userId: string | null | undefined
): string {
  const id = typeof userId === "string" ? userId : "";
  if (!row) return id ? `User ${id.slice(0, 8)}` : UNASSIGNED_LABEL;
  if (row.display_name) return row.display_name;
  const joined = [row.firstname, row.lastname].filter(Boolean).join(" ").trim();
  return joined || (id ? `User ${id.slice(0, 8)}` : UNASSIGNED_LABEL);
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
  ids: Array<string | null | undefined>
): Promise<Map<string, BeekeeperUserRow>> {
  const distinct = [...new Set(ids.filter((id): id is string => !!id))];
  if (distinct.length === 0) return new Map();
  const { data, error } = await sb
    .from("beekeeper_users")
    .select(USER_COLUMNS)
    .in("id", distinct);
  if (error) throw new Error(`getUsersByIds: ${error.message}`);
  const out = new Map<string, BeekeeperUserRow>();
  for (const r of (data as BeekeeperUserRow[]) ?? []) out.set(r.id, r);
  return out;
}

/* ============================================================
 * Roster (assignable employees for a schedule)
 * ============================================================ */

// The rule itself now lives in @splash/db-supabase/beekeeper-roster, because
// the greeter scorecard needs the same answer and a package cannot import from
// an app. It was duplicated there WITHOUT the filter and that picker spent
// months offering departed employees — see that module's header. Re-exported
// here so existing importers of this module keep working, but there is one
// implementation and it is not this file.
export { isRosterEligible, ROSTER_STALE_DAYS } from "@splash/db-supabase";

/**
 * Assignable roster for a schedule: members whose org_unit_ids contains the
 * schedule's primary location, UNION the schedule's own userIds[], minus anyone
 * isRosterEligible rejects. Built from the cache — NOT from whoever currently
 * appears in the grid — so employees with no current shifts are still
 * assignable.
 *
 * The filter is deliberately NOT applied in getUsersByIds: an existing shift
 * assigned to someone who has since left must still render their name rather
 * than degrade to "User 3f2a1b8c". Departed staff stop being assignable; they
 * do not stop being history.
 */
export async function getRoster(
  sb: SupabaseClient,
  primaryLocationId: string | undefined,
  scheduleUserIds: string[]
): Promise<BeekeeperUserRow[]> {
  const byId = new Map<string, BeekeeperUserRow>();

  if (primaryLocationId) {
    // org_unit_ids is JSONB. postgrest-js serializes a JS array as a Postgres
    // array literal (cs.{uuid}), which Postgres tries to parse as JSON and
    // rejects ("invalid input syntax for type json"). Pass a JSON-stringified
    // array so the jsonb-containment form (cs.["uuid"]) is emitted instead.
    const { data, error } = await sb
      .from("beekeeper_users")
      .select(USER_COLUMNS)
      .contains("org_unit_ids", JSON.stringify([primaryLocationId]));
    if (error) throw new Error(`getRoster(location): ${error.message}`);
    for (const r of (data as BeekeeperUserRow[]) ?? []) byId.set(r.id, r);
  }

  const missing = scheduleUserIds.filter((id) => id && !byId.has(id));
  if (missing.length > 0) {
    const extra = await getUsersByIds(sb, missing);
    for (const [id, r] of extra) byId.set(id, r);
  }

  return filterRosterEligible([...byId.values()]).sort((a, b) =>
    nameFromRow(a, a.id).localeCompare(nameFromRow(b, b.id))
  );
}

/* ============================================================
 * Approved-unavailability overlay (read-only)
 * ============================================================ */

/** One approved unavailability submission, raw payload straight from the form.
 *  Field keys are the published form's (see UNAVAILABILITY_FIELD_KEYS in
 *  handlers.ts).  */
export interface UnavailabilityRow {
  id: string;
  payload: Record<string, unknown>;
}

/**
 * Approved unavailability submissions for a location + date window. Reads the
 * shared form_submissions table (same Supabase project) filtered to the mapped
 * form, the denormalized location_code stamped at submit, workflow_stage
 * "approved", and the unavailability DATE inside [startDate, endDate] (inclusive
 * — the grid passes Mon..Sun). The date lives in the JSONB payload, so the
 * bound comparison is a PostgREST `payload->>{key}` text filter (ISO
 * "YYYY-MM-DD" strings sort lexically, so >= / <= are correct).
 */
export async function listApprovedUnavailability(
  sb: SupabaseClient,
  formId: string,
  locationCode: string,
  dateKey: string,
  startDate: string,
  endDate: string
): Promise<UnavailabilityRow[]> {
  const code = locationCode.trim().toLowerCase();
  if (!code) return [];
  const { data, error } = await sb
    .from("form_submissions")
    .select("id,payload")
    .eq("form_id", formId)
    .eq("location_code", code)
    .eq("workflow_stage", "approved")
    .gte(`payload->>${dateKey}`, startDate)
    .lte(`payload->>${dateKey}`, endDate);
  if (error) throw new Error(`listApprovedUnavailability: ${error.message}`);
  return (data as UnavailabilityRow[]) ?? [];
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
      // Both live in Beekeeper's admin-visibility custom_fields, which only the
      // LIST endpoint returns. This sync runs off listAllUsers(), so they are
      // present. If the sync is ever repointed at GET /users/{id} these go
      // null for the entire tenant without any error being raised.
      rate: customFieldNumber(u, "rate"),
      pay_type: customFieldString(u, "payType"),
      employment_status: customFieldString(u, "employmentStatus"),
      // Top-level, not a custom field — Beekeeper's own deactivation flag.
      // Defaults to false rather than null so an older payload shape does not
      // read as "unknown" and quietly change roster eligibility.
      suspended: typeof u.suspended === "boolean" ? u.suspended : false,
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
