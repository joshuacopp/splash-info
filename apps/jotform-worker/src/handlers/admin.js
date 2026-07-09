// Admin-gated read endpoints (Brief 107 / Brief 110).
//
// Six routes under /admin/jotform/api/*:
//
//   GET  /admin/jotform/api/forms
//     Returns {forms: [{form_id, slug, display_name, enabled,
//     submission_count}], scope: "all" | "scoped"} for all enabled
//     forms. Any authenticated session passes (Brief 151 widened from
//     admin-tier). Per-form counts are scoped by
//     `accessibleSiteNumbersForSession` — admin-tier sees unscoped
//     totals, RM/RD/GM/location_admin see counts filtered to their
//     accessible site_number set.
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
const CSV_SAFETY_CAP = 10_000;
// Brief 115 — full-scope grouped rendering pulls every row in scope (no
// row-level pagination). Hard ceiling prevents pathological loads on
// admin-tier with wide date ranges; apps/web flags `cap_reached` and
// requires the operator to narrow.
const GROUPING_SAFETY_CAP = 2000;

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
 *
 * Any authenticated session (Brief 151). Counts scope to the caller's
 * `accessibleSiteNumbersForSession`:
 *   - super_admin / admin / dcRole admin/super_admin → "all" (unscoped)
 *   - RM / RD / GM / location_admin (anyone else)   → Set<site_number>
 *     filter; counts reflect only rows the caller can see at
 *     `/admin/jotform/{form_id}`.
 *   - Empty accessible set → every count short-circuits to 0; the
 *     form rows still render so apps/web can show a friendly empty
 *     state instead of an empty page or 403.
 *
 * Response carries `scope: "all" | "scoped"` so apps/web can render
 * the appropriate empty-state copy.
 * ============================================================ */

async function handleListForms(request, env) {
  const gate = await authenticateForAdminApi(request, env);
  if (!gate.ok) return gate.response;

  const scope = await accessibleSiteNumbersForSession(env, gate.session);
  const siteNumbersFilter = scope === "all" ? undefined : scope;
  const scopeKind = scope === "all" ? "all" : "scoped";

  const forms = await listForms(env);
  const enabled = forms.filter((f) => f.enabled !== false);
  const out = [];
  for (const form of enabled) {
    const count = await countSubmissionsForForm(
      env,
      form.form_id,
      siteNumbersFilter
    );
    out.push({
      form_id: form.form_id,
      slug: form.slug,
      display_name: form.display_name,
      enabled: form.enabled !== false,
      submission_count: count
    });
  }
  return jsonOk({ forms: out, scope: scopeKind });
}

/* ============================================================
 * GET /admin/jotform/api/asset?url=<encoded JotForm URL>
 * ============================================================ */

// Brief 115 — allow-list of JotForm asset hosts. The Enterprise instance
// host (from JOTFORM_BASE_URL) is the primary; `www.jotform.com` is the
// fallback because JotForm Enterprise occasionally stores signature /
// widget asset URLs against the public jotform.com host even on
// Enterprise accounts (per operator screenshots). Anything outside this
// set is rejected.
function buildAssetHostAllowList(env) {
  const set = new Set();
  try {
    set.add(new URL(env.JOTFORM_BASE_URL).host);
  } catch {
    /* JOTFORM_BASE_URL malformed — caller handles 503 elsewhere. */
  }
  set.add("www.jotform.com");
  return set;
}

