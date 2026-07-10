// JSON API handlers for beekeeper-worker.
//
// Everything is keyed by Splash `location_code` (never the raw Beekeeper
// scheduleId) so the per-location auth scope is enforced at the door and the
// UI never has to know Beekeeper's internal ids. Each handler:
//   1. scheduleGate  — authenticate + (schedule|pricing) grant
//   2. userCanAccessLocation(session, location_code) — per-location scope
//   3. resolveScheduleByLocationCode — location_code -> Beekeeper schedule row
//
// Reads join the beekeeper_users cache for names and convert UTC -> ET for
// display. Writes convert the four ET dropdown values -> UTC, auto-generate the
// title, validate (overlap / title / ISO) BEFORE calling Beekeeper, send
// notify=false, and audit to sysadmin_audit_log.

import { isOriginAllowed, json, jsonError } from "@splash/http";
import { logSysadminAudit, type SupabaseClient } from "@splash/db-supabase";
import type { Session } from "@splash/types/session";
import {
  createShift,
  deleteShift,
  listShifts,
  updateShift,
  type BeekeeperShift,
  BeekeeperError,
  type ShiftWriteBody
} from "./beekeeper.js";
import {
  getRoster,
  getUsersByIds,
  nameFromRow,
  resolveScheduleByLocationCode,
  type BeekeeperScheduleRow
} from "./db.js";
import { scheduleGate, userCanAccessLocation } from "./auth.js";
import { runBeekeeperSync } from "./sync.js";
import {
  addDays,
  buildShiftTimes,
  generateTitle,
  utcIsoToLocalParts,
  MAX_TITLE_LEN
} from "./time.js";
import { validateShift, type ProposedShift } from "./validation.js";
import type { Env } from "./env.js";

/* ============================================================
 * Shared gate + resolve
 * ============================================================ */

interface ResolvedContext {
  session: Session;
  sb: SupabaseClient;
  schedule: BeekeeperScheduleRow;
}

type GateResolve =
  | { ok: true; ctx: ResolvedContext }
  | { ok: false; response: Response };

/** Run the full gate for a location_code-scoped request and resolve the mapped
 *  schedule row. Single choke point for auth + scope + mapping. */
async function gateAndResolve(
  request: Request,
  env: Env,
  locationCode: string
): Promise<GateResolve> {
  const gate = await scheduleGate(request, env);
  if (!gate.ok) return { ok: false, response: gate.response };
  if (!userCanAccessLocation(gate.session, locationCode)) {
    return { ok: false, response: jsonError(403, "forbidden") };
  }
  const schedule = await resolveScheduleByLocationCode(gate.sb, locationCode);
  if (!schedule) {
    return { ok: false, response: jsonError(404, `No schedule mapped for "${locationCode}"`) };
  }
  return { ok: true, ctx: { session: gate.session, sb: gate.sb, schedule } };
}

/* ============================================================
 * Read: context (schedule meta + roster)
 * ============================================================ */

/**
 * GET /api/loc/{location_code}/context
 *   200 { locationCode, scheduleId, name, roster: [{ id, name }] }
 * The UI's first call — resolves the location and loads the assignable roster
 * (cache-built, so employees with no current shifts are still assignable).
 */
export async function handleContext(
  request: Request,
  env: Env,
  locationCode: string
): Promise<Response> {
  const g = await gateAndResolve(request, env, locationCode);
  if (!g.ok) return g.response;
  const { schedule, sb } = g.ctx;

  const primaryLocationId = schedule.location_ids?.[0];
  const roster = await getRoster(sb, primaryLocationId, schedule.user_ids ?? []);

  return json({
    locationCode: schedule.location_code,
    scheduleId: schedule.schedule_id,
    name: schedule.name,
    roster: roster.map((r) => ({ id: r.id, name: nameFromRow(r, r.id) }))
  });
}

/* ============================================================
 * Read: shifts in a window (names + ET)
 * ============================================================ */

interface ShiftView {
  id: string;
  userId: string;
  userName: string;
  title: string;
  /** Raw UTC (…Z) for round-tripping edits. */
  startUtc: string;
  endUtc: string;
  /** ET calendar/clock parts for display + dropdown prefill. */
  startDate: string;
  startHour: number;
  startMinute: number;
  endDate: string;
  endHour: number;
  endMinute: number;
}

function toShiftView(shift: BeekeeperShift, userName: string): ShiftView {
  const s = utcIsoToLocalParts(shift.start);
  const e = utcIsoToLocalParts(shift.end);
  return {
    id: shift.id,
    userId: shift.userId,
    userName,
    title: shift.title,
    startUtc: shift.start,
    endUtc: shift.end,
    startDate: s.date,
    startHour: s.hour,
    startMinute: s.minute,
    endDate: e.date,
    endHour: e.hour,
    endMinute: e.minute
  };
}

