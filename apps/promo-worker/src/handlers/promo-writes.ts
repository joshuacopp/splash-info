// Brief 155 — IT-side write surfaces for promo tickets, status,
// assignees, and per-location progress.
//
// Routes (mounted in src/index.ts after Brief 154's read/create):
//
//   PATCH  /promo/api/promos/{id}/ticket
//   PATCH  /promo/api/promos/{id}/status
//   POST   /promo/api/promos/{id}/assignees
//   DELETE /promo/api/promos/{id}/assignees/{userId}
//   PATCH  /promo/api/promos/{id}/locations/{locationCode}
//
// Auth posture: every handler is gated by `authenticate()` (cookie session)
// + `gatePromoRole(role, [...])`. Mutations also gate on `isOriginAllowed`
// (CSRF defense-in-depth, Brief 17 convention). Ticket / assignee /
// location writes are super_admin | it only; status write also accepts
// marketing (campaign-end flips).
//
// Auto-status flip: when `promotions.status === 'Submitted'` AND after a
// successful PATCH there is at least one assignee AND ready_by_date is
// non-null, the worker auto-advances to 'Scoped' in the same write path.
// Fires on two trigger paths — PATCH ticket and POST assignees. Mirrors
// Brief 131's terminal-outcome auto-flip in forms-worker (the worker
// decides; the UI doesn't have to track the threshold).
//
// Activity log: every successful write emits at least one
// `promo_activity_log` row via `logActivity` (the auto-flip emits a
// second `status_changed` row alongside the trigger). Failure to log is
// fail-soft — the row already landed; the audit miss is preferable to
// rolling back a real state change.

import { authenticate } from "@splash/auth";
import { gatePromoRole } from "@splash/db-supabase";
import { isOriginAllowed, jsonError } from "@splash/http";
import type { PromoRole } from "@splash/types/promo";
import type { Env } from "../index.js";
import { logActivity } from "./_activity.js";

// =============================================================================
// Shared constants + helpers
// =============================================================================

const PROMO_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USER_ID_RE = PROMO_ID_RE;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const LOCATION_CODE_RE = /^[a-z0-9_-]+$/;

const STATUSES = [
  "Submitted",
  "Scoped",
  "Building",
  "Tested",
  "Live",
  "Ended"
] as const;
type Status = (typeof STATUSES)[number];

const ROADBLOCKS_MAX_LEN = 10_000;
const INTERNAL_NOTE_MAX_LEN = 10_000;

function pgHeaders(env: Env): HeadersInit {
  return {
    apikey: env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    }
  });
}

function requireServiceKey(env: Env): Response | null {
  if (!env.SUPABASE_SERVICE_KEY) {
    return jsonError(503, "service_key_unbound");
  }
  return null;
}

interface GateOk {
  ok: true;
  session: { userId: string; email: string; promoRole: PromoRole };
}
interface GateErr {
  ok: false;
  response: Response;
}

/**
 * Resolve the calling session + run the promo-role gate. Duplicated from
 * `promos.ts` rather than shared — the write file is intentionally
 * self-contained per the brief's "separate from promos.ts" split.
 */
async function gateCaller(
  env: Env,
  req: Request,
  requiredRoles: PromoRole[]
): Promise<GateOk | GateErr> {
  const auth = await authenticate(req, env);
  if (auth.status !== "authenticated") {
    return { ok: false, response: jsonError(401, "unauthorized") };
  }
  const { session } = auth;
  const gate = gatePromoRole(session.promoRole, requiredRoles);
  if (!gate.isAuthorized || !gate.promoRole) {
    return { ok: false, response: jsonError(403, "forbidden") };
  }
  return {
    ok: true,
    session: {
      userId: session.userId,
      email: session.email,
      promoRole: gate.promoRole
    }
  };
}

interface PromoStateRow {
  status: Status;
  ticket: {
    ready_by_date: string | null;
    roadblocks: string | null;
    internal_note: string | null;
    assignees: Array<{ user_id: string }> | null;
  } | null;
}

