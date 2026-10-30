// Golden Ticket — CRD work queue API.
//
//   GET  /admin/jotform/api/golden-ticket/wins?promo=&status=&q=&location=&rd=&rm=&from=&to=
//   GET  /admin/jotform/api/golden-ticket/wins.xlsx?(same params)  -- the current
//        view as an Excel file, every field except the photo
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
import { buildXlsxWorkbook } from "@splash/xlsx";
import {
  ACCESS_TAG,
  STATUSES,
  WIN_COLUMNS,
  easternWallClock,
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
    if (rest.length === 1 && rest[0] === "wins.xlsx") {
      if (request.method !== "GET") return jsonError(405, "method not allowed");
      return await exportWins(request, env, g);
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
  const q = await loadQueue(env, g, new URL(request.url).searchParams);

  let link = null;
  try {
    link = lookupPath((await loadSettings(env)).lookup_token);
  } catch (err) {
    console.error("[golden-ticket] settings read failed", err);
  }

  return json({
    wins: q.wins,
    counts: q.counts,
    cap_reached: q.capReached,
    promos: q.promos,
    promo: q.promo,
    current_promo_id: q.currentPromoId,
    status: q.status,
    filters: q.filters,
    roster: q.roster,
    can_admin: g.admin,
    is_agent: q.scope.isAgent,
    is_supervisor: q.scope.isSupervisor,
    lookup_path: link
  });
}

/**
 * The queue as the page shows it. Promo + location / RD / RM / date narrow
 * the set and the counts come from that set; then the status tab and search
 * pick the visible rows. Shared by the JSON list and the Excel export, so the
 * download is always exactly what is on screen.
 *
 *   location  site number
 *   rd        Regional Director email (locations.am_email)
 *   rm        Regional Manager email (locations.rm_email)
 *   from, to  YYYY-MM-DD, the Eastern day the ticket was redeemed (won_on)
 */
async function loadQueue(env, g, sp) {
  const [promos, roster, scope] = await Promise.all([
    listPromos(env),
    loadRoster(env),
    callerCoverage(env, g.session.email)
  ]);
  const current = promoCovering(promos, todayEastern());

  // promo: a promo id, "all", or "none" (wins dated outside every promo --
  // a sign a promo's dates are wrong). Defaults to today's promo.
  let promo = sp.get("promo") || (current ? current.id : "all");
  if (promo !== "all" && promo !== "none" && !UUID_RE.test(promo)) promo = "all";

  // Unknown values are dropped rather than refused, so an old link still opens.
  const knownEmail = (field, v) => {
    const e = String(v ?? "").trim().toLowerCase();
    return e && roster.some((r) => r[field] === e) ? e : "";
  };
  const locParam = siteKey(sp.get("location"));
  const filters = {
    location: locParam && roster.some((r) => r.site_key === locParam) ? locParam : "",
    rd: knownEmail("am_email", sp.get("rd")),
    rm: knownEmail("rm_email", sp.get("rm")),
    from: realDate(sp.get("from")),
    to: realDate(sp.get("to"))
  };
  if (filters.from && filters.to && filters.from > filters.to) {
    [filters.from, filters.to] = [filters.to, filters.from];
  }

  const query = { select: WIN_COLUMNS, order: "submitted_at.desc", limit: String(WIN_CAP + 1) };
  if (promo === "none") query.promo_id = "is.null";
  else if (promo !== "all") query.promo_id = `eq.${promo}`;
  const range = [];
  if (filters.from) range.push(`won_on.gte.${filters.from}`);
  if (filters.to) range.push(`won_on.lte.${filters.to}`);
  if (range.length) query.and = `(${range.join(",")})`;

  const siteFiltered = Boolean(filters.location || filters.rd || filters.rm);
  const sites = siteFiltered
    ? roster
        .filter(
          (r) =>
            (!filters.location || r.site_key === filters.location) &&
            (!filters.rd || r.am_email === filters.rd) &&
            (!filters.rm || r.rm_email === filters.rm)
        )
        .map((r) => r.site_key)
    : null;
  let rows = [];
  // An RD + RM pair that shares no site matches nothing; skip the query.
  if (!sites || sites.length) {
    if (sites) {
      // jotform_submissions.site_number is sometimes zero-padded ("090") and
      // sometimes not ("127"); ask for both spellings.
      const variants = new Set(sites.flatMap((k) => [k, k.padStart(3, "0")]));
      query.site_number = `in.(${[...variants].join(",")})`;
    }
    rows = (await sb(env, "golden_ticket_wins", { query })) ?? [];
  }
  const capReached = rows.length > WIN_CAP;
  if (capReached) rows.length = WIN_CAP;

  const isOpen = (r) => r.status === "new" || r.status === "in_progress";
  const inMine = (r) => scope.mine.has(siteKey(r.site_number));
  const inTeam = (r) => {
    const k = siteKey(r.site_number);
    return scope.team.has(k) || (scope.isSupervisor && !scope.covered.has(k));
  };

  // Counts come from the filtered set BEFORE the status / search filter.
  const counts = { mine: 0, team: 0, open: 0, new: 0, in_progress: 0, done: 0, void: 0, all: rows.length, duplicates: 0 };
  for (const r of rows) {
    counts[r.status] = (counts[r.status] ?? 0) + 1;
    if (isOpen(r)) {
      counts.open++;
      if (inMine(r)) counts.mine++;
      if (inTeam(r)) counts.team++;
    }
    if (r.dup_count > 1) counts.duplicates++;
  }

  // Default tab: your own sites if you are an agent, your regions if you only
  // supervise, otherwise everything open (admins).
  const status = sp.get("status") || (scope.isAgent ? "mine" : scope.isSupervisor ? "team" : "open");
  const q = (sp.get("q") || "").trim().toLowerCase();
  const words = q.split(/\s+/).filter(Boolean);
  const qPlate = q.replace(/[^a-z0-9]/g, "").toUpperCase();

  const visible = rows
    .filter((r) => {
      if (status === "mine") return isOpen(r) && inMine(r);
      if (status === "team") return isOpen(r) && inTeam(r);
      if (status === "open") return isOpen(r);
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
    });

  const byPlate = await duplicatePartners(env, rows, visible, siteFiltered || range.length > 0);
  const wins = visible.map((r) => ({
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

  return {
    wins,
    counts,
    capReached,
    promos,
    promo,
    currentPromoId: current ? current.id : null,
    status,
    filters,
    roster: roster.map((r) => ({
      site_number: r.site_key,
      site: r.site,
      area_manager: r.area_manager,
      am_email: r.am_email,
      regional_manager: r.regional_manager,
      rm_email: r.rm_email
    })),
    scope
  };
}

/** "YYYY-MM-DD" when it is a real calendar day, else "". The shape check
 *  alone lets "2026-13-99" through to Postgres, which refuses it with a 400
 *  and the whole page errors instead of ignoring a bad link. */
function realDate(v) {
  const s = String(v ?? "");
  if (!DATE_RE.test(s)) return "";
  const [y, m, d] = s.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? s : "";
}

const PARTNER_COLUMNS =
  "submission_id,promo_id,plate_norm,won_on,site_name,site_number,prize_code,customer_name,photo_url,status";
const PARTNER_PLATE_CAP = 300;

/**
 * Non-void wins per promo+plate, for the duplicate side-by-side. A location
 * or date filter can hide a duplicate's twin (another site, another day), and
 * the twin is the whole point of the warning -- so with a filter on, look the
 * twins up directly. With no filter the promo's rows already hold them.
 */
async function duplicatePartners(env, rows, visible, filtered) {
  const group = (list) => {
    const m = new Map();
    for (const r of list) {
      if (!r.plate_norm || !r.promo_id || r.status === "void") continue;
      const key = `${r.promo_id}|${r.plate_norm}`;
      const l = m.get(key) ?? [];
      l.push(r);
      m.set(key, l);
    }
    return m;
  };
  const dups = visible.filter((r) => r.dup_count > 1 && r.promo_id && r.plate_norm);
  if (!filtered || dups.length === 0) return group(rows);
  const plates = [...new Set(dups.map((r) => r.plate_norm))];
  if (plates.length > PARTNER_PLATE_CAP) return group(rows);
  const promoIds = [...new Set(dups.map((r) => r.promo_id))];
  try {
    // plate_norm is A-Z0-9 only and promo ids are UUIDs, so both are safe
    // unquoted inside in.(...).
    const partners = await sb(env, "golden_ticket_wins", {
      query: {
        select: PARTNER_COLUMNS,
        plate_norm: `in.(${plates.join(",")})`,
        promo_id: `in.(${promoIds.join(",")})`,
        status: "neq.void"
      }
    });
    return group(partners ?? []);
  } catch (err) {
    console.error("[golden-ticket] duplicate lookup failed", err);
    return group(rows);
  }
}

/**
 * Every location with a site number, with its Regional Director
 * (area_manager / am_email) and Regional Manager (regional_manager /
 * rm_email) -- legacy column names, see CLAUDE.md "Regional Director /
 * Regional Manager". Emails lower-cased for comparison.
 */
async function loadRoster(env) {
  const rows =
    (await sb(env, "locations", {
      query: { select: "site_number,site,area_manager,am_email,regional_manager,rm_email" }
    })) ?? [];
  const lower = (v) => String(v ?? "").trim().toLowerCase();
  const trim = (v) => String(v ?? "").trim();
  return rows
    .map((r) => ({
      site_key: siteKey(r.site_number),
      site: trim(r.site) || `Site ${r.site_number}`,
      area_manager: trim(r.area_manager),
      am_email: lower(r.am_email),
      regional_manager: trim(r.regional_manager),
      rm_email: lower(r.rm_email)
    }))
    .filter((r) => r.site_key)
    .sort((a, b) => a.site.localeCompare(b.site));
}

/* ------------------------------------------------------------------------ */

const PRIZE_LABEL = { GT30: "Free month", GT365: "Free year", GTLIFE: "Free for life" };
const STATUS_LABEL = { new: "New", in_progress: "In progress", done: "Done", void: "Void" };

/** Every submission field except the photo, plus CRD's work. */
const XLSX_COLUMNS = [
  { header: "Won on", width: 12, kind: "date" },
  { header: "Submitted (Eastern)", width: 19, kind: "datetime" },
  { header: "Promo", width: 22, kind: "text" },
  { header: "Site #", width: 8, kind: "text" },
  { header: "Site", width: 20, kind: "text" },
  { header: "Regional Director", width: 20, kind: "text" },
  { header: "Regional Manager", width: 20, kind: "text" },
  { header: "Customer", width: 24, kind: "text" },
  { header: "Phone", width: 16, kind: "text" },
  { header: "Plate", width: 12, kind: "text" },
  { header: "Barcode", width: 16, kind: "text" },
  { header: "Active Unlimited already?", width: 14, kind: "text" },
  { header: "Prize", width: 14, kind: "text" },
  { header: "Prize code", width: 10, kind: "text" },
  { header: "Ticket serial", width: 16, kind: "text" },
  { header: "Employee", width: 20, kind: "text" },
  { header: "Status", width: 12, kind: "text" },
  { header: "Account set up", width: 10, kind: "text" },
  { header: "Micrologic tagged", width: 10, kind: "text" },
  { header: "Wins for this plate in promo", width: 12, kind: "number" },
  { header: "Last CRD update (Eastern)", width: 19, kind: "datetime" },
  { header: "Last CRD update by", width: 26, kind: "text" },
  { header: "CRD notes", width: 60, kind: "wrap" },
  { header: "JotForm submission ID", width: 22, kind: "text" }
];

async function exportWins(request, env, g) {
  const q = await loadQueue(env, g, new URL(request.url).searchParams);
  const people = new Map(q.roster.map((r) => [r.site_number, r]));
  const rows = q.wins.map((w) => {
    const who = people.get(siteKey(w.site_number));
    const notes = (Array.isArray(w.history) ? w.history : [])
      .filter((h) => h && h.note)
      .map((h) => `${easternWallClock(h.at).slice(0, 16)} ${h.by ?? "unknown"}: ${h.note}`)
      .join("\n");
    return [
      w.won_on ?? "",
      easternWallClock(w.submitted_at),
      w.promo_name ?? "Outside any promo",
      w.site_number ?? "",
      w.site_name ?? "",
      who?.area_manager ?? "",
      who?.regional_manager ?? "",
      w.customer_name ?? "",
      w.phone ?? "",
      w.plate ?? "",
      w.barcode ?? "",
      w.existing_unlimited ?? "",
      (w.prize_code && PRIZE_LABEL[w.prize_code]) || w.prize || "",
      w.prize_code ?? "",
      w.ticket_serial ?? "",
      w.employee_name ?? "",
      STATUS_LABEL[w.status] ?? w.status ?? "",
      w.account_setup ? "Yes" : "No",
      w.micrologic_tagged ? "Yes" : "No",
      w.dup_count || "",
      easternWallClock(w.crd_updated_at),
      w.crd_updated_by ?? "",
      notes,
      w.submission_id
    ];
  });
  const bytes = buildXlsxWorkbook(XLSX_COLUMNS, rows, "Golden Ticket");
  return new Response(bytes.buffer, {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="golden-ticket-${todayEastern()}.xlsx"`,
      "Cache-Control": "no-store"
    }
  });
}

/** Site numbers as a comparable key: "090", "90" and 90 are the same site. */
function siteKey(v) {
  const n = Number.parseInt(String(v ?? "").replace(/\D/g, ""), 10);
  return Number.isFinite(n) ? String(n) : "";
}

/**
 * The caller's CRD coverage, from the same tables the win emails use:
 *   mine    -- sites where they are crd_email (the agent)
 *   team    -- every site in a region they supervise
 *   covered -- every site with a coverage row; a supervisor's view also takes
 *              wins at UNCOVERED sites, because those emails go to every
 *              supervisor (golden-ticket/notify.js)
 * Fail-soft to "no coverage": the tabs disappear, the queue still works.
 */
async function callerCoverage(env, email) {
  const out = { mine: new Set(), team: new Set(), covered: new Set(), isAgent: false, isSupervisor: false };
  const me = String(email ?? "").trim().toLowerCase();
  if (!me) return out;
  try {
    const [coverage, regions] = await Promise.all([
      sb(env, "crd_site_coverage", { query: { select: "site_number,crd_email,crd_region" } }),
      sb(env, "crd_regions", { query: { select: "region,supervisor_email" } })
    ]);
    const myRegions = new Set(
      (regions ?? [])
        .filter((r) => String(r.supervisor_email ?? "").trim().toLowerCase() === me)
        .map((r) => r.region)
    );
    out.isSupervisor = myRegions.size > 0;
    for (const c of coverage ?? []) {
      const k = siteKey(c.site_number);
      if (!k) continue;
      out.covered.add(k);
      if (String(c.crd_email ?? "").trim().toLowerCase() === me) out.mine.add(k);
      if (c.crd_region && myRegions.has(c.crd_region)) out.team.add(k);
    }
    out.isAgent = out.mine.size > 0;
  } catch (err) {
    console.error("[golden-ticket] coverage read failed", err);
  }
  return out;
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