// Brief 115 — allow-list of asset path prefixes. Brief 113 only allowed
// `/uploads/`; Enterprise signature widget URLs also land under
// `/widget-uploads/`, and server-rendered submission images use
// `/server.php`. Extending the allow-list closes the bug where some
// signatures 400'd at the path check before ever reaching JotForm.
const ASSET_PATH_PREFIXES = ["/uploads/", "/widget-uploads/", "/server.php"];

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

  const allowedHosts = buildAssetHostAllowList(env);
  if (allowedHosts.size === 0) {
    return jsonError(503, "JOTFORM_BASE_URL malformed");
  }
  if (!allowedHosts.has(targetUrl.host)) {
    return jsonError(400, "url host not allowed");
  }
  if (!ASSET_PATH_PREFIXES.some((p) => targetUrl.pathname.startsWith(p))) {
    return jsonError(400, "asset path not allowed");
  }

  // Brief 115 — augment (not replace) existing query params on the asset
  // URL and attach the worker's API key as BOTH a header and a query
  // param. JotForm Enterprise's `/uploads/` direct file server has been
  // observed rejecting `?apikey=`-only requests; the `APIKEY` HTTP header
  // is the documented JotForm asset auth posture. Belt + suspenders here
  // because the same proxy must also handle `/server.php` and
  // `/widget-uploads/` paths whose auth posture isn't symmetric.
  targetUrl.searchParams.set("apikey", env.JOTFORM_API_KEY);

  const fetchedUrl = await fetchJotformAssetFollowingRedirects(
    targetUrl,
    env.JOTFORM_API_KEY,
    allowedHosts
  );
  if (!fetchedUrl.ok) {
    return fetchedUrl.response;
  }
  const resp = fetchedUrl.response;

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

// Manually follow up to 3 redirects, validating each redirect target stays
// on the JotForm host allow-list. JotForm Enterprise has been observed
// 302-redirecting from `/uploads/...` to a CDN URL on the same host or to
// `www.jotform.com`; the Brief 113 `redirect: "manual"` + reject-3xx posture
// dropped those responses on the floor and surfaced as broken-img icons.
async function fetchJotformAssetFollowingRedirects(initialUrl, apiKey, allowedHosts) {
  let current = initialUrl;
  for (let hop = 0; hop < 4; hop++) {
    let resp;
    try {
      resp = await fetch(current.toString(), {
        method: "GET",
        redirect: "manual",
        headers: { APIKEY: apiKey },
        signal: AbortSignal.timeout(10_000)
      });
    } catch (err) {
      console.error("[jotform.asset-proxy] upstream fetch failed:", err);
      return { ok: false, response: jsonError(502, "upstream fetch failed") };
    }
    if (resp.status < 300 || resp.status >= 400) {
      return { ok: true, response: resp };
    }
    const location = resp.headers.get("Location");
    if (!location) {
      console.warn("[jotform.asset-proxy] redirect missing Location header:", resp.status);
      return { ok: false, response: jsonError(502, "upstream redirect malformed") };
    }
    let nextUrl;
    try {
      nextUrl = new URL(location, current);
    } catch {
      console.warn("[jotform.asset-proxy] redirect Location unparseable:", location);
      return { ok: false, response: jsonError(502, "upstream redirect malformed") };
    }
    if (!allowedHosts.has(nextUrl.host)) {
      console.warn(
        "[jotform.asset-proxy] redirect to disallowed host refused:",
        nextUrl.host
      );
      return { ok: false, response: jsonError(502, "upstream redirect off-host") };
    }
    // Carry the apikey query param forward on each hop too.
    nextUrl.searchParams.set("apikey", apiKey);
    current = nextUrl;
  }
  console.warn("[jotform.asset-proxy] redirect limit exceeded");
  return { ok: false, response: jsonError(502, "upstream redirect loop") };
}

