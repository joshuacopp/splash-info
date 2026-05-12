// Admin-gated read endpoints (Brief 107 / Brief 110).
//
// Six routes under /admin/jotform/api/*:
//
//   GET  /admin/jotform/api/forms
//     Returns [{form_id, slug, display_name, enabled, submission_count}]
//     for all enabled forms. Admin-or-higher only (super_admin OR dcRole
//     admin/super_admin); RM/RD/GM see no value here since they jump
//     straight to per-form views.
//
//   GET  /admin/jotform/api/{form_id}/submissions
//     Paginated list with date range + optional site_number filter.
//     Any authenticated session passes; permission scope is applied
//     downstream via accessibleSiteNumbersForSession.
//
//   GET  /admin/jotform/api/{form_id}/submissions/{id}
//     Single-row detail. Anti-leak: if the row's site_number isn't in
//     the caller's accessible set, returns 404 (not 403) so callers
//     can't probe for existence.
//
//   GET  /admin/jotform/api/{form_id}/submissions.csv
//     CSV export with schema-union of every answers key across the date
//     range. Mirrors Brief 96's forms-worker CSV pattern. 10000-row
//     safety ceiling; 416 on overflow.
//
//   POST /admin/jotform/api/{form_id}/backfill?after_id=...
//     Super_admin only. Paginates JotForm API ?after_id for one page of
//     up to 1000, normalizes + upserts, returns `{ ok, inserted, last_id,
//     has_more }`. Operator drives the loop externally.
//
//   GET  /admin/jotform/api/roster
//     Any authenticated session. Returns regional_directors /
//     regional_managers / locations arrays scoped to the caller's
//     accessibleSiteNumbersForSession. Backs apps/web's RD/RM/Location
//     filter dropdowns in one round-trip. (Brief 110)
//
//   GET  /admin/jotform/api/asset?url=<encoded JotForm URL>
//     Any authenticated session. Streams a JotForm-hosted asset
//     (signature or fileupload) back to the caller after attaching the
//     worker's JOTFORM_API_KEY. JotForm's CDN requires the API key for
//     hot-links — same-origin proxy lets apps/web's <img> tags load
//     cleanly via the apps/web session cookie. Host + /uploads/ path
//     prefix allow-list rejects anything that isn't a JotForm asset.
//     (Brief 113)

import { isOriginAllowed, jsonError } from "@splash/http";
import {
  authenticateAdminOrHigher,
  authenticateForAdminApi,
  authenticateSuperAdmin,
  accessibleSiteNumbersForSession
} from "../auth-gate.js";
import {
  loadFormById,
  listForms,
  countSubmissionsForForm,
  listSubmissions,
  listSubmissionsForCsv,
  loadSubmissionById,
  upsertSubmissions
} from "../db.js";
import { fetchFormSubmissions, JOTFORM_BACKFILL_PAGE_SIZE } from "../jotform.js";
import { normalizeSubmission } from "../normalize.js";
import { resolveLocationFilters } from "../filters.js";
import { handleRoster } from "./roster.js";

const DEFAULT_LIST_LIMIT = 200;
const MAX_LIST_LIMIT = 500;
const DEFAULT_WINDOW_DAYS = 30;
const CSV_SAFETY_CAP = 10_000;

/**
 * Top-level dispatch for /admin/jotform/api/*. Returns null when the
 * path is not an admin path so the caller (index.js) can fall through
 * to the next router branch.
 */
export async function handleAdminApi(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (!path.startsWith("/admin/jotform/api/")) return null;

  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Cookie"
      }
    });
  }

  if (!isOriginAllowed(request)) {
    return jsonError(403, "bad origin");
  }

  if (path === "/admin/jotform/api/forms") {
    if (request.method !== "GET") return jsonError(405, "method not allowed");
    return handleListForms(request, env);
  }

  if (path === "/admin/jotform/api/roster") {
    if (request.method !== "GET") return jsonError(405, "method not allowed");
    return handleRoster(request, env);
  }

  if (path === "/admin/jotform/api/asset") {
    if (request.method !== "GET") return jsonError(405, "method not allowed");
    return handleAssetProxy(request, env);
  }

  const submissionsMatch = path.match(
    /^\/admin\/jotform\/api\/([A-Za-z0-9_-]+)\/submissions$/
  );
  if (submissionsMatch) {
    if (request.method !== "GET") return jsonError(405, "method not allowed");
    return handleListSubmissions(request, env, submissionsMatch[1]);
  }

  const csvMatch = path.match(
    /^\/admin\/jotform\/api\/([A-Za-z0-9_-]+)\/submissions\.csv$/
  );
  if (csvMatch) {
    if (request.method !== "GET") return jsonError(405, "method not allowed");
    return handleCsvExport(request, env, csvMatch[1]);
  }

  const detailMatch = path.match(
    /^\/admin\/jotform\/api\/([A-Za-z0-9_-]+)\/submissions\/([A-Za-z0-9_-]+)$/
  );
  if (detailMatch) {
    if (request.method !== "GET") return jsonError(405, "method not allowed");
    return handleDetail(request, env, detailMatch[1], detailMatch[2]);
  }

  const backfillMatch = path.match(
    /^\/admin\/jotform\/api\/([A-Za-z0-9_-]+)\/backfill$/
  );
  if (backfillMatch) {
    if (request.method !== "POST") return jsonError(405, "method not allowed");
    return handleBackfill(request, env, backfillMatch[1]);
  }

  return jsonError(404, "not found");
}

