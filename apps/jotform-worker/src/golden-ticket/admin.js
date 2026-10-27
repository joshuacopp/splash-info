// Golden Ticket — CRD work queue API.
//
//   GET  /admin/jotform/api/golden-ticket/wins?promo=&status=&q=
//   POST /admin/jotform/api/golden-ticket/wins/{submission_id}
//        JSON {status?, account_setup?, micrologic_tagged?, note?}
//   POST /admin/jotform/api/golden-ticket/promos          (admin tier)
//        JSON {id?, name, starts_on, ends_on}
//   POST /admin/jotform/api/golden-ticket/promos/{id}/delete   (admin tier)
//   POST /admin/jotform/api/golden-ticket/lookup-link     (admin tier)
//        JSON {action: "new" | "off"}
//
// WHO: full admin tier (super_admin, dc_role admin / super_admin), OR anyone
// holding the `golden_ticket` form access tag (granted in Sysadmin, same
// checkbox list as the custom-forms tags). CRD works every site, so this is
// org-wide by design -- NOT the per-site scoping the generic JotForm viewer
// uses. Promos and the lookup link are admin-tier only.
//
// The caller (handlers/admin.js) has already run isOriginAllowed.

import { authenticate } from "@splash/auth";
import { jsonError } from "@splash/http";
import {
  ACCESS_TAG,
  STATUSES,
  WIN_COLUMNS,
  listPromos,
  loadSettings,
  lookupPath,
  promoCovering,
  randomToken,
  sb,
  todayEastern
} from "./shared.js";

const WIN_CAP = 2000;
const NOTE_MAX = 2000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUBMISSION_ID_RE = /^[0-9]{6,30}$/;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}

function isAdminTier(session) {
  return (
    session.role === "super_admin" ||
    session.dcRole === "admin" ||
    session.dcRole === "super_admin"
  );
}

/** Admin tier, or the golden_ticket tag. A failed grant read counts as "no
 *  grant" (fails closed) and is logged, so it reads as an outage and not as
 *  CRD silently losing access. */
async function gate(request, env) {
  if (!env.SUPABASE_SERVICE_KEY) {
    return { ok: false, response: jsonError(503, "SUPABASE_SERVICE_KEY unbound") };
  }
  const auth = await authenticate(request, env);
  if (auth.status !== "authenticated") {
    return { ok: false, response: jsonError(401, "unauthorized") };
  }
  const session = auth.session;
  if (isAdminTier(session)) return { ok: true, session, admin: true };
  try {
    const rows = await sb(env, "form_access_grants", {
      query: {
        user_id: `eq.${session.userId}`,
        tag: `eq.${ACCESS_TAG}`,
        select: "tag",
        limit: "1"
      }
    });
    if (Array.isArray(rows) && rows.length > 0) return { ok: true, session, admin: false };
  } catch (err) {
    console.error("[golden-ticket] grant read failed", err);
  }
  return { ok: false, response: jsonError(403, "forbidden") };
}

export async function handleGoldenTicketAdmin(request, env, path) {
  const rest = path.slice("/admin/jotform/api/golden-ticket/".length).split("/").filter(Boolean);

  const g = await gate(request, env);
  if (!g.ok) return g.response;

  try {
    if (rest.length === 1 && rest[0] === "wins") {
      if (request.method !== "GET") return jsonError(405, "method not allowed");
      return await listWins(request, env, g);
    }
    if (rest.length === 2 && rest[0] === "wins") {
      if (request.method !== "POST") return jsonError(405, "method not allowed");
      return await updateWin(request, env, g, rest[1]);
    }
    if (rest[0] === "promos" || rest[0] === "lookup-link") {
      if (request.method !== "POST") return jsonError(405, "method not allowed");
      if (!g.admin) return jsonError(403, "Only admins can change promos and the lookup link.");
      if (rest.length === 1 && rest[0] === "promos") return await savePromo(request, env, g);
      if (rest.length === 3 && rest[0] === "promos" && rest[2] === "delete") {
        return await deletePromo(env, rest[1]);
      }
      if (rest.length === 1 && rest[0] === "lookup-link") return await changeLink(request, env, g);
    }
  } catch (err) {
    console.error("[golden-ticket] admin handler failed", err);
    return jsonError(500, "Something went wrong. Try again.");
  }
  return jsonError(404, "not found");
}

/* ------------------------------------------------------------------------ */