/**
 * GET /api/loc/{location_code}/shifts?start={ISO}&end={ISO}
 *   200 { shifts: ShiftView[] }
 * start/end are ISO-8601 UTC. Names resolved from the beekeeper_users cache.
 */
export async function handleListShifts(
  request: Request,
  env: Env,
  locationCode: string
): Promise<Response> {
  const g = await gateAndResolve(request, env, locationCode);
  if (!g.ok) return g.response;
  const { schedule, sb } = g.ctx;

  const url = new URL(request.url);
  const start = url.searchParams.get("start");
  const end = url.searchParams.get("end");
  if (!start || !end) return jsonError(400, "start and end (ISO-8601 UTC) are required");

  let shifts: BeekeeperShift[];
  try {
    shifts = await listShifts(env, schedule.schedule_id, start, end);
  } catch (err) {
    return mapBeekeeperError(err);
  }

  const names = await getUsersByIds(sb, shifts.map((s) => s.userId));
  const views = shifts.map((s) => toShiftView(s, nameFromRow(names.get(s.userId), s.userId)));
  return json({ shifts: views });
}

/* ============================================================
 * Write: create / update / delete
 * ============================================================ */

interface ShiftWriteInput {
  userId: string;
  /** Local ET calendar date of START, "YYYY-MM-DD". */
  date: string;
  startHour: number;
  startMinute: number;
  endHour: number;
  endMinute: number;
  /** Optional override; auto-generated from the times when absent/blank. */
  title?: string;
}

function parseWriteInput(raw: unknown): ShiftWriteInput | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === "number" ? v : Number(v));
  const input: ShiftWriteInput = {
    userId: String(o.userId ?? ""),
    date: String(o.date ?? ""),
    startHour: num(o.startHour),
    startMinute: num(o.startMinute),
    endHour: num(o.endHour),
    endMinute: num(o.endMinute),
    title: typeof o.title === "string" ? o.title : undefined
  };
  const nums = [input.startHour, input.startMinute, input.endHour, input.endMinute];
  if (nums.some((n) => !Number.isInteger(n) || n < 0)) return null;
  if (input.startHour > 23 || input.endHour > 23) return null;
  if (input.startMinute > 59 || input.endMinute > 59) return null;
  return input;
}

/** Fetch the schedule's shifts across a window that safely covers the proposed
 *  instant (one day of slack each side) so overnight overlaps are caught. */
async function existingForOverlap(
  env: Env,
  scheduleId: string,
  startDate: string
): Promise<BeekeeperShift[]> {
  const from = `${addDays(startDate, -1)}T00:00:00Z`;
  const to = `${addDays(startDate, 2)}T00:00:00Z`;
  return listShifts(env, scheduleId, from, to);
}

/** Build the write body + run validation. Returns the body or an error Response. */
async function buildAndValidate(
  env: Env,
  schedule: BeekeeperScheduleRow,
  input: ShiftWriteInput,
  shiftId: string,
  editingId?: string
): Promise<{ ok: true; body: ShiftWriteBody } | { ok: false; response: Response }> {
  const times = buildShiftTimes({
    date: input.date,
    startHour: input.startHour,
    startMinute: input.startMinute,
    endHour: input.endHour,
    endMinute: input.endMinute
  });
  const title =
    input.title && input.title.trim().length > 0
      ? input.title.trim().slice(0, MAX_TITLE_LEN)
      : generateTitle(input.startHour, input.startMinute, input.endHour, input.endMinute);

  const proposed: ProposedShift = {
    id: editingId,
    userId: input.userId,
    start: times.start,
    end: times.end,
    title
  };

  let existing: BeekeeperShift[];
  try {
    existing = await existingForOverlap(env, schedule.schedule_id, input.date);
  } catch (err) {
    return { ok: false, response: mapBeekeeperError(err) };
  }

  const errors = validateShift(proposed, existing);
  if (errors.length > 0) {
    return { ok: false, response: json({ error: "validation_failed", details: errors }, 422) };
  }

  return {
    ok: true,
    body: {
      id: shiftId,
      userId: input.userId,
      scheduleId: schedule.schedule_id,
      start: times.start,
      end: times.end,
      title
    }
  };
}

/**
 * POST /api/loc/{location_code}/shifts — create a shift.
 * Body: { userId, date, startHour, startMinute, endHour, endMinute, title? }
 */
