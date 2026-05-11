// Admin-gated submissions viewer endpoints (Brief 83 + Brief 87 + Brief 105).
//
// Four routes, mounted via the early-router branch in src/index.js:
//
//   GET /admin/api/submissions?from=&to=&limit=
//     JSON list of fleet_submissions in the date range, capped at 200.
//
//   GET /admin/api/submissions/{id}
//     JSON detail for a single fleet_submissions row, or 404.
//
//   PATCH /admin/api/submissions/{id}     (Brief 87 / widened in Brief 105)
//     Update `splash_notes` and/or `status` on a single row. Body accepts
//     either or both:
//       { splash_notes?: string, status?: 'new'|'reviewed'|'contacted'|'closed' }
//     Brief 105 stamps `splash_notes_updated_{at,by}` / `status_updated_{at,by}`
//     audit columns per-field on each PATCH, and fires the optional
//     `FLEET_SUBMISSION_UPDATE_WEBHOOK_URL` webhook for SharePoint sync.
//
//   GET /admin/api/submissions.csv?from=&to=
//     RFC 4180 CSV with Content-Disposition: attachment. Same date filter as
//     the JSON list endpoint, no row cap besides a 10000 safety ceiling.
//
// Auth: cookie-based session via @splash/auth. Allowed when either:
//   - session.role === "super_admin"      (global admin)
//   - session.dcRole === "admin"          (damage-claim admin tier — Brett /
//                                          Scott / Josh per Brief 42); these
//                                          users are operationally trusted at
//                                          the same level as super_admin for
//                                          read-only fleet visibility.
//   - session.dcRole === "super_admin"    (covered by role check usually but
//                                          included for defense-in-depth)
//
// Filtering: server-side gte/lte on `fleet_submissions.submitted_at` via
// PostgREST query params. `submitted_at` is the only timestamp column on the
// table — written by the public submit handler in `src/index.js` (see the
// `submitted_at: new Date().toISOString()` line).
//
// CSRF: GET-only handlers; isOriginAllowed is enforced as defense-in-depth
// even though GETs aren't traditionally CSRFable. Service-binding callers
// from apps/web set Origin to the worker's URL origin (or `https://internal`
// when the placeholder host is used) — both pass.
//
// SUPABASE_SERVICE_KEY: required for these endpoints. The public form routes
// continue to use SUPABASE_ANON_KEY for read-through-RLS posture; the admin
// reads here use the service key for unfiltered fleet_submissions visibility.
// Operator must bind SUPABASE_SERVICE_KEY before /admin/api/* will work.

import { authenticate } from "@splash/auth";
import { isOriginAllowed, json, jsonError } from "@splash/http";

const ROW_LIMIT = 200;
const CSV_SAFETY_CAP = 10_000;
const DEFAULT_WINDOW_DAYS = 30;
const SPLASH_NOTES_MAX_LEN = 10_000;

// Brief 105 — status enum kept in sync with the apps/web constants in
// apps/web/app/admin/fleet/_lib/constants.ts. Worker is the authoritative
// validator; the apps/web dropdown is a UX hint only.
const ALLOWED_STATUSES = new Set(["new", "reviewed", "contacted", "closed"]);

/**
 * CSV column inventory. `key` reads the column directly from the row;
 * `get` is a derived value (used for packages_detail JSON pretty-printing).
 * Columns mirror the user-facing fields written by the public submit
 * handler in `src/index.js` plus the implicit `id` and `submitted_at`.
 */
