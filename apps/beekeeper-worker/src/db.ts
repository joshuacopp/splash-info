// Supabase cache access for beekeeper-worker.


import { createServiceClient, type SupabaseClient } from "@splash/db-supabase";
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

/**
 * How far BEHIND THE MOST RECENT SYNC a user's row may fall before the person
 * is treated as gone. The sync runs daily, so 2 means a user has to be absent
 * from two consecutive tenant listings — enough to ride out one transient
 * pagination hiccup, short enough that a manager isn't scheduling a ghost for a
 * week.
 *
 * Measured against the newest row rather than the wall clock ON PURPOSE. If the
 * cutoff were `now - 2 days`, a sync that stopped running — expired token,
 * broken cron, Beekeeper outage — would age every row past it simultaneously
 * and empty the assignable roster at every location in the company. Comparing
 * rows to each other makes that failure inert: if nothing is syncing, nothing
 * is fresh, the newest row ages in lockstep with the rest, and nobody is
 * dropped. The filter only bites when the sync is demonstrably alive and has
 * chosen not to return someone.
 */
const ROSTER_STALE_DAYS = 2;

/**
 * Whether a cached user still counts as employed here.
 *
 * This matters beyond a tidy dropdown: the schedule grid derives the salaried
 * payroll baseline from the ROSTER, not from shifts, so a departed GM left in
 * this list keeps adding rate x 40 to the week total forever — a wrong number
 * on a screen whose entire job is to be a correct number.
 *
 * Three independent signals, any one of which disqualifies, because none of
 * them is individually trustworthy in this tenant (checked against the full
 * 2026-08-22 user dump, where all ~100 users are suspended:false and
 * employmentStatus "Active" — so neither field has ever been observed in its
 * off state and neither can be confirmed to fire on offboarding):
 *
 *   suspended         Beekeeper-native, set by the platform rather than typed
 *                     by an admin, so it is the one least likely to be
 *                     forgotten. Only `true` disqualifies.
 *   employment_status Admin-typed free text. Only a non-empty value that is not
 *                     "Active" disqualifies — blank means "nobody filled it in",
 *                     which must not silently delete a real employee.
 *   synced_at         The one that actually fires, and the reason the other two
 *                     are not enough. VERIFIED 2026-08-23 against the live
 *                     tenant: GET /users EXCLUDES suspended users entirely.
 *                     Carter Mullen (suspended 2026-08-06, org_unit_ids still
 *                     containing Batavia) returns suspended:true from
 *                     GET /users/{id} but is simply absent from
 *                     GET /users?org_unit_id=<batavia>, which returned exactly
 *                     the 8 people the Beekeeper location UI shows. So the sync
 *                     can never observe suspended:true — a suspended user does
 *                     not come back flagged, they stop coming back at all, and
 *                     the upsert-only sync leaves their row frozen with stale
 *                     org_unit_ids. Falling out of the listing IS the signal.
 *
 * The suspended and employment_status checks are kept anyway: they cost nothing,
 * they catch the case same-day rather than after ROSTER_STALE_DAYS, and if
 * Beekeeper ever starts including deactivated users in the listing (or the
 * tenant starts maintaining employmentStatus) they begin working on their own.
 *
 * A null synced_at passes: rows predate the column and must not vanish before
 * the first sync writes it.
 *
 * `latestSyncMs` is the newest synced_at among the rows being considered — see
 * ROSTER_STALE_DAYS for why the comparison is row-relative and not wall-clock.
 */
export function isRosterEligible(
  row: BeekeeperUserRow,
  latestSyncMs: number | null
): boolean {
  if (row.suspended === true) return false;
  const status = (row.employment_status ?? "").trim().toLowerCase();
  if (status && status !== "active") return false;
  if (latestSyncMs !== null && row.synced_at) {
    const seen = Date.parse(row.synced_at);
    if (
      Number.isFinite(seen) &&
      latestSyncMs - seen > ROSTER_STALE_DAYS * 86_400_000
    ) {
      return false;
    }
  }
  return true;
}

/** Newest synced_at across a set of rows, or null when none carry one. */
function latestSync(rows: Iterable<BeekeeperUserRow>): number | null {
  let max: number | null = null;
  for (const r of rows) {
    if (!r.synced_at) continue;
    const t = Date.parse(r.synced_at);
    if (Number.isFinite(t) && (max === null || t > max)) max = t;
  }
  return max;
}

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

  const rows = [...byId.values()];
  const newest = latestSync(rows);
  return rows
    .filter((r) => isRosterEligible(r, newest))
    .sort((a, b) => nameFromRow(a, a.id).localeCompare(nameFromRow(b, b.id)));
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