/**
 * Single PostgREST round-trip that pulls every field the write handlers
 * need to (a) check existence, (b) compute before-state deltas, and (c)
 * evaluate the auto-status flip condition.
 *
 * Returns null when no promo row matches; throws on transport / parse
 * errors.
 */
async function fetchPromoState(
  env: Env,
  promoId: string
): Promise<PromoStateRow | null> {
  const url = new URL("/rest/v1/promotions", env.SUPABASE_URL);
  url.searchParams.set("id", `eq.${promoId}`);
  url.searchParams.set(
    "select",
    [
      "status",
      "ticket:promo_tickets!left(ready_by_date,roadblocks,internal_note,assignees:promo_ticket_assignees(user_id))"
    ].join(",")
  );
  url.searchParams.set("limit", "1");
  const resp = await fetch(url.toString(), { headers: pgHeaders(env) });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`fetchPromoState ${resp.status}: ${errText}`);
  }
  type RawTicket = NonNullable<PromoStateRow["ticket"]>;
  const rows = (await resp.json().catch(() => [])) as Array<{
    status: Status;
    ticket: RawTicket | RawTicket[] | null;
  }>;
  const row = rows[0];
  if (!row) return null;
  // PostgREST 1:1 embed can return either object or single-element array;
  // tolerate both shapes (same defense as Brief 154's detail handler).
  const ticket: RawTicket | null = Array.isArray(row.ticket)
    ? row.ticket[0] ?? null
    : row.ticket;
  return { status: row.status, ticket };
}

/**
 * Auto-status advance helper. Returns the new status (always 'Scoped'
 * when a flip happens, otherwise the existing status). Reads `current`
 * directly rather than refetching to avoid a redundant round-trip; the
 * caller passes the post-write state.
 *
 * Conditions (all required): current status === 'Submitted', assignee
 * count >= 1, ready_by_date IS NOT NULL.
 *
 * When the flip fires, this helper PATCHes promotions + emits the
 * synthetic `status_changed` activity row. Fail-soft on the activity log
 * insert (consistent with logActivity's contract). Failure of the
 * promotions PATCH itself is logged but does not throw — the parent
 * write already succeeded and the caller's response should still 200.
 */