/* ============================================================
 * GET /admin/jotform/api/{form_id}/submissions
 *
 * Three response shapes selected via query params (Brief 115):
 *
 *   ?count_only=1          → { total_rows, from, to, scope }
 *                            COUNT(*) only. Used by apps/web for the
 *                            role-aware count-only summary when an
 *                            admin-tier caller has no filter, or
 *                            any caller has a date range beyond
 *                            today without a filter.
 *
 *   ?group=location        → { groups: [{site, site_number, rm_email,
 *                              rm_name, count, rows}], total_rows,
 *                              cap_reached, from, to, scope }
 *                            Pulls every row in scope (up to
 *                            GROUPING_SAFETY_CAP), groups
 *                            alphabetically by site, no row pagination.
 *                            Default shape from apps/web for the
 *                            full grouped view.
 *
 *   (default — back-compat) { rows, count, total, total_estimate,
 *                             limit, offset, from, to, scope }
 *                            Legacy paginated shape. Kept for any
 *                            future caller that needs offset paging;
 *                            apps/web no longer uses it.
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
  const siteNumber = sanitizeSiteNumber(url.searchParams.get("site_number"));
  const countOnly = url.searchParams.get("count_only") === "1";
  const grouped = url.searchParams.get("group") === "location";

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
      if (countOnly) {
        return jsonOk({
          total_rows: 0,
          from: range.fromIso,
          to: range.toIso,
          scope: "scoped"
        });
      }
      if (grouped) {
        return jsonOk({
          groups: [],
          total_rows: 0,
          cap_reached: false,
          from: range.fromIso,
          to: range.toIso,
          scope: "scoped"
        });
      }
      return jsonOk({
        rows: [],
        count: 0,
        total: 0,
        total_estimate: 0,
        limit: DEFAULT_LIST_LIMIT,
        offset: 0,
        from: range.fromIso,
        to: range.toIso,
        scope: "scoped"
      });
    }
  }

  if (countOnly) {
    const result = await listSubmissions(env, {
      formId,
      fromIso: range.fromIso,
      toIso: range.toIso,
      siteNumbers: siteNumbersFilter,
      siteNumber: siteNumber ?? undefined,
      limit: 1,
      offset: 0,
      exactCount: true
    });
    return jsonOk({
      total_rows: result.total,
      from: range.fromIso,
      to: range.toIso,
      scope: scopeKind
    });
  }

  if (grouped) {
    // Pull up to GROUPING_SAFETY_CAP+1 rows to detect overflow.
    const result = await listSubmissions(env, {
      formId,
      fromIso: range.fromIso,
      toIso: range.toIso,
      siteNumbers: siteNumbersFilter,
      siteNumber: siteNumber ?? undefined,
      limit: GROUPING_SAFETY_CAP + 1,
      offset: 0,
      exactCount: true
    });
    const capReached = result.rows.length > GROUPING_SAFETY_CAP;
    const renderedRows = capReached
      ? result.rows.slice(0, GROUPING_SAFETY_CAP)
      : result.rows;
    const totalRows = capReached
      ? Math.max(result.total, result.rows.length)
      : result.total;
    const rmRoster = await fetchRmRosterMap(env);
    const groups = groupRowsBySite(renderedRows, rmRoster);
    return jsonOk({
      groups,
      total_rows: totalRows,
      cap_reached: capReached,
      from: range.fromIso,
      to: range.toIso,
      scope: scopeKind
    });
  }

  // Legacy paginated mode (back-compat — apps/web no longer uses).
  const limit = parseLimit(url, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  if (typeof limit === "object" && limit.error) return limit.error;
  const offset = parseOffset(url);
  if (typeof offset === "object" && offset.error) return offset.error;
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

/**
 * Group rows by `site` (case-insensitive) for the `?group=location`
 * response shape. Brief 115 — alphabetical by site, RM name resolved from
 * the locations roster cache via site_number → rm_email → display name.
 */
function groupRowsBySite(rows, rmRoster) {
  const buckets = new Map();
  for (const row of rows) {
    const siteRaw =
      typeof row.site === "string" && row.site.trim()
        ? row.site.trim()
        : typeof row.site_number === "string" && row.site_number.trim()
          ? row.site_number.trim()
          : "Unknown";
    const key = siteRaw.toLowerCase();
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        site: siteRaw,
        site_number:
          typeof row.site_number === "string" ? row.site_number.trim() : "",
        rm_email: null,
        rm_name: null,
        rows: []
      };
      buckets.set(key, bucket);
    }
    bucket.rows.push(row);
  }
  // Resolve RM info on each bucket from the roster map (site_number key).
  for (const bucket of buckets.values()) {
    const sn = bucket.site_number;
    if (!sn) continue;
    const meta =
      rmRoster.get(sn) || (sn.length < 3 ? rmRoster.get(sn.padStart(3, "0")) : undefined);
    if (meta) {
      bucket.rm_email = meta.rm_email || null;
      bucket.rm_name = meta.rm_name || null;
    }
  }
  const out = [...buckets.values()];
  out.sort((a, b) => a.site.toLowerCase().localeCompare(b.site.toLowerCase()));
  for (const g of out) {
    g.rows.sort((a, b) => {
      const ai = a.jotform_created_at ?? "";
      const bi = b.jotform_created_at ?? "";
      return bi.localeCompare(ai);
    });
    g.count = g.rows.length;
  }
  return out;
}