const CSV_COLUMNS = [
  { key: "id", label: "id" },
  { key: "submitted_at", label: "submitted_at" },
  { key: "company", label: "company" },
  { key: "name", label: "name" },
  { key: "phone", label: "phone" },
  { key: "email", label: "email" },
  { key: "address", label: "address" },
  { key: "location_code", label: "location_code" },
  { key: "location_pretty", label: "location_pretty" },
  { key: "service_type", label: "service_type" },
  { key: "packages", label: "packages" },
  {
    label: "packages_detail",
    get: (r) => (r.packages_detail == null ? "" : JSON.stringify(r.packages_detail))
  },
  { key: "detailing_requested", label: "detailing_requested" },
  { key: "detailing_location_code", label: "detailing_location_code" },
  { key: "detailing_location_pretty", label: "detailing_location_pretty" },
  { key: "number_of_vehicles", label: "number_of_vehicles" },
  { key: "anticipated_washes_per_month", label: "anticipated_washes_per_month" },
  { key: "ip_address", label: "ip_address" },
  { key: "user_agent", label: "user_agent" },
  { key: "status", label: "status" },
  { key: "splash_notes", label: "splash_notes" }
];

/* ============================================================
 * Router entry — called from src/index.js
 * ============================================================ */

export async function handleAdminApi(request, env, _ctx) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, PATCH, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Cookie"
      }
    });
  }

  if (request.method !== "GET" && request.method !== "PATCH") {
    return jsonError(405, "method not allowed");
  }

  if (!isOriginAllowed(request)) {
    // Note: localhost-shaped origins are accepted (dev), and apps/web service-
    // binding callers reach us with Origin === request URL origin, which also
    // passes. This rejects only true cross-origin GETs from a browser tab.
    return jsonError(403, "bad origin");
  }

  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/admin/api/submissions") {
    if (request.method !== "GET") return jsonError(405, "method not allowed");
    return handleListSubmissions(request, env);
  }
  if (path === "/admin/api/submissions.csv") {
    if (request.method !== "GET") return jsonError(405, "method not allowed");
    return handleCsvExport(request, env);
  }
  const detailMatch = path.match(/^\/admin\/api\/submissions\/([A-Za-z0-9_-]+)$/);
  if (detailMatch) {
    if (request.method === "PATCH") {
      return handleUpdateSubmission(request, env, detailMatch[1]);
    }
    return handleGetSubmission(request, env, detailMatch[1]);
  }

  return jsonError(404, "not found");
}

/* ============================================================
 * Auth gate
 * ============================================================ */

/**
 * Validates cookie session and confirms the user holds an admin-tier role.
 * Returns the session on success or a typed error response on failure.
 */
async function authenticateAdmin(request, env) {
  if (!env.SUPABASE_SERVICE_KEY) {
    // Auth requires the service key (createServiceClient inside @splash/auth
    // reads SUPABASE_SERVICE_KEY). Surface a 503 so the caller can show a
    // configuration-required state rather than a confusing 500.
    return { ok: false, response: jsonError(503, "admin endpoints not configured (SUPABASE_SERVICE_KEY unbound)") };
  }
  const auth = await authenticate(request, env);
  if (auth.status !== "authenticated") {
    return { ok: false, response: jsonError(401, "unauthorized") };
  }
  const { session } = auth;
  const allowed =
    session.role === "super_admin" ||
    session.dcRole === "admin" ||
    session.dcRole === "super_admin";
  if (!allowed) {
    return { ok: false, response: jsonError(403, "forbidden") };
  }
  return { ok: true, session };
}

/* ============================================================
 * Date-range parsing
 * ============================================================ */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse `from` / `to` query params. Returns ISO timestamps that bracket the
 * inclusive day range (UTC). Defaults: from = today minus DEFAULT_WINDOW_DAYS,
 * to = today.
 *
 *   { ok: true, fromIso, toIso }
 *   { ok: false, response }    on malformed input
 */