export async function handleCreateShift(
  request: Request,
  env: Env,
  locationCode: string
): Promise<Response> {
  if (!isOriginAllowed(request)) return jsonError(403, "bad origin");
  const g = await gateAndResolve(request, env, locationCode);
  if (!g.ok) return g.response;
  const { schedule, sb, session } = g.ctx;

  const input = parseWriteInput(await request.json().catch(() => null));
  if (!input) return jsonError(400, "Invalid shift body");
  if (!input.userId) return jsonError(400, "userId is required");

  // Stable, meaningful app-side id: schedule + user + start instant.
  const shiftId = crypto.randomUUID();
  const built = await buildAndValidate(env, schedule, input, shiftId);
  if (!built.ok) return built.response;

  let created: BeekeeperShift;
  try {
    created = await createShift(env, schedule.schedule_id, built.body);
  } catch (err) {
    return mapBeekeeperError(err);
  }

  await audit(sb, session, "shift_create", locationCode, null, built.body);
  return json({ ok: true, shift: created });
}

/**
 * PUT /api/loc/{location_code}/shifts/{shiftId} — full-replace edit.
 * Body: same as create.
 */
export async function handleUpdateShift(
  request: Request,
  env: Env,
  locationCode: string,
  shiftId: string
): Promise<Response> {
  if (!isOriginAllowed(request)) return jsonError(403, "bad origin");
  const g = await gateAndResolve(request, env, locationCode);
  if (!g.ok) return g.response;
  const { schedule, sb, session } = g.ctx;

  const input = parseWriteInput(await request.json().catch(() => null));
  if (!input) return jsonError(400, "Invalid shift body");
  if (!input.userId) return jsonError(400, "userId is required");

  const built = await buildAndValidate(env, schedule, input, shiftId, shiftId);
  if (!built.ok) return built.response;

  let updated: BeekeeperShift;
  try {
    updated = await updateShift(env, schedule.schedule_id, shiftId, built.body);
  } catch (err) {
    return mapBeekeeperError(err);
  }

  await audit(sb, session, "shift_update", locationCode, { id: shiftId }, built.body);
  return json({ ok: true, shift: updated });
}

/**
 * DELETE /api/loc/{location_code}/shifts/{shiftId} — remove a shift.
 */
export async function handleDeleteShift(
  request: Request,
  env: Env,
  locationCode: string,
  shiftId: string
): Promise<Response> {
  if (!isOriginAllowed(request)) return jsonError(403, "bad origin");
  const g = await gateAndResolve(request, env, locationCode);
  if (!g.ok) return g.response;
  const { schedule, sb, session } = g.ctx;

  try {
    await deleteShift(env, schedule.schedule_id, shiftId);
  } catch (err) {
    return mapBeekeeperError(err);
  }

  await audit(sb, session, "shift_delete", locationCode, { id: shiftId }, null);
  return json({ ok: true });
}

/* ============================================================
 * Manual sync (super_admin or SYNC_ADMIN_EMAILS)
 * ============================================================ */

/**
 * POST /api/sync-users — force a cache refill. Gated to super_admins plus any
 * email in SYNC_ADMIN_EMAILS. Uses scheduleGate for authn, then an extra
 * authorization check (a schedule/pricing grant alone is NOT enough).
 */
export async function handleSyncUsers(request: Request, env: Env): Promise<Response> {
  if (!isOriginAllowed(request)) return jsonError(403, "bad origin");
  const gate = await scheduleGate(request, env);
  if (!gate.ok) return gate.response;

  const allow = new Set(
    (env.SYNC_ADMIN_EMAILS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
  const isSuper = gate.session.role === "super_admin";
  const isAllowed = allow.has(gate.session.email.toLowerCase());
  if (!isSuper && !isAllowed) return jsonError(403, "sync requires super_admin");

  const result = await runBeekeeperSync(env);
  return json(result, result.ok ? 200 : 502);
}

/* ============================================================
 * Helpers
 * ============================================================ */

/** Map a BeekeeperError to a client status. Surfaces upstream 409 (overlap /
 *  conflict) cleanly; everything else becomes a 502 upstream error. */
function mapBeekeeperError(err: unknown): Response {
  if (err instanceof BeekeeperError) {
    if (err.status === 409) return jsonError(409, "Beekeeper rejected: shift conflict");
    if (err.status === 404) return jsonError(404, "Beekeeper resource not found");
    return json({ error: "beekeeper_upstream", status: err.status, detail: err.body.slice(0, 500) }, 502);
  }
  return jsonError(500, err instanceof Error ? err.message : "unexpected error");
}

async function audit(
  sb: SupabaseClient,
  session: Session,
  action: "shift_create" | "shift_update" | "shift_delete",
  locationCode: string,
  before: unknown,
  after: unknown
): Promise<void> {
  await logSysadminAudit(sb, {
    actor: { id: session.userId, email: session.email },
    action,
    target_type: "beekeeper_shift",
    target_id: locationCode,
    before: (before as Record<string, unknown>) ?? null,
    after: (after as Record<string, unknown>) ?? null
  });
}