async function listWins(request, env, g) {
  const url = new URL(request.url);
  const promos = await listPromos(env);
  const today = todayEastern();
  const current = promoCovering(promos, today);

  // promo: a promo id, "all", or "none" (wins dated outside every promo --
  // a sign a promo's dates are wrong). Defaults to today's promo.
  let promo = url.searchParams.get("promo") || (current ? current.id : "all");
  if (promo !== "all" && promo !== "none" && !UUID_RE.test(promo)) promo = "all";

  const query = { select: WIN_COLUMNS, order: "submitted_at.desc", limit: String(WIN_CAP + 1) };
  if (promo === "none") query.promo_id = "is.null";
  else if (promo !== "all") query.promo_id = `eq.${promo}`;
  const rows = (await sb(env, "golden_ticket_wins", { query })) ?? [];
  const capReached = rows.length > WIN_CAP;
  if (capReached) rows.length = WIN_CAP;

  // Counts and duplicate partners come from the whole promo, BEFORE the
  // status / search filter, so a duplicate whose twin is already Done still
  // shows its twin.
  const counts = { open: 0, new: 0, in_progress: 0, done: 0, void: 0, all: rows.length, duplicates: 0 };
  const byPlate = new Map();
  for (const r of rows) {
    counts[r.status] = (counts[r.status] ?? 0) + 1;
    if (r.status === "new" || r.status === "in_progress") counts.open++;
    if (r.dup_count > 1) counts.duplicates++;
    if (r.plate_norm && r.promo_id && r.status !== "void") {
      const key = `${r.promo_id}|${r.plate_norm}`;
      const list = byPlate.get(key) ?? [];
      list.push(r);
      byPlate.set(key, list);
    }
  }

  const status = url.searchParams.get("status") || "open";
  const q = (url.searchParams.get("q") || "").trim().toLowerCase();
  const words = q.split(/\s+/).filter(Boolean);
  const qPlate = q.replace(/[^a-z0-9]/g, "").toUpperCase();

  const wins = rows
    .filter((r) => {
      if (status === "open") return r.status === "new" || r.status === "in_progress";
      if (status === "duplicates") return r.dup_count > 1;
      if (STATUSES.includes(status)) return r.status === status;
      return true;
    })
    .filter((r) => {
      if (!words.length) return true;
      if (qPlate.length >= 2 && r.plate_norm && r.plate_norm.includes(qPlate)) return true;
      const hay = [r.customer_name, r.phone, r.plate, r.ticket_serial, r.barcode, r.site_name, r.site_number, r.employee_name]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return words.every((w) => hay.includes(w));
    })
    .map((r) => ({
      ...r,
      duplicates:
        r.dup_count > 1
          ? (byPlate.get(`${r.promo_id}|${r.plate_norm}`) ?? [])
              .filter((o) => o.submission_id !== r.submission_id)
              .map((o) => ({
                submission_id: o.submission_id,
                won_on: o.won_on,
                site_name: o.site_name,
                site_number: o.site_number,
                prize_code: o.prize_code,
                customer_name: o.customer_name,
                photo_url: o.photo_url,
                status: o.status
              }))
          : []
    }));

  let link = null;
  try {
    link = lookupPath((await loadSettings(env)).lookup_token);
  } catch (err) {
    console.error("[golden-ticket] settings read failed", err);
  }

  return json({
    wins,
    counts,
    cap_reached: capReached,
    promos,
    promo,
    current_promo_id: current ? current.id : null,
    status,
    can_admin: g.admin,
    lookup_path: link
  });
}

/* ------------------------------------------------------------------------ */

