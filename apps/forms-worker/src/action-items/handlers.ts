// Brief 176 — action items read/write API.
//
//   GET   /forms/api/action-items?location=&status=&submission_id=
//   PATCH /forms/api/action-items/{id}
//   POST  /forms/api/action-items/{id}/verify
//
// Authority comes from ./access.ts (email-on-locations, no new permission
// model). Every write re-reads the row's location_code and re-checks, because
// the id alone says nothing about who owns it.

import { authenticate } from "@splash/auth";
import { isOriginAllowed, jsonError } from "@splash/http";
import {
  resolveActionItemAccess,
  canRead,
  canEdit,
  canVerify,
  type ActionItemAccess
} from "./access.js";
import { requireServiceKey } from "../admin/auth.js";
import type { Env } from "../index.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const STATUSES = ["open", "in_progress", "done"] as const;
const PRIORITIES = ["High", "Medium", "Low"] as const;
type Status = (typeof STATUSES)[number];

const LIST_LIMIT = 500;
const DESCRIPTION_MAX = 5000;

interface ActionItemRow {
  id: string;
  /** Null on an item added by hand. field_key and question_label are null with
   *  it -- see the action_items_provenance_consistent CHECK. */
  submission_id: string | null;
  location_code: string;
  field_key: string | null;
  question_label: string | null;
  answer_snapshot: string | null;
  description: string;
  priority: string;
  due_date: string | null;
  status: Status;
  completed_at: string | null;
  completed_by: string | null;
  rm_verified_at: string | null;
  rm_verified_by: string | null;
  created_at: string;
}

function sbHeaders(env: Env, extra?: Record<string, string>) {
  return {
    apikey: env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    ...(extra ?? {})
  };
}

function isAdminTier(session: {
  role?: string | null;
  dcRole?: string | null;
}): boolean {
  return (
    session.role === "super_admin" ||
    session.dcRole === "admin" ||
    session.dcRole === "super_admin"
  );
}

async function gate(
  env: Env,
  req: Request
): Promise<
  | { ok: true; access: ActionItemAccess; email: string; userId: string | null }
  | { ok: false; response: Response }
> {
  const auth = await authenticate(req, env);
  if (auth.status !== "authenticated") {
    return { ok: false, response: jsonError(401, "unauthenticated") };
  }
  const { session } = auth;
  const access = await resolveActionItemAccess(
    env,
    session.email,
    isAdminTier(session)
  );
  if (!access.isAdmin && access.locationCodes.length === 0) {
    // No site contact match anywhere. Distinct from "no items": this caller
    // has no business on this surface at all.
    return { ok: false, response: jsonError(403, "no_accessible_locations") };
  }
  return {
    ok: true,
    access,
    email: session.email,
    userId: session.userId ?? null
  };
}

function quoteIn(values: string[]): string {
  return values.map((v) => `"${v.replace(/"/g, '""')}"`).join(",");
}

// =============================================================================
// GET /forms/api/action-items
// =============================================================================