function parseDateRange(url) {
  const fromRaw = url.searchParams.get("from");
  const toRaw = url.searchParams.get("to");

  let fromDate, toDate;
  const now = new Date();
  const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  if (fromRaw == null || fromRaw === "") {
    fromDate = new Date(todayUtc.getTime() - DEFAULT_WINDOW_DAYS * 86_400_000);
  } else {
    if (!DATE_RE.test(fromRaw)) {
      return { ok: false, response: jsonError(400, "Invalid 'from' (expected YYYY-MM-DD)") };
    }
    fromDate = new Date(`${fromRaw}T00:00:00.000Z`);
    if (Number.isNaN(fromDate.getTime())) {
      return { ok: false, response: jsonError(400, "Invalid 'from' date") };
    }
  }

  if (toRaw == null || toRaw === "") {
    toDate = new Date(todayUtc.getTime() + 86_400_000 - 1);
  } else {
    if (!DATE_RE.test(toRaw)) {
      return { ok: false, response: jsonError(400, "Invalid 'to' (expected YYYY-MM-DD)") };
    }
    const toMidnight = new Date(`${toRaw}T00:00:00.000Z`);
    if (Number.isNaN(toMidnight.getTime())) {
      return { ok: false, response: jsonError(400, "Invalid 'to' date") };
    }
    // Include the entire `to` day — push forward 24h minus 1ms.
    toDate = new Date(toMidnight.getTime() + 86_400_000 - 1);
  }

  if (fromDate.getTime() > toDate.getTime()) {
    return { ok: false, response: jsonError(400, "'from' must be on or before 'to'") };
  }

  return {
    ok: true,
    fromIso: fromDate.toISOString(),
    toIso: toDate.toISOString(),
    fromYmd: fromDate.toISOString().slice(0, 10),
    toYmd: toDate.toISOString().slice(0, 10)
  };
}

function parseLimit(url) {
  const raw = url.searchParams.get("limit");
  if (raw == null || raw === "") return ROW_LIMIT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1) {
    return { error: jsonError(400, "Invalid 'limit'") };
  }
  return Math.min(n, ROW_LIMIT);
}

/* ============================================================
 * Handlers
 * ============================================================ */

async function handleListSubmissions(request, env) {
  const gate = await authenticateAdmin(request, env);
  if (!gate.ok) return gate.response;

  const url = new URL(request.url);
  const range = parseDateRange(url);
  if (!range.ok) return range.response;
  const limit = parseLimit(url);
  if (typeof limit === "object" && limit.error) return limit.error;

  const u = new URL(`${env.SUPABASE_URL}/rest/v1/fleet_submissions`);
  u.searchParams.set("select", "*");
  u.searchParams.append("submitted_at", `gte.${range.fromIso}`);
  u.searchParams.append("submitted_at", `lte.${range.toIso}`);
  u.searchParams.set("order", "submitted_at.desc");
  u.searchParams.set("limit", String(limit));

  let resp;
  try {
    resp = await fetch(u.toString(), {
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        Prefer: "count=estimated"
      }
    });
  } catch (err) {
    console.error("fleet admin list fetch error:", err);
    return jsonError(500, "Submissions fetch failed");
  }
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    console.error("fleet admin list non-2xx:", resp.status, errText);
    return jsonError(500, `Submissions fetch failed: ${resp.status}`);
  }
  const rows = (await resp.json().catch(() => [])) || [];
  const contentRange = resp.headers.get("Content-Range") || "";
  let total = null;
  const m = contentRange.match(/\/(\d+|\*)$/);
  if (m && m[1] !== "*") total = Number.parseInt(m[1], 10);

  return json({
    rows: Array.isArray(rows) ? rows : [],
    count: Array.isArray(rows) ? rows.length : 0,
    total: total != null ? total : (Array.isArray(rows) ? rows.length : 0),
    from: range.fromIso,
    to: range.toIso,
    limit,
    limit_hit: Array.isArray(rows) && rows.length === limit
  });
}