async function readJson(request) {
  try {
    const body = await request.json();
    return body && typeof body === "object" && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

async function updateWin(request, env, g, submissionId) {
  if (!SUBMISSION_ID_RE.test(submissionId)) return jsonError(404, "not found");
  const body = await readJson(request);
  if (!body) return jsonError(400, "Bad request.");

  // Must be a golden ticket submission -- the view only holds those.
  const found = await sb(env, "golden_ticket_wins", {
    query: {
      submission_id: `eq.${submissionId}`,
      select: "submission_id,status,account_setup,micrologic_tagged,history",
      limit: "1"
    }
  });
  const cur = Array.isArray(found) ? found[0] : null;
  if (!cur) return jsonError(404, "That win no longer exists. Reload the page.");

  const next = {
    status: cur.status,
    account_setup: cur.account_setup,
    micrologic_tagged: cur.micrologic_tagged
  };
  if (body.status !== undefined) {
    if (!STATUSES.includes(body.status)) return jsonError(400, "Pick a status.");
    next.status = body.status;
  }
  for (const k of ["account_setup", "micrologic_tagged"]) {
    if (body[k] !== undefined) {
      if (typeof body[k] !== "boolean") return jsonError(400, "Bad request.");
      next[k] = body[k];
    }
  }
  const note = typeof body.note === "string" ? body.note.trim() : "";
  if (note.length > NOTE_MAX) return jsonError(400, `Notes are limited to ${NOTE_MAX} characters.`);

  const changes = {};
  for (const k of Object.keys(next)) if (next[k] !== cur[k]) changes[k] = [cur[k], next[k]];
  if (!Object.keys(changes).length && !note) return json({ ok: true, unchanged: true });

  const actor = g.session.email || null;
  const entry = { at: new Date().toISOString(), by: actor, changes };
  if (note) entry.note = note;
  const history = [...(Array.isArray(cur.history) ? cur.history : []), entry];

  await sb(env, "golden_ticket_crd", {
    method: "POST",
    query: { on_conflict: "submission_id" },
    prefer: "resolution=merge-duplicates,return=minimal",
    body: [
      {
        submission_id: submissionId,
        ...next,
        history,
        updated_at: entry.at,
        updated_by: actor
      }
    ]
  });
  return json({ ok: true });
}

/* ------------------------------------------------------------------------ */

async function savePromo(request, env, g) {
  const body = await readJson(request);
  if (!body) return jsonError(400, "Bad request.");
  const id = typeof body.id === "string" && body.id ? body.id : null;
  if (id && !UUID_RE.test(id)) return jsonError(400, "That promo could not be identified. Reload the page.");
  const name = typeof body.name === "string" ? body.name.replace(/\s+/g, " ").trim() : "";
  const startsOn = typeof body.starts_on === "string" ? body.starts_on : "";
  const endsOn = typeof body.ends_on === "string" ? body.ends_on : "";
  if (!name || name.length > 120) return jsonError(400, "Give the promo a name (up to 120 characters).");
  if (!DATE_RE.test(startsOn) || !DATE_RE.test(endsOn)) return jsonError(400, "Enter a start and end date.");
  if (endsOn < startsOn) return jsonError(400, "The end date is before the start date.");

  // Overlap would make "which promo does this win belong to" ambiguous.
  const promos = await listPromos(env);
  const clash = promos.find((p) => p.id !== id && p.starts_on <= endsOn && startsOn <= p.ends_on);
  if (clash) {
    return jsonError(
      409,
      `Those dates overlap "${clash.name}" (${clash.starts_on} to ${clash.ends_on}). Promos can't overlap.`
    );
  }

  const actor = g.session.email || null;
  const row = { name, starts_on: startsOn, ends_on: endsOn, updated_by: actor, updated_at: new Date().toISOString() };
  if (id) {
    const res = await sb(env, "golden_ticket_promos", {
      method: "PATCH",
      query: { id: `eq.${id}` },
      prefer: "return=representation",
      body: row
    });
    if (!Array.isArray(res) || res.length === 0) return jsonError(404, "That promo no longer exists. Reload the page.");
    return json({ ok: true, id });
  }
  const res = await sb(env, "golden_ticket_promos", {
    method: "POST",
    prefer: "return=representation",
    body: [{ ...row, created_by: actor }]
  });
  return json({ ok: true, id: Array.isArray(res) && res[0] ? res[0].id : null }, 201);
}

async function deletePromo(env, id) {
  if (!UUID_RE.test(id)) return jsonError(404, "not found");
  // Wins are not deleted -- they simply stop belonging to a promo and show
  // under "Outside any promo" until a promo covers their date again.
  const res = await sb(env, "golden_ticket_promos", {
    method: "DELETE",
    query: { id: `eq.${id}` },
    prefer: "return=representation"
  });
  if (!Array.isArray(res) || res.length === 0) return jsonError(404, "That promo is already gone. Reload the page.");
  return json({ ok: true });
}

async function changeLink(request, env, g) {
  const body = await readJson(request);
  const action = body && body.action;
  if (action !== "new" && action !== "off") return jsonError(400, "Bad request.");
  const token = action === "new" ? randomToken(24) : null;
  await sb(env, "golden_ticket_settings", {
    method: "PATCH",
    query: { id: "eq.1" },
    prefer: "return=minimal",
    body: { lookup_token: token, updated_at: new Date().toISOString(), updated_by: g.session.email || null }
  });
  console.log(`[golden-ticket] lookup link ${action === "new" ? "replaced" : "turned off"} by ${g.session.email}`);
  return json({ ok: true, lookup_path: lookupPath(token) });
}