async function maybeAutoAdvanceStatus(
  env: Env,
  promoId: string,
  actorUserId: string,
  current: {
    status: Status;
    readyByDate: string | null;
    assigneeCount: number;
  },
  trigger: "ticket_ready" | "assignee_added"
): Promise<Status> {
  if (current.status !== "Submitted") return current.status;
  if (current.assigneeCount < 1) return current.status;
  if (!current.readyByDate) return current.status;

  try {
    const url = new URL("/rest/v1/promotions", env.SUPABASE_URL);
    url.searchParams.set("id", `eq.${promoId}`);
    const resp = await fetch(url.toString(), {
      method: "PATCH",
      headers: {
        ...pgHeaders(env),
        "Content-Type": "application/json",
        Prefer: "return=minimal"
      },
      body: JSON.stringify({
        status: "Scoped",
        status_updated_at: new Date().toISOString(),
        status_updated_by: actorUserId
      })
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      console.warn(
        "[promo.auto-advance] PATCH failed (non-fatal)",
        promoId,
        resp.status,
        errText
      );
      return current.status;
    }
  } catch (err) {
    console.warn("[promo.auto-advance] PATCH threw (non-fatal)", promoId, err);
    return current.status;
  }

  await logActivity(env, promoId, actorUserId, "status_changed", {
    from: "Submitted",
    to: "Scoped",
    auto: true,
    trigger
  });

  return "Scoped";
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validateIsoDate(v: unknown): string | null {
  if (typeof v !== "string") return null;
  if (!ISO_DATE_RE.test(v)) return null;
  const parsed = new Date(v + "T00:00:00Z");
  if (Number.isNaN(parsed.getTime())) return null;
  const yyyy = parsed.getUTCFullYear().toString().padStart(4, "0");
  const mm = (parsed.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = parsed.getUTCDate().toString().padStart(2, "0");
  if (`${yyyy}-${mm}-${dd}` !== v) return null;
  return v;
}

// =============================================================================
// PATCH /promo/api/promos/{id}/ticket
// =============================================================================

interface PatchTicketBody {
  readyByDate?: unknown;
  roadblocks?: unknown;
  internalNote?: unknown;
}

const PATCH_TICKET_KNOWN_KEYS = new Set([
  "readyByDate",
  "roadblocks",
  "internalNote"
]);

interface ValidatedTicketPatch {
  readyByDate?: string | null;
  roadblocks?: string | null;
  internalNote?: string | null;
}

export async function handlePatchTicket(
  req: Request,
  env: Env,
  promoId: string
): Promise<Response> {
  const sk = requireServiceKey(env);
  if (sk) return sk;
  if (!isOriginAllowed(req)) return jsonError(403, "bad_origin");

  const gate = await gateCaller(env, req, ["super_admin", "it"]);
  if (!gate.ok) return gate.response;

  if (!PROMO_ID_RE.test(promoId)) return jsonError(404, "promo_not_found");

  let body: PatchTicketBody;
  try {
    const raw = await req.json();
    if (!isPlainObject(raw)) return jsonError(400, "bad_request");
    body = raw as PatchTicketBody;
  } catch {
    return jsonError(400, "bad_request");
  }

  // Reject unknown keys — defense in depth against future schema drift.
  for (const k of Object.keys(body)) {
    if (!PATCH_TICKET_KNOWN_KEYS.has(k)) {
      return jsonError(400, "bad_request");
    }
  }

  const patch: ValidatedTicketPatch = {};
  const fields: Record<string, string> = {};

  if ("readyByDate" in body) {
    const v = body.readyByDate;
    if (v === null) {
      patch.readyByDate = null;
    } else {
      const iso = validateIsoDate(v);
      if (!iso) {
        fields.readyByDate = "invalid";
      } else {
        patch.readyByDate = iso;
      }
    }
  }

  if ("roadblocks" in body) {
    const v = body.roadblocks;
    if (v === null) {
      patch.roadblocks = null;
    } else if (typeof v === "string") {
      const trimmed = v.trim();
      if (trimmed.length > ROADBLOCKS_MAX_LEN) {
        fields.roadblocks = "too_long";
      } else {
        patch.roadblocks = trimmed.length === 0 ? null : trimmed;
      }
    } else {
      fields.roadblocks = "invalid";
    }
  }

  if ("internalNote" in body) {
    const v = body.internalNote;
    if (v === null) {
      patch.internalNote = null;
    } else if (typeof v === "string") {
      const trimmed = v.trim();
      if (trimmed.length > INTERNAL_NOTE_MAX_LEN) {
        fields.internalNote = "too_long";
      } else {
        patch.internalNote = trimmed.length === 0 ? null : trimmed;
      }
    } else {
      fields.internalNote = "invalid";
    }
  }

  if (Object.keys(fields).length > 0) {
    return new Response(
      JSON.stringify({ error: "bad_request", fields }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  // No-op body (all keys absent) — accept as 200 with the current ticket
  // shape; don't write an activity log row for a no-op. Apps/web can
  // submit-with-no-changes without spamming the timeline.
  const hasAnyPatch = Object.keys(patch).length > 0;

  // ---- Step 1: read current state for delta + auto-flip evaluation ----------
  let state: PromoStateRow | null;
  try {
    state = await fetchPromoState(env, promoId);
  } catch (err) {
    console.error("[promo.patch-ticket] state fetch threw", err);
    return jsonError(500, "patch_failed");
  }
  if (!state) return jsonError(404, "promo_not_found");
  if (!state.ticket) {
    // 1:1 invariant violated — promo exists but ticket row doesn't. The
    // Brief 154 create flow inserts both, so this would only happen on a
    // partial rollback edge case the operator should chase manually.
    console.error("[promo.patch-ticket] ticket row missing for promo", promoId);
    return jsonError(500, "ticket_missing");
  }
  const before = state.ticket;

  // ---- Step 2: build the PATCH body ----------------------------------------
  const nowIso = new Date().toISOString();
  const patchBody: Record<string, unknown> = { updated_at: nowIso };
  if ("readyByDate" in patch) {
    patchBody.ready_by_date = patch.readyByDate;
    patchBody.ready_by_updated_at = nowIso;
    patchBody.ready_by_updated_by = gate.session.userId;
  }
  if ("roadblocks" in patch) {
    patchBody.roadblocks = patch.roadblocks;
  }
  if ("internalNote" in patch) {
    patchBody.internal_note = patch.internalNote;
  }

  // ---- Step 3: PATCH the row ------------------------------------------------
  type PatchedTicket = {
    ready_by_date: string | null;
    roadblocks: string | null;
    internal_note: string | null;
    created_at: string;
    updated_at: string;
    ready_by_updated_at: string | null;
    ready_by_updated_by: string | null;
  };
  let updated: PatchedTicket;
  try {
    if (hasAnyPatch) {
      const url = new URL("/rest/v1/promo_tickets", env.SUPABASE_URL);
      url.searchParams.set("promo_id", `eq.${promoId}`);
      const resp = await fetch(url.toString(), {
        method: "PATCH",
        headers: {
          ...pgHeaders(env),
          "Content-Type": "application/json",
          Prefer: "return=representation"
        },
        body: JSON.stringify(patchBody)
      });
      if (!resp.ok) {
        const errText = await resp.text().catch(() => "");
        console.error(
          "[promo.patch-ticket] PATCH failed",
          resp.status,
          errText
        );
        return jsonError(500, "patch_failed");
      }
      const rows = (await resp.json().catch(() => [])) as PatchedTicket[];
      if (!rows[0]) {
        console.error("[promo.patch-ticket] PATCH returned no row", promoId);
        return jsonError(500, "patch_failed");
      }
      updated = rows[0];
    } else {
      // No-op: synthesize the current row shape from the before-state we
      // already fetched. Don't bother round-tripping for created_at /
      // updated_at — the apps/web client only re-renders when fields it
      // displays changed.
      updated = {
        ready_by_date: before.ready_by_date,
        roadblocks: before.roadblocks,
        internal_note: before.internal_note,
        created_at: nowIso,
        updated_at: nowIso,
        ready_by_updated_at: null,
        ready_by_updated_by: null
      };
    }
  } catch (err) {
    console.error("[promo.patch-ticket] PATCH threw", err);
    return jsonError(500, "patch_failed");
  }

  // ---- Step 4: emit activity log rows --------------------------------------
  // Compute deltas vs. before-state. Apply per-field-typed rows only for
  // fields that actually changed value (not just present in the body).
  if (hasAnyPatch) {
    const changedFields: string[] = [];
    const readyByChanged =
      "readyByDate" in patch &&
      (patch.readyByDate ?? null) !== (before.ready_by_date ?? null);
    const roadblocksChanged =
      "roadblocks" in patch &&
      (patch.roadblocks ?? null) !== (before.roadblocks ?? null);
    const internalNoteChanged =
      "internalNote" in patch &&
      (patch.internalNote ?? null) !== (before.internal_note ?? null);

    if (readyByChanged) changedFields.push("readyByDate");
    if (roadblocksChanged) changedFields.push("roadblocks");
    if (internalNoteChanged) changedFields.push("internalNote");

    if (changedFields.length > 0) {
      // Always emit the umbrella ticket_updated row. `fields` carries
      // which fields changed (not the values themselves; the values
      // live on the row).
      await logActivity(env, promoId, gate.session.userId, "ticket_updated", {
        fields: changedFields
      });
      if (roadblocksChanged) {
        await logActivity(
          env,
          promoId,
          gate.session.userId,
          "roadblocks_updated",
          {}
        );
      }
      if (internalNoteChanged) {
        await logActivity(
          env,
          promoId,
          gate.session.userId,
          "internal_note_updated",
          {}
        );
      }
    }
  }

  // ---- Step 5: evaluate auto-status flip -----------------------------------
  const assigneeCount = before.assignees ? before.assignees.length : 0;
  const newReadyByDate = updated.ready_by_date;
  const newStatus = await maybeAutoAdvanceStatus(
    env,
    promoId,
    gate.session.userId,
    {
      status: state.status,
      readyByDate: newReadyByDate,
      assigneeCount
    },
    "ticket_ready"
  );

  // ---- Step 6: shape the response ------------------------------------------
  const exposeInternalNote =
    gate.session.promoRole === "super_admin" ||
    gate.session.promoRole === "it";
  const ticketResponse: Record<string, unknown> = {
    readyByDate: updated.ready_by_date,
    roadblocks: updated.roadblocks,
    createdAt: updated.created_at,
    updatedAt: updated.updated_at,
    readyByUpdatedAt: updated.ready_by_updated_at,
    readyByUpdatedBy: updated.ready_by_updated_by
  };
  if (exposeInternalNote) {
    ticketResponse.internalNote = updated.internal_note;
  }

  return jsonResponse({
    ok: true,
    ticket: ticketResponse,
    promoStatus: newStatus
  });
}

// =============================================================================
// PATCH /promo/api/promos/{id}/status
// =============================================================================

interface PatchStatusBody {
  status?: unknown;
}

const PATCH_STATUS_KNOWN_KEYS = new Set(["status"]);

export async function handlePatchStatus(
  req: Request,
  env: Env,
  promoId: string
): Promise<Response> {
  const sk = requireServiceKey(env);
  if (sk) return sk;
  if (!isOriginAllowed(req)) return jsonError(403, "bad_origin");

  const gate = await gateCaller(env, req, ["super_admin", "it", "marketing"]);
  if (!gate.ok) return gate.response;

  if (!PROMO_ID_RE.test(promoId)) return jsonError(404, "promo_not_found");

  let body: PatchStatusBody;
  try {
    const raw = await req.json();
    if (!isPlainObject(raw)) return jsonError(400, "bad_request");
    body = raw as PatchStatusBody;
  } catch {
    return jsonError(400, "bad_request");
  }

  for (const k of Object.keys(body)) {
    if (!PATCH_STATUS_KNOWN_KEYS.has(k)) {
      return jsonError(400, "bad_request");
    }
  }

  const newStatus = body.status;
  if (
    typeof newStatus !== "string" ||
    !(STATUSES as readonly string[]).includes(newStatus)
  ) {
    return new Response(
      JSON.stringify({ error: "bad_request", fields: { status: "invalid" } }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  // Read current status (also doubles as the 404 check).
  let currentStatus: Status;
  try {
    const url = new URL("/rest/v1/promotions", env.SUPABASE_URL);
    url.searchParams.set("id", `eq.${promoId}`);
    url.searchParams.set("select", "status");
    url.searchParams.set("limit", "1");
    const resp = await fetch(url.toString(), { headers: pgHeaders(env) });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      console.error(
        "[promo.patch-status] status fetch failed",
        resp.status,
        errText
      );
      return jsonError(500, "patch_failed");
    }
    const rows = (await resp.json().catch(() => [])) as Array<{ status: Status }>;
    if (!rows[0]) return jsonError(404, "promo_not_found");
    currentStatus = rows[0].status;
  } catch (err) {
    console.error("[promo.patch-status] status fetch threw", err);
    return jsonError(500, "patch_failed");
  }

  if (currentStatus === newStatus) {
    // No-op — return 200 with `unchanged: true` and emit no log row.
    return jsonResponse({ ok: true, status: currentStatus, unchanged: true });
  }

  // PATCH + stamp audit columns.
  try {
    const url = new URL("/rest/v1/promotions", env.SUPABASE_URL);
    url.searchParams.set("id", `eq.${promoId}`);
    const resp = await fetch(url.toString(), {
      method: "PATCH",
      headers: {
        ...pgHeaders(env),
        "Content-Type": "application/json",
        Prefer: "return=minimal"
      },
      body: JSON.stringify({
        status: newStatus,
        status_updated_at: new Date().toISOString(),
        status_updated_by: gate.session.userId
      })
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      console.error(
        "[promo.patch-status] PATCH failed",
        resp.status,
        errText
      );
      return jsonError(500, "patch_failed");
    }
  } catch (err) {
    console.error("[promo.patch-status] PATCH threw", err);
    return jsonError(500, "patch_failed");
  }

  await logActivity(env, promoId, gate.session.userId, "status_changed", {
    from: currentStatus,
    to: newStatus,
    auto: false
  });

  return jsonResponse({
    ok: true,
    status: newStatus,
    previousStatus: currentStatus
  });
}

// =============================================================================
// POST /promo/api/promos/{id}/assignees
// =============================================================================

interface PostAssigneeBody {
  userId?: unknown;
}

const POST_ASSIGNEE_KNOWN_KEYS = new Set(["userId"]);

export async function handleAddAssignee(
  req: Request,
  env: Env,
  promoId: string
): Promise<Response> {
  const sk = requireServiceKey(env);
  if (sk) return sk;
  if (!isOriginAllowed(req)) return jsonError(403, "bad_origin");

  const gate = await gateCaller(env, req, ["super_admin", "it"]);
  if (!gate.ok) return gate.response;

  if (!PROMO_ID_RE.test(promoId)) return jsonError(404, "promo_not_found");

  let body: PostAssigneeBody;
  try {
    const raw = await req.json();
    if (!isPlainObject(raw)) return jsonError(400, "bad_request");
    body = raw as PostAssigneeBody;
  } catch {
    return jsonError(400, "bad_request");
  }

  for (const k of Object.keys(body)) {
    if (!POST_ASSIGNEE_KNOWN_KEYS.has(k)) {
      return jsonError(400, "bad_request");
    }
  }

  const targetUserId = body.userId;
  if (typeof targetUserId !== "string" || !USER_ID_RE.test(targetUserId)) {
    return new Response(
      JSON.stringify({ error: "bad_request", fields: { userId: "invalid" } }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  // Existence check + auto-flip prerequisites in one round-trip.
  let state: PromoStateRow | null;
  try {
    state = await fetchPromoState(env, promoId);
  } catch (err) {
    console.error("[promo.add-assignee] state fetch threw", err);
    return jsonError(500, "patch_failed");
  }
  if (!state) return jsonError(404, "promo_not_found");

  // Light verification: target must have a non-null promo_role. Stops
  // accidentally adding a non-promo user to the IT queue. Stale UUIDs
  // (no auth.users row at all) surface as "row not found" here and get
  // the same `target_no_promo_role` response — the worker doesn't try
  // to distinguish "user doesn't exist" from "user has no promo role"
  // for anti-leak purposes.
  try {
    const url = new URL("/rest/v1/auth_unified", env.SUPABASE_URL);
    url.searchParams.set("user_id", `eq.${targetUserId}`);
    url.searchParams.set("select", "promo_role");
    url.searchParams.set("limit", "1");
    const resp = await fetch(url.toString(), { headers: pgHeaders(env) });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      console.error(
        "[promo.add-assignee] auth_unified fetch failed",
        resp.status,
        errText
      );
      return jsonError(500, "patch_failed");
    }
    const rows = (await resp.json().catch(() => [])) as Array<{
      promo_role: PromoRole | null;
    }>;
    const targetRole = rows[0]?.promo_role ?? null;
    if (!targetRole) {
      return new Response(
        JSON.stringify({ error: "target_no_promo_role" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }
  } catch (err) {
    console.error("[promo.add-assignee] auth_unified fetch threw", err);
    return jsonError(500, "patch_failed");
  }

  // INSERT — catch 23505 (PK collision) → 409 already_assigned.
  const nowIso = new Date().toISOString();
  try {
    const url = new URL("/rest/v1/promo_ticket_assignees", env.SUPABASE_URL);
    const resp = await fetch(url.toString(), {
      method: "POST",
      headers: {
        ...pgHeaders(env),
        "Content-Type": "application/json",
        Prefer: "return=minimal"
      },
      body: JSON.stringify({
        promo_id: promoId,
        user_id: targetUserId,
        assigned_at: nowIso,
        assigned_by: gate.session.userId
      })
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      // PostgREST surfaces Postgres SQLSTATE in the JSON error body when
      // it can; detect via substring rather than parse (cheap +
      // version-agnostic).
      if (resp.status === 409 || errText.includes("23505")) {
        return new Response(
          JSON.stringify({ error: "already_assigned" }),
          { status: 409, headers: { "Content-Type": "application/json" } }
        );
      }
      console.error(
        "[promo.add-assignee] INSERT failed",
        resp.status,
        errText
      );
      return jsonError(500, "patch_failed");
    }
  } catch (err) {
    console.error("[promo.add-assignee] INSERT threw", err);
    return jsonError(500, "patch_failed");
  }

  await logActivity(
    env,
    promoId,
    gate.session.userId,
    "assignment_changed",
    {
      action: "added",
      userId: targetUserId,
      assignedByEmail: gate.session.email
    }
  );

  // Auto-flip check — the new assignee count is the prior count + 1.
  const priorAssigneeCount = state.ticket?.assignees
    ? state.ticket.assignees.length
    : 0;
  const newStatus = await maybeAutoAdvanceStatus(
    env,
    promoId,
    gate.session.userId,
    {
      status: state.status,
      readyByDate: state.ticket?.ready_by_date ?? null,
      assigneeCount: priorAssigneeCount + 1
    },
    "assignee_added"
  );

  return jsonResponse(
    {
      ok: true,
      assignee: {
        userId: targetUserId,
        assignedAt: nowIso,
        assignedBy: gate.session.userId
      },
      promoStatus: newStatus
    },
    201
  );
}

// =============================================================================
// DELETE /promo/api/promos/{id}/assignees/{userId}
// =============================================================================

export async function handleRemoveAssignee(
  req: Request,
  env: Env,
  promoId: string,
  userId: string
): Promise<Response> {
  const sk = requireServiceKey(env);
  if (sk) return sk;
  if (!isOriginAllowed(req)) return jsonError(403, "bad_origin");

  const gate = await gateCaller(env, req, ["super_admin", "it"]);
  if (!gate.ok) return gate.response;

  if (!PROMO_ID_RE.test(promoId)) return jsonError(404, "promo_not_found");
  if (!USER_ID_RE.test(userId)) return jsonError(404, "not_assigned");

  // DELETE + return=representation to count affected rows.
  let removed = false;
  try {
    const url = new URL("/rest/v1/promo_ticket_assignees", env.SUPABASE_URL);
    url.searchParams.set("promo_id", `eq.${promoId}`);
    url.searchParams.set("user_id", `eq.${userId}`);
    const resp = await fetch(url.toString(), {
      method: "DELETE",
      headers: {
        ...pgHeaders(env),
        Prefer: "return=representation"
      }
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      console.error(
        "[promo.remove-assignee] DELETE failed",
        resp.status,
        errText
      );
      return jsonError(500, "patch_failed");
    }
    const rows = (await resp.json().catch(() => [])) as Array<unknown>;
    removed = Array.isArray(rows) && rows.length > 0;
  } catch (err) {
    console.error("[promo.remove-assignee] DELETE threw", err);
    return jsonError(500, "patch_failed");
  }

  if (!removed) {
    return new Response(
      JSON.stringify({ error: "not_assigned" }),
      { status: 404, headers: { "Content-Type": "application/json" } }
    );
  }

  await logActivity(
    env,
    promoId,
    gate.session.userId,
    "assignment_changed",
    {
      action: "removed",
      userId,
      removedByEmail: gate.session.email
    }
  );

  // No auto-status reversal on last-assignee-removed (per brief Phase 5).
  return jsonResponse({ ok: true, removed: true });
}

// =============================================================================
// PATCH /promo/api/promos/{id}/locations/{locationCode}
// =============================================================================

interface PatchLocationBody {
  isComplete?: unknown;
}

const PATCH_LOCATION_KNOWN_KEYS = new Set(["isComplete"]);

export async function handlePatchLocationProgress(
  req: Request,
  env: Env,
  promoId: string,
  locationCode: string
): Promise<Response> {
  const sk = requireServiceKey(env);
  if (sk) return sk;
  if (!isOriginAllowed(req)) return jsonError(403, "bad_origin");

  const gate = await gateCaller(env, req, ["super_admin", "it"]);
  if (!gate.ok) return gate.response;

  if (!PROMO_ID_RE.test(promoId)) return jsonError(404, "promo_not_found");
  // Brief 153 convention: location_code is opaque text matching the
  // [a-z0-9_-]+ slug shape. The route regex in index.ts already enforces
  // this, but defense-in-depth re-check here means future internal calls
  // (e.g., a bulk helper) can't skip it.
  if (!LOCATION_CODE_RE.test(locationCode)) {
    return jsonError(404, "location_not_on_promo");
  }

  let body: PatchLocationBody;
  try {
    const raw = await req.json();
    if (!isPlainObject(raw)) return jsonError(400, "bad_request");
    body = raw as PatchLocationBody;
  } catch {
    return jsonError(400, "bad_request");
  }

  for (const k of Object.keys(body)) {
    if (!PATCH_LOCATION_KNOWN_KEYS.has(k)) {
      return jsonError(400, "bad_request");
    }
  }

  if (typeof body.isComplete !== "boolean") {
    return new Response(
      JSON.stringify({
        error: "bad_request",
        fields: { isComplete: "invalid" }
      }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }
  const isComplete = body.isComplete;
  const nowIso = new Date().toISOString();

  type PatchedLocation = {
    location_code: string;
    is_complete: boolean;
    completed_at: string | null;
    completed_by: string | null;
  };
  let updated: PatchedLocation | null = null;
  try {
    const url = new URL("/rest/v1/promo_locations", env.SUPABASE_URL);
    url.searchParams.set("promo_id", `eq.${promoId}`);
    url.searchParams.set("location_code", `eq.${locationCode}`);
    const resp = await fetch(url.toString(), {
      method: "PATCH",
      headers: {
        ...pgHeaders(env),
        "Content-Type": "application/json",
        Prefer: "return=representation"
      },
      body: JSON.stringify({
        is_complete: isComplete,
        completed_at: isComplete ? nowIso : null,
        completed_by: isComplete ? gate.session.userId : null
      })
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      console.error(
        "[promo.patch-location] PATCH failed",
        resp.status,
        errText
      );
      return jsonError(500, "patch_failed");
    }
    const rows = (await resp.json().catch(() => [])) as PatchedLocation[];
    updated = rows[0] ?? null;
  } catch (err) {
    console.error("[promo.patch-location] PATCH threw", err);
    return jsonError(500, "patch_failed");
  }

  if (!updated) {
    return new Response(
      JSON.stringify({ error: "location_not_on_promo" }),
      { status: 404, headers: { "Content-Type": "application/json" } }
    );
  }

  await logActivity(
    env,
    promoId,
    gate.session.userId,
    isComplete ? "location_marked_complete" : "location_marked_incomplete",
    { locationCode }
  );

  return jsonResponse({
    ok: true,
    locationCode: updated.location_code,
    isComplete: updated.is_complete,
    completedAt: updated.completed_at
  });
}