async function handleGetSubmission(request, env, id) {
  const gate = await authenticateAdmin(request, env);
  if (!gate.ok) return gate.response;

  const u = new URL(`${env.SUPABASE_URL}/rest/v1/fleet_submissions`);
  u.searchParams.set("select", "*");
  u.searchParams.set("id", `eq.${id}`);
  u.searchParams.set("limit", "1");

  let resp;
  try {
    resp = await fetch(u.toString(), {
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
      }
    });
  } catch (err) {
    console.error("fleet admin detail fetch error:", err);
    return jsonError(500, "Submission fetch failed");
  }
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    console.error("fleet admin detail non-2xx:", resp.status, errText);
    return jsonError(500, `Submission fetch failed: ${resp.status}`);
  }
  const arr = (await resp.json().catch(() => [])) || [];
  if (!Array.isArray(arr) || arr.length === 0) {
    return jsonError(404, "submission not found");
  }
  return json({ row: arr[0] });
}

async function handleUpdateSubmission(request, env, id) {
  const gate = await authenticateAdmin(request, env);
  if (!gate.ok) return gate.response;

  // Brief 105 — gate session must have an email for the audit-column stamps
  // and webhook actor field. authenticate() resolves email from auth_unified,
  // so this is defense-in-depth; bail cleanly if it ever returns blank.
  const actorEmail =
    typeof gate.session?.email === "string" ? gate.session.email : "";
  if (!actorEmail) {
    return jsonError(401, "unauthorized (session has no email)");
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "Invalid JSON body");
  }
  if (body == null || typeof body !== "object") {
    return jsonError(400, "Invalid request body");
  }

  // Brief 105 — widen to accept either or both `splash_notes` and `status`.
  // Reject unknown body keys as defense-in-depth so a typo doesn't silently
  // skip an intended field.
  const unknownKeys = Object.keys(body).filter(
    (k) => k !== "splash_notes" && k !== "status"
  );
  if (unknownKeys.length > 0) {
    return jsonError(400, `Unknown body keys: ${unknownKeys.join(", ")}`);
  }

  const updates = {};
  const changedFields = [];
  const nowIso = new Date().toISOString();

  if (body.splash_notes !== undefined) {
    if (typeof body.splash_notes !== "string") {
      return jsonError(400, "splash_notes must be a string");
    }
    const trimmedNotes = body.splash_notes.trim();
    if (trimmedNotes.length > SPLASH_NOTES_MAX_LEN) {
      return jsonError(
        400,
        `splash_notes exceeds maximum length (${SPLASH_NOTES_MAX_LEN} chars)`
      );
    }
    updates.splash_notes = trimmedNotes;
    updates.splash_notes_updated_at = nowIso;
    updates.splash_notes_updated_by = actorEmail;
    changedFields.push("notes");
  }

  if (body.status !== undefined) {
    if (typeof body.status !== "string" || !ALLOWED_STATUSES.has(body.status)) {
      return jsonError(
        400,
        "status must be one of: new, reviewed, contacted, closed"
      );
    }
    updates.status = body.status;
    updates.status_updated_at = nowIso;
    updates.status_updated_by = actorEmail;
    changedFields.push("status");
  }

  if (changedFields.length === 0) {
    return jsonError(400, "Provide splash_notes and/or status");
  }

  const u = new URL(`${env.SUPABASE_URL}/rest/v1/fleet_submissions`);
  u.searchParams.set("id", `eq.${id}`);
  u.searchParams.set("select", "*");

  let resp;
  try {
    resp = await fetch(u.toString(), {
      method: "PATCH",
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=representation"
      },
      body: JSON.stringify(updates)
    });
  } catch (err) {
    console.error("fleet admin update fetch error:", err);
    return jsonError(500, "Submission update failed");
  }
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    console.error("fleet admin update non-2xx:", resp.status, errText);
    return jsonError(500, `Submission update failed: ${resp.status}`);
  }
  const arr = (await resp.json().catch(() => [])) || [];
  if (!Array.isArray(arr) || arr.length === 0) {
    return jsonError(404, "submission not found");
  }

  // Brief 105 — fire the per-edit webhook AFTER the PATCH commits so a
  // Supabase failure never triggers PA. Fail-soft: any throw / non-2xx is
  // swallowed inside the helper; the dashboard response is never gated on
  // it. Mirrors Brief 101's `notifyClaimUpdate` posture.
  const changeType =
    changedFields.length === 2
      ? "both"
      : changedFields[0] === "notes"
        ? "notes"
        : "status";
  await fireFleetSubmissionUpdateWebhook(env, {
    id,
    change_type: changeType,
    changed_fields: changedFields,
    actor: { email: actorEmail },
    row: arr[0]
  });

  return json({ ok: true, row: arr[0] });
}