/* ============================================================
 * GET /admin/jotform/api/forms
 * ============================================================ */

async function handleListForms(request, env) {
  const gate = await authenticateAdminOrHigher(request, env);
  if (!gate.ok) return gate.response;

  const forms = await listForms(env);
  const enabled = forms.filter((f) => f.enabled !== false);
  const out = [];
  for (const form of enabled) {
    const count = await countSubmissionsForForm(env, form.form_id);
    out.push({
      form_id: form.form_id,
      slug: form.slug,
      display_name: form.display_name,
      enabled: form.enabled !== false,
      submission_count: count
    });
  }
  return jsonOk({ forms: out });
}

/* ============================================================
 * GET /admin/jotform/api/asset?url=<encoded JotForm URL>
 * ============================================================ */

async function handleAssetProxy(request, env) {
  const gate = await authenticateForAdminApi(request, env);
  if (!gate.ok) return gate.response;

  if (!env.JOTFORM_API_KEY) {
    return jsonError(503, "JOTFORM_API_KEY unbound");
  }
  if (!env.JOTFORM_BASE_URL) {
    return jsonError(503, "JOTFORM_BASE_URL unbound");
  }

  const url = new URL(request.url);
  const target = url.searchParams.get("url");
  if (!target) return jsonError(400, "url required");

  let targetUrl;
  try {
    targetUrl = new URL(target);
  } catch {
    return jsonError(400, "invalid url");
  }
  let expectedHost;
  try {
    expectedHost = new URL(env.JOTFORM_BASE_URL).host;
  } catch {
    return jsonError(503, "JOTFORM_BASE_URL malformed");
  }
  if (targetUrl.host !== expectedHost) {
    return jsonError(400, "url host not allowed");
  }
  if (!targetUrl.pathname.startsWith("/uploads/")) {
    return jsonError(400, "only /uploads/ paths allowed");
  }

  // Drop any pre-existing query params on the target and attach the
  // worker's API key. JotForm asset URLs authenticate via `apikey`
  // query param (same shape the rest of the worker uses for its API
  // reads — see jotform.js).
  targetUrl.search = "";
  targetUrl.searchParams.set("apikey", env.JOTFORM_API_KEY);

  let resp;
  try {
    resp = await fetch(targetUrl.toString(), {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(10_000)
    });
  } catch (err) {
    console.error("[jotform.asset-proxy] upstream fetch failed:", err);
    return jsonError(502, "upstream fetch failed");
  }

  if (resp.status >= 300 && resp.status < 400) {
    console.warn(
      "[jotform.asset-proxy] upstream redirect refused:",
      resp.status,
      resp.headers.get("Location")
    );
    return jsonError(502, "upstream redirect refused");
  }

  if (!resp.ok) {
    console.warn("[jotform.asset-proxy] upstream non-2xx:", resp.status);
    return jsonError(resp.status === 404 ? 404 : 502, "upstream error");
  }

  const ct = resp.headers.get("Content-Type") || "application/octet-stream";
  return new Response(resp.body, {
    status: 200,
    headers: {
      "Content-Type": ct,
      "Cache-Control": "private, max-age=300",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

/* ============================================================
 * GET /admin/jotform/api/{form_id}/submissions
 * ============================================================ */

async function handleListSubmissions(request, env, formId) {
  const gate = await authenticateForAdminApi(request, env);
  if (!gate.ok) return gate.response;

  const form = await loadFormById(env, formId);
  if (!form || form.enabled === false) {
    return jsonError(404, "form not found");
  }

  const url = new URL(request.url);
  const range = parseDateRange(url);
  if (!range.ok) return range.response;
  const limit = parseLimit(url, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  if (typeof limit === "object" && limit.error) return limit.error;
  const offset = parseOffset(url);
  if (typeof offset === "object" && offset.error) return offset.error;
  const siteNumber = sanitizeSiteNumber(url.searchParams.get("site_number"));

  const filters = await resolveLocationFilters(
    env,
    gate.session,
    url.searchParams
  );
  const scopeKind = filters.siteNumbers === "all" ? "all" : "scoped";
  const siteNumbersFilter =
    filters.siteNumbers === "all" ? undefined : filters.siteNumbers;

  // If the caller passed an explicit site_number, intersect with the
  // resolved (post-filter) accessible set so they can't probe outside.
  if (siteNumber && siteNumbersFilter instanceof Set) {
    if (!siteNumbersFilter.has(siteNumber)) {
      return jsonOk({
        rows: [],
        count: 0,
        total: 0,
        total_estimate: 0,
        limit,
        offset,
        from: range.fromIso,
        to: range.toIso,
        scope: "scoped"
      });
    }
  }

  const result = await listSubmissions(env, {
    formId,
    fromIso: range.fromIso,
    toIso: range.toIso,
    siteNumbers: siteNumbersFilter,
    siteNumber: siteNumber ?? undefined,
    limit,
    offset
  });
  return jsonOk({
    rows: result.rows,
    count: result.rows.length,
    total: result.total,
    total_estimate: result.total,
    limit,
    offset,
    from: range.fromIso,
    to: range.toIso,
    scope: scopeKind
  });
}

/* ============================================================
 * GET /admin/jotform/api/{form_id}/submissions/{id}
 * ============================================================ */

async function handleDetail(request, env, formId, id) {
  const gate = await authenticateForAdminApi(request, env);
  if (!gate.ok) return gate.response;

  const form = await loadFormById(env, formId);
  if (!form || form.enabled === false) {
    return jsonError(404, "form not found");
  }

  const row = await loadSubmissionById(env, formId, id);
  if (!row) return jsonError(404, "submission not found");

  const scope = await accessibleSiteNumbersForSession(env, gate.session);
  if (scope !== "all") {
    const siteNumber =
      typeof row.site_number === "string" ? row.site_number : "";
    if (!siteNumber || !scope.has(siteNumber)) {
      // Anti-leak: 404, not 403 — the caller can't distinguish
      // "doesn't exist" from "exists but not yours".
      return jsonError(404, "submission not found");
    }
  }
  return jsonOk({ row });
}

/* ============================================================
 * GET /admin/jotform/api/{form_id}/submissions.csv
 * ============================================================ */

async function handleCsvExport(request, env, formId) {
  const gate = await authenticateForAdminApi(request, env);
  if (!gate.ok) return gate.response;

  const form = await loadFormById(env, formId);
  if (!form || form.enabled === false) {
    return jsonError(404, "form not found");
  }

  const url = new URL(request.url);
  const range = parseDateRange(url);
  if (!range.ok) return range.response;
  const siteNumber = sanitizeSiteNumber(url.searchParams.get("site_number"));
  const filters = await resolveLocationFilters(
    env,
    gate.session,
    url.searchParams
  );
  const siteNumbersFilter =
    filters.siteNumbers === "all" ? undefined : filters.siteNumbers;
  if (siteNumber && siteNumbersFilter instanceof Set) {
    if (!siteNumbersFilter.has(siteNumber)) {
      // Return an empty CSV (just headers) so the operator's "Export"
      // click doesn't 404; matches the spirit of the empty-result UX.
      return renderCsv([], range, form.slug);
    }
  }

  const rows = await listSubmissionsForCsv(
    env,
    {
      formId,
      fromIso: range.fromIso,
      toIso: range.toIso,
      siteNumbers: siteNumbersFilter,
      siteNumber: siteNumber ?? undefined
    },
    CSV_SAFETY_CAP + 1
  );
  if (rows.length > CSV_SAFETY_CAP) {
    return jsonError(
      416,
      `Result exceeds safety cap of ${CSV_SAFETY_CAP} rows. Narrow the date range.`
    );
  }
  return renderCsv(rows, range, form.slug);
}

/* ============================================================
 * POST /admin/jotform/api/{form_id}/backfill?after_id=...
 * ============================================================ */

async function handleBackfill(request, env, formId) {
  const gate = await authenticateSuperAdmin(request, env);
  if (!gate.ok) return gate.response;

  if (!env.JOTFORM_API_KEY) {
    return jsonError(503, "JOTFORM_API_KEY unbound");
  }

  const form = await loadFormById(env, formId);
  if (!form) return jsonError(404, "form not found");
  if (form.enabled === false) {
    return jsonError(400, "form is disabled; re-enable in jotform_forms before backfill");
  }

  const url = new URL(request.url);
  const offsetRaw = url.searchParams.get("offset");
  const offset = offsetRaw && /^\d+$/.test(offsetRaw) ? Number.parseInt(offsetRaw, 10) : 0;

  let page;
  try {
    page = await fetchFormSubmissions(env, formId, { offset });
  } catch (err) {
    console.error("[jotform.backfill] fetchFormSubmissions failed:", err);
    return jsonError(502, "JotForm upstream fetch failed");
  }

  const normalized = [];
  for (const raw of page.rows) {
    try {
      normalized.push(normalizeSubmission(raw));
    } catch (err) {
      console.warn("[jotform.backfill] normalize failed for one row:", err);
    }
  }

  let inserted = 0;
  if (normalized.length > 0) {
    try {
      inserted = await upsertSubmissions(env, normalized);
    } catch (err) {
      console.error("[jotform.backfill] upsert failed:", err);
      return jsonError(500, "supabase upsert failed");
    }
  }

  return jsonOk({
    ok: true,
    inserted,
    offset,
    next_offset: page.nextOffset,
    last_id: page.lastId,
    has_more: page.hasMore,
    page_size: JOTFORM_BACKFILL_PAGE_SIZE
  });
}

/* ============================================================
 * Date / pagination / filter parsing
 * ============================================================ */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDateRange(url) {
  const fromRaw = url.searchParams.get("from");
  const toRaw = url.searchParams.get("to");
  const now = new Date();
  const todayUtc = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );

  let fromDate;
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

  let toDate;
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

function parseLimit(url, defaultVal, maxVal) {
  const raw = url.searchParams.get("limit");
  if (raw == null || raw === "") return defaultVal;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1) {
    return { error: jsonError(400, "Invalid 'limit'") };
  }
  return Math.min(n, maxVal);
}

function parseOffset(url) {
  const raw = url.searchParams.get("offset");
  if (raw == null || raw === "") return 0;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 0) {
    return { error: jsonError(400, "Invalid 'offset'") };
  }
  return n;
}

function sanitizeSiteNumber(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (!/^[0-9]{1,8}$/.test(s)) return null;
  return s;
}

/* ============================================================
 * CSV rendering (schema-union across the date range)
 * ============================================================ */

function renderCsv(rows, range, slug) {
  const headerBase = [
    "id",
    "jotform_created_at",
    "jotform_updated_at",
    "site_number",
    "site",
    "site_email",
    "jotform_status"
  ];

  // Union of every key present in any answers payload (schema-union, the
  // Brief 96 pattern). Empty answers payloads contribute zero keys.
  const answerKeys = new Set();
  for (const r of rows) {
    const a = r && r.answers && typeof r.answers === "object" ? r.answers : null;
    if (!a) continue;
    for (const k of Object.keys(a)) answerKeys.add(k);
  }
  const sortedKeys = [...answerKeys].sort();
  const header = [
    ...headerBase,
    ...sortedKeys.map((k) => `answers__${k}__answer`)
  ];

  const lines = [header.map(csvEscape).join(",")];
  for (const r of rows) {
    const base = headerBase.map((k) => csvEscape(stringifyForCsv(r?.[k])));
    const answerCells = sortedKeys.map((k) => {
      const entry = r?.answers?.[k];
      if (!entry || typeof entry !== "object") return "";
      const pretty = entry.prettyFormat;
      const answer = entry.answer;
      let cellValue;
      if (typeof pretty === "string" && pretty) {
        cellValue = pretty;
      } else if (typeof answer === "string" || typeof answer === "number") {
        cellValue = String(answer);
      } else if (answer != null) {
        try {
          cellValue = JSON.stringify(answer);
        } catch {
          cellValue = "";
        }
      } else {
        cellValue = "";
      }
      return csvEscape(cellValue);
    });
    lines.push([...base, ...answerCells].join(","));
  }

  const csv = lines.join("\n") + (rows.length > 0 ? "\n" : "");
  const filename = `${slug}-${range.fromYmd}-to-${range.toYmd}.csv`;
  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store"
    }
  });
}

function csvEscape(v) {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function stringifyForCsv(v) {
  if (v == null) return "";
  if (typeof v === "object") {
    try {
      return JSON.stringify(v);
    } catch {
      return "";
    }
  }
  return String(v);
}

/* ============================================================
 * JSON response helper
 * ============================================================ */

function jsonOk(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}