/**
 * Fetch `locations` (rm_email, regional_manager) keyed by site_number
 * string. Used by the grouped response to render RM display names in
 * group headers. Fail-soft: empty map on any error.
 */
async function fetchRmRosterMap(env) {
  const out = new Map();
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) return out;
  const u = new URL("/rest/v1/locations", env.SUPABASE_URL);
  u.searchParams.set("select", "site_number,rm_email,regional_manager");
  u.searchParams.set("limit", "1000");
  let resp;
  try {
    resp = await fetch(u.toString(), {
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
      }
    });
  } catch (err) {
    console.error("[jotform.list] fetchRmRosterMap fetch threw:", err);
    return out;
  }
  if (!resp.ok) {
    console.error("[jotform.list] fetchRmRosterMap non-2xx:", resp.status);
    return out;
  }
  const rows = (await resp.json().catch(() => [])) || [];
  for (const r of rows) {
    if (typeof r.site_number !== "number" || !Number.isFinite(r.site_number)) continue;
    const sn = String(r.site_number);
    const meta = {
      rm_email: typeof r.rm_email === "string" ? r.rm_email.trim() : "",
      rm_name: typeof r.regional_manager === "string" ? r.regional_manager.trim() : ""
    };
    out.set(sn, meta);
    const padded = sn.padStart(3, "0");
    if (padded !== sn) out.set(padded, meta);
  }
  return out;
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

// Brief 115 — defaults flip from "last 30 days UTC" to "today EST". The
// viewer's day-to-day operator scan is "what came in today"; pulling
// 30 days at first load was both wrong-by-default and the cause of the
// per-page grouping incoherence Brief 110 surfaced.
function parseDateRange(url) {
  const fromRaw = url.searchParams.get("from");
  const toRaw = url.searchParams.get("to");
  const today = todayInEastern();

  let fromDate;
  let fromYmd;
  if (fromRaw == null || fromRaw === "") {
    fromDate = new Date(easternWallClockToUtcMs(today.y, today.mo, today.d, 0, 0, 0));
    fromYmd = `${today.y}-${pad2(today.mo)}-${pad2(today.d)}`;
  } else {
    if (!DATE_RE.test(fromRaw)) {
      return { ok: false, response: jsonError(400, "Invalid 'from' (expected YYYY-MM-DD)") };
    }
    const [yy, mm, dd] = fromRaw.split("-").map((s) => Number.parseInt(s, 10));
    const ms = easternWallClockToUtcMs(yy, mm, dd, 0, 0, 0);
    fromDate = new Date(ms);
    if (Number.isNaN(fromDate.getTime())) {
      return { ok: false, response: jsonError(400, "Invalid 'from' date") };
    }
    fromYmd = fromRaw;
  }

  let toDate;
  let toYmd;
  if (toRaw == null || toRaw === "") {
    toDate = new Date(easternWallClockToUtcMs(today.y, today.mo, today.d, 23, 59, 59) + 999);
    toYmd = `${today.y}-${pad2(today.mo)}-${pad2(today.d)}`;
  } else {
    if (!DATE_RE.test(toRaw)) {
      return { ok: false, response: jsonError(400, "Invalid 'to' (expected YYYY-MM-DD)") };
    }
    const [yy, mm, dd] = toRaw.split("-").map((s) => Number.parseInt(s, 10));
    const ms = easternWallClockToUtcMs(yy, mm, dd, 23, 59, 59) + 999;
    toDate = new Date(ms);
    if (Number.isNaN(toDate.getTime())) {
      return { ok: false, response: jsonError(400, "Invalid 'to' date") };
    }
    toYmd = toRaw;
  }

  if (fromDate.getTime() > toDate.getTime()) {
    return { ok: false, response: jsonError(400, "'from' must be on or before 'to'") };
  }

  return {
    ok: true,
    fromIso: fromDate.toISOString(),
    toIso: toDate.toISOString(),
    fromYmd,
    toYmd
  };
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

/**
 * Return today's date in America/New_York wall-clock as {y, mo, d}.
 * DST-aware via Intl.DateTimeFormat. The Brief 114 helper pattern.
 */
function todayInEastern() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return {
    y: Number.parseInt(map.year, 10),
    mo: Number.parseInt(map.month, 10),
    d: Number.parseInt(map.day, 10)
  };
}