/**
 * Brief 105 — fire-and-forget webhook to Power Automate so SharePoint can
 * mirror dashboard edits in near-realtime. The PA flow's HTTP-trigger URL
 * is bound as `FLEET_SUBMISSION_UPDATE_WEBHOOK_URL` (worker secret,
 * optional). Fail-soft when unbound or when PA is unreachable — the
 * dashboard PATCH succeeded already; SharePoint just lags until the next
 * successful fire (or until the operator runs a one-time backfill).
 *
 * 15s AbortSignal timeout matches the Brief 101 / Brief 102 / Brief 32
 * fail-soft webhook posture. No retry: PA flow runs are observable in PA
 * history; a deeper retry policy belongs there, not here.
 */
async function fireFleetSubmissionUpdateWebhook(env, payload) {
  if (!env.FLEET_SUBMISSION_UPDATE_WEBHOOK_URL) return;
  try {
    const res = await fetch(env.FLEET_SUBMISSION_UPDATE_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000)
    });
    if (!res.ok) {
      console.error(
        `[fleet-submission-update] POST failed for ${payload.id}: status ${res.status}`
      );
    }
  } catch (err) {
    console.error(
      `[fleet-submission-update] POST error for ${payload.id}:`,
      err
    );
  }
}

async function handleCsvExport(request, env) {
  const gate = await authenticateAdmin(request, env);
  if (!gate.ok) return gate.response;

  const url = new URL(request.url);
  const range = parseDateRange(url);
  if (!range.ok) return range.response;

  const u = new URL(`${env.SUPABASE_URL}/rest/v1/fleet_submissions`);
  u.searchParams.set("select", "*");
  u.searchParams.append("submitted_at", `gte.${range.fromIso}`);
  u.searchParams.append("submitted_at", `lte.${range.toIso}`);
  u.searchParams.set("order", "submitted_at.desc");
  // Request one row above the cap so we can detect overflow without fetching
  // the full count.
  u.searchParams.set("limit", String(CSV_SAFETY_CAP + 1));

  let resp;
  try {
    resp = await fetch(u.toString(), {
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
      }
    });
  } catch (err) {
    console.error("fleet admin csv fetch error:", err);
    return jsonError(500, "CSV fetch failed");
  }
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    console.error("fleet admin csv non-2xx:", resp.status, errText);
    return jsonError(500, `CSV fetch failed: ${resp.status}`);
  }
  const rows = (await resp.json().catch(() => [])) || [];
  if (!Array.isArray(rows)) {
    return jsonError(500, "CSV fetch returned non-array");
  }
  if (rows.length > CSV_SAFETY_CAP) {
    return jsonError(
      416,
      `Result exceeds safety cap of ${CSV_SAFETY_CAP} rows. Narrow the date range.`
    );
  }

  const csv = toCsv(rows, CSV_COLUMNS);
  const filename = `fleet-submissions-${range.fromYmd}-to-${range.toYmd}.csv`;
  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store"
    }
  });
}

/* ============================================================
 * CSV rendering
 * ============================================================ */

function toCsv(rows, columns) {
  const escape = (v) => {
    const s = v == null ? "" : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = columns.map((c) => escape(c.label)).join(",");
  const body = rows
    .map((r) =>
      columns
        .map((c) => escape(typeof c.get === "function" ? c.get(r) : r[c.key]))
        .join(",")
    )
    .join("\n");
  return header + "\n" + body + (rows.length > 0 ? "\n" : "");
}