export async function handleListActionItems(
  env: Env,
  req: Request
): Promise<Response> {
  const sk = requireServiceKey(env);
  if (sk) return sk;
  const g = await gate(env, req);
  if (!g.ok) return g.response;

  const url = new URL(req.url);
  const location = url.searchParams.get("location");
  const status = url.searchParams.get("status");
  const submissionId = url.searchParams.get("submission_id");

  const q = new URL("/rest/v1/action_items", env.SUPABASE_URL);
  q.searchParams.set("select", "*");
  // Soonest due first, undated last. A sensible default for any consumer, but
  // NOT the final worklist order: priority ranks High > Medium > Low, which is
  // not alphabetical, so PostgREST cannot express the tiebreak and apps/web
  // sorts on top of this (see compareOpenItems).
  //
  // `status` is deliberately NOT in this order. It sorted ASC, and
  // alphabetically that is done < in_progress < open -- putting COMPLETED work
  // first, the exact opposite of the comment that used to sit here. It was
  // invisible only because the page splits done from outstanding before
  // rendering.
  q.searchParams.set("order", "due_date.asc.nullslast,created_at.asc");
  q.searchParams.set("limit", String(LIST_LIMIT));

  // THE PERMISSION BOUNDARY. Admins skip it; everyone else is confined to the
  // locations they contact-match, regardless of what they asked for.
  if (!g.access.isAdmin) {
    if (location) {
      if (!canRead(g.access, location)) return jsonError(403, "forbidden");
      q.searchParams.set("location_code", `eq.${location}`);
    } else {
      q.searchParams.set(
        "location_code",
        `in.(${quoteIn(g.access.locationCodes)})`
      );
    }
  } else if (location) {
    q.searchParams.set("location_code", `eq.${location}`);
  }

  if (status && (STATUSES as readonly string[]).includes(status)) {
    q.searchParams.set("status", `eq.${status}`);
  }
  if (submissionId && UUID_RE.test(submissionId)) {
    q.searchParams.set("submission_id", `eq.${submissionId}`);
  }

  try {
    const resp = await fetch(q.toString(), { headers: sbHeaders(env) });
    if (!resp.ok) {
      console.error("[forms.action-items] list failed", resp.status);
      return jsonError(500, "list_failed");
    }
    const items = (await resp.json().catch(() => [])) as ActionItemRow[];
    // Per-row capability, so the page never renders a control the worker will
    // refuse. Derived from the SAME functions the writes gate on, so the two
    // cannot disagree.
    const withCaps = items.map((r) => ({
      ...r,
      can_edit: canEdit(g.access, r.location_code),
      can_verify: canVerify(g.access, r.location_code)
    }));
    return new Response(
      JSON.stringify({
        items: withCaps,
        scope: g.access.isAdmin ? "all" : "scoped",
        locations: g.access.locationCodes,
        limit_hit: items.length >= LIST_LIMIT
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
      }
    );
  } catch (err) {
    console.error("[forms.action-items] list threw", err);
    return jsonError(500, "list_failed");
  }
}

// =============================================================================
// POST /forms/api/action-items
// =============================================================================
//
// An item added by hand, for what the walk-through missed or for splitting one
// ticked question into the several jobs it turned out to be.
//
// Carries NO submission provenance, and the DB enforces that it carries none
// rather than half of it: a submission_id with no field_key would be a row
// nobody could explain later.

export async function handleCreateActionItem(
  env: Env,
  req: Request
): Promise<Response> {
  const sk = requireServiceKey(env);
  if (sk) return sk;
  if (!isOriginAllowed(req)) return jsonError(403, "bad_origin");
  const g = await gate(env, req);
  if (!g.ok) return g.response;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return jsonError(400, "bad_json");
  }

  const allowed = ["location_code", "description", "priority", "due_date"];
  const unknown = Object.keys(body).filter((k) => !allowed.includes(k));
  if (unknown.length > 0) return jsonError(400, "bad_request");

  const locationCode =
    typeof body.location_code === "string" ? body.location_code.trim() : "";
  if (!locationCode) return jsonError(400, "location_required");
  // THE PERMISSION BOUNDARY. The site is caller-supplied here, unlike every
  // other write where it is read off an existing row, so it is checked against
  // the same access the reads use rather than trusted.
  if (!canEdit(g.access, locationCode)) return jsonError(403, "forbidden");

  const description =
    typeof body.description === "string" ? body.description.trim() : "";
  if (!description) return jsonError(400, "description_required");

  const priority =
    typeof body.priority === "string" &&
    (PRIORITIES as readonly string[]).includes(body.priority)
      ? body.priority
      : "Medium";

  let dueDate: string | null = null;
  if (typeof body.due_date === "string" && body.due_date !== "") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(body.due_date)) {
      return jsonError(400, "bad_due_date");
    }
    dueDate = body.due_date;
  }

  try {
    const q = new URL("/rest/v1/action_items", env.SUPABASE_URL);
    const resp = await fetch(q.toString(), {
      method: "POST",
      headers: sbHeaders(env, {
        "Content-Type": "application/json",
        Prefer: "return=representation"
      }),
      body: JSON.stringify({
        location_code: locationCode,
        description: description.slice(0, DESCRIPTION_MAX),
        priority,
        due_date: dueDate,
        status: "open",
        created_by: g.userId,
        created_by_email: g.email
      })
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      console.error("[forms.action-items] create failed", resp.status, text.slice(0, 200));
      return jsonError(500, "create_failed");
    }
    const rows = (await resp.json().catch(() => [])) as ActionItemRow[];
    console.log(
      `[forms.action-items] manual item created at ${locationCode} by ${g.email}`
    );
    return new Response(JSON.stringify({ ok: true, item: rows[0] ?? null }), {
      status: 201,
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    console.error("[forms.action-items] create threw", err);
    return jsonError(500, "create_failed");
  }
}

async function fetchItem(env: Env, id: string): Promise<ActionItemRow | null> {
  const q = new URL("/rest/v1/action_items", env.SUPABASE_URL);
  q.searchParams.set("id", `eq.${id}`);
  q.searchParams.set("select", "*");
  q.searchParams.set("limit", "1");
  const resp = await fetch(q.toString(), { headers: sbHeaders(env) });
  if (!resp.ok) return null;
  const rows = (await resp.json().catch(() => [])) as ActionItemRow[];
  return rows[0] ?? null;
}

// =============================================================================
// PATCH /forms/api/action-items/{id}
// =============================================================================

export async function handlePatchActionItem(
  env: Env,
  req: Request,
  id: string
): Promise<Response> {
  const sk = requireServiceKey(env);
  if (sk) return sk;
  if (!isOriginAllowed(req)) return jsonError(403, "bad_origin");
  if (!UUID_RE.test(id)) return jsonError(400, "bad_id");
  const g = await gate(env, req);
  if (!g.ok) return g.response;

  const item = await fetchItem(env, id);
  // Missing and not-yours are the same answer, so an id cannot be probed to
  // learn whether it exists. Same posture as jotform out-of-scope rows.
  if (!item || !canRead(g.access, item.location_code)) {
    return jsonError(404, "not_found");
  }
  if (!canEdit(g.access, item.location_code)) return jsonError(403, "forbidden");

  // A verified item is frozen. Verification is the RM saying the work is done
  // and checked; if it could then be edited or reopened it would assert
  // nothing. Admin tier is the escape hatch for genuine mistakes.
  if (item.rm_verified_at && !g.access.isAdmin) {
    return jsonError(409, "verified_and_locked");
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return jsonError(400, "bad_json");
  }

  const allowed = ["status", "description", "priority", "due_date"];
  const unknown = Object.keys(body).filter((k) => !allowed.includes(k));
  if (unknown.length > 0) return jsonError(400, "bad_request");

  const patch: Record<string, unknown> = {};

  if ("status" in body) {
    const v = body.status;
    if (typeof v !== "string" || !(STATUSES as readonly string[]).includes(v)) {
      return jsonError(400, "bad_status");
    }
    patch.status = v;
    // completed_at is stamped SERVER-SIDE and cleared on the way back out. A
    // client-supplied completion time is a claim; this is a record. The DB
    // carries the same rule as a check constraint.
    if (v === "done") {
      patch.completed_at = new Date().toISOString();
      patch.completed_by = g.userId;
    } else {
      patch.completed_at = null;
      patch.completed_by = null;
    }
  }

  if ("description" in body) {
    const v = body.description;
    if (typeof v !== "string" || v.trim() === "") {
      return jsonError(400, "bad_description");
    }
    patch.description = v.trim().slice(0, DESCRIPTION_MAX);
  }

  if ("priority" in body) {
    const v = body.priority;
    if (typeof v !== "string" || !(PRIORITIES as readonly string[]).includes(v)) {
      return jsonError(400, "bad_priority");
    }
    patch.priority = v;
  }

  if ("due_date" in body) {
    const v = body.due_date;
    if (v === null || v === "") {
      patch.due_date = null;
    } else if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
      patch.due_date = v;
    } else {
      return jsonError(400, "bad_due_date");
    }
  }

  if (Object.keys(patch).length === 0) return jsonError(400, "nothing_to_update");

  try {
    const q = new URL("/rest/v1/action_items", env.SUPABASE_URL);
    q.searchParams.set("id", `eq.${id}`);
    const resp = await fetch(q.toString(), {
      method: "PATCH",
      headers: sbHeaders(env, {
        "Content-Type": "application/json",
        Prefer: "return=representation"
      }),
      body: JSON.stringify(patch)
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      console.error("[forms.action-items] patch failed", resp.status, text.slice(0, 200));
      return jsonError(500, "update_failed");
    }
    const rows = (await resp.json().catch(() => [])) as ActionItemRow[];
    return new Response(JSON.stringify({ ok: true, item: rows[0] ?? null }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    console.error("[forms.action-items] patch threw", err);
    return jsonError(500, "update_failed");
  }
}

// =============================================================================
// POST /forms/api/action-items/{id}/verify
// =============================================================================

export async function handleVerifyActionItem(
  env: Env,
  req: Request,
  id: string
): Promise<Response> {
  const sk = requireServiceKey(env);
  if (sk) return sk;
  if (!isOriginAllowed(req)) return jsonError(403, "bad_origin");
  if (!UUID_RE.test(id)) return jsonError(400, "bad_id");
  const g = await gate(env, req);
  if (!g.ok) return g.response;

  const item = await fetchItem(env, id);
  if (!item || !canRead(g.access, item.location_code)) {
    return jsonError(404, "not_found");
  }
  if (!canVerify(g.access, item.location_code)) {
    return jsonError(403, "rm_only");
  }
  // Verification asserts the work is finished. Allowing it on an open item
  // would make it a second, parallel status rather than a confirmation of the
  // first. The DB carries this as a check constraint too.
  if (item.status !== "done") return jsonError(409, "not_done");
  if (item.rm_verified_at) {
    return new Response(JSON.stringify({ ok: true, item, unchanged: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  try {
    const q = new URL("/rest/v1/action_items", env.SUPABASE_URL);
    q.searchParams.set("id", `eq.${id}`);
    const resp = await fetch(q.toString(), {
      method: "PATCH",
      headers: sbHeaders(env, {
        "Content-Type": "application/json",
        Prefer: "return=representation"
      }),
      body: JSON.stringify({
        rm_verified_at: new Date().toISOString(),
        rm_verified_by: g.userId
      })
    });
    if (!resp.ok) {
      console.error("[forms.action-items] verify failed", resp.status);
      return jsonError(500, "verify_failed");
    }
    const rows = (await resp.json().catch(() => [])) as ActionItemRow[];
    console.log(`[forms.action-items] verified ${id} by ${g.email}`);
    return new Response(JSON.stringify({ ok: true, item: rows[0] ?? null }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    console.error("[forms.action-items] verify threw", err);
    return jsonError(500, "verify_failed");
  }
}

// =============================================================================
// GET  /forms/api/action-items/{id}/notes
// POST /forms/api/action-items/{id}/notes
// =============================================================================
//
// The running record of what was actually done. Append-only -- there is no
// edit or delete path here on purpose. Authority is the parent item's: anyone
// who can read the item can read and add notes, because the people doing the
// work and the people chasing it are the same two parties.

const NOTE_BODY_MAX = 5000;
/** One item's thread. Generous, and a cap rather than pagination because a
 *  thread that needs paging is a thread nobody is reading. */
const NOTE_THREAD_CAP = 200;

interface ActionItemNoteRow {
  id: string;
  action_item_id: string;
  author_email: string;
  author_user_id: string | null;
  body: string;
  created_at: string;
}

export async function handleListActionItemNotes(
  env: Env,
  req: Request,
  id: string
): Promise<Response> {
  const sk = requireServiceKey(env);
  if (sk) return sk;
  if (!UUID_RE.test(id)) return jsonError(400, "bad_id");
  const g = await gate(env, req);
  if (!g.ok) return g.response;

  const item = await fetchItem(env, id);
  // Missing and not-yours answer identically, so an id cannot be probed.
  if (!item || !canRead(g.access, item.location_code)) {
    return jsonError(404, "not_found");
  }

  try {
    const q = new URL("/rest/v1/action_item_notes", env.SUPABASE_URL);
    q.searchParams.set("action_item_id", `eq.${id}`);
    q.searchParams.set("select", "*");
    q.searchParams.set("order", "created_at.asc");
    q.searchParams.set("limit", String(NOTE_THREAD_CAP));
    const resp = await fetch(q.toString(), { headers: sbHeaders(env) });
    if (!resp.ok) {
      console.error("[forms.action-items] notes list failed", resp.status);
      return jsonError(500, "list_failed");
    }
    const notes = (await resp.json().catch(() => [])) as ActionItemNoteRow[];
    return new Response(JSON.stringify({ notes }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
    });
  } catch (err) {
    console.error("[forms.action-items] notes list threw", err);
    return jsonError(500, "list_failed");
  }
}

export async function handleCreateActionItemNote(
  env: Env,
  req: Request,
  id: string
): Promise<Response> {
  const sk = requireServiceKey(env);
  if (sk) return sk;
  if (!isOriginAllowed(req)) return jsonError(403, "bad_origin");
  if (!UUID_RE.test(id)) return jsonError(400, "bad_id");
  const g = await gate(env, req);
  if (!g.ok) return g.response;

  const item = await fetchItem(env, id);
  if (!item || !canRead(g.access, item.location_code)) {
    return jsonError(404, "not_found");
  }

  // NOT blocked on a verified item, unlike edits. Verification freezes what
  // the item IS; recording what happened to it afterwards is not a state
  // change, and "RM verified, then the part failed again" is exactly the sort
  // of thing that must stay sayable.

  let body: { body?: unknown };
  try {
    body = (await req.json()) as { body?: unknown };
  } catch {
    return jsonError(400, "bad_json");
  }
  const raw = typeof body.body === "string" ? body.body.trim() : "";
  if (raw === "") return jsonError(400, "empty_body");

  try {
    const q = new URL("/rest/v1/action_item_notes", env.SUPABASE_URL);
    const resp = await fetch(q.toString(), {
      method: "POST",
      headers: sbHeaders(env, {
        "Content-Type": "application/json",
        Prefer: "return=representation"
      }),
      body: JSON.stringify({
        action_item_id: id,
        author_email: g.email,
        author_user_id: g.userId,
        body: raw.slice(0, NOTE_BODY_MAX)
      })
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      console.error("[forms.action-items] note insert failed", resp.status, text.slice(0, 200));
      return jsonError(500, "create_failed");
    }
    const rows = (await resp.json().catch(() => [])) as ActionItemNoteRow[];
    return new Response(JSON.stringify({ ok: true, note: rows[0] ?? null }), {
      status: 201,
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    console.error("[forms.action-items] note insert threw", err);
    return jsonError(500, "create_failed");
  }
}