/**
 * Convert an America/New_York wall-clock moment (y, mo, d, h, mi, s) to
 * UTC epoch ms. DST-aware: probes Intl for the zone offset at that
 * wall-clock and subtracts. Mirrors `parseJotformDate` in normalize.js
 * (the Brief 114 helper pattern).
 */
function easternWallClockToUtcMs(y, mo, d, h, mi, s) {
  const probe = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    timeZoneName: "shortOffset"
  });
  const parts = formatter.formatToParts(probe);
  const tz = parts.find((p) => p.type === "timeZoneName")?.value;
  let offsetMinutes = -300; // default EST
  if (tz) {
    const m = tz.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
    if (m) {
      const sign = m[1] === "+" ? 1 : -1;
      const hours = Number.parseInt(m[2], 10);
      const mins = m[3] ? Number.parseInt(m[3], 10) : 0;
      offsetMinutes = sign * (hours * 60 + mins);
    }
  }
  const wallAsIfUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  return wallAsIfUtc - offsetMinutes * 60_000;
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
  // Group by site: sort rows so same-site submissions are contiguous. Blank
  // site sinks to the bottom; jotform_created_at is a stable secondary key.
  // Copy first — never mutate the caller's array.
  const sorted = [...rows].sort((a, b) => {
    const sa = (a?.site ?? "").toString();
    const sb = (b?.site ?? "").toString();
    if (sa === "" && sb !== "") return 1;
    if (sb === "" && sa !== "") return -1;
    const c = sa.localeCompare(sb, undefined, { sensitivity: "base" });
    if (c !== 0) return c;
    return (a?.jotform_created_at ?? "")
      .toString()
      .localeCompare((b?.jotform_created_at ?? "").toString());
  });

  // `site` pulled to the front so the grouping reads as contiguous blocks
  // while the sheet stays a single clean table (Excel filter/pivot-friendly).
  const headerBase = [
    "site",
    "id",
    "jotform_created_at",
    "jotform_updated_at",
    "site_number",
    "site_email",
    "jotform_status"
  ];

  // Union of every answer key present in any row (schema-union, the Brief 96
  // pattern). For each key, resolve a human column header from the JotForm
  // entry's `text` (the question label authored in the builder), falling back
  // to the field `name`, then the raw key. Empty answers payloads contribute
  // zero keys.
  const keyLabel = new Map();
  for (const r of sorted) {
    const a = r && r.answers && typeof r.answers === "object" ? r.answers : null;
    if (!a) continue;
    for (const k of Object.keys(a)) {
      if (keyLabel.get(k)) continue; // already resolved a non-empty label
      const entry = a[k];
      let label = "";
      if (entry && typeof entry === "object") {
        if (typeof entry.text === "string" && entry.text.trim()) {
          label = entry.text.trim();
        } else if (typeof entry.name === "string" && entry.name.trim()) {
          label = entry.name.trim();
        }
      }
      keyLabel.set(k, label);
    }
  }
  const sortedKeys = [...keyLabel.keys()].sort();

  // Disambiguate duplicate labels by appending the key, so two questions that
  // happen to share wording stay distinct columns.
  const labelCounts = new Map();
  for (const k of sortedKeys) {
    const label = keyLabel.get(k) || k;
    labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
  }
  const headerFor = (k) => {
    const label = keyLabel.get(k) || k;
    return (labelCounts.get(label) ?? 0) > 1 ? `${label} (${k})` : label;
  };

  const header = [...headerBase, ...sortedKeys.map(headerFor)];

  const lines = [header.map(csvEscape).join(",")];
  for (const r of sorted) {
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

  const csv = lines.join("\n") + (sorted.length > 0 ? "\n" : "");
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
