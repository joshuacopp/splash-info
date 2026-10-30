// Admin signups JSON + CSV API (Brief 56 + Brief 84; on the report kit since
// Brief 179).
//
// Per-location read-only view of recent customer submissions in
// `maxpass_signups`. Powers /admin/signups/{location} on apps/web.
//
// =============================================================================
// ROUTES
// =============================================================================
//
//   GET /admin/api/locations/{loc}/signups?range=&from=&to=&days=&limit=
//   GET /admin/api/locations/{loc}/signups.csv?range=&from=&to=&days=
//
//   Auth: identical to /admin/api/locations/{loc} (admin-pricing.ts adminGate
//         + per-location scope check). super_admin sees any location;
//         location_admin must have the location in session.locations AND
//         the "pricing" tool grant (or CRD coverage of the site).
//
//   Dates come from the shared signups report definition
//   (@splash/report-kit/reports/signups) via the same parser apps/web uses:
//   `range=<preset>` beats `from`/`to` beats the legacy Brief 56 `days=1|7|30`
//   beats the default (last 30 Eastern days). Ranges are Eastern calendar
//   days. Malformed input falls back to the default instead of 400ing, so a
//   bad bookmark still opens.
//
//   `limit` query param: integer 1..200 for the JSON list; default 200.
//   The CSV endpoint ignores `limit` and uses the 10000-row safety cap.
//
// =============================================================================
// JSON RESPONSE
// =============================================================================
//
//   200 {
//     rows: [{ id, submitted_at, phone_formatted, email, package_pretty,
//              today_price, city, region }, ...],
//     count, since, from, to,   // since/from/to are UTC ISO bounds
//     from_ymd, to_ymd,          // the Eastern days those bounds cover
//     days,                      // echoed when the legacy `days=N` was used
//     limit, limit_hit
//   }
//
// `phone` (raw 10-digit) is intentionally NOT in the JSON select — the UI
// displays `phone_formatted`. The CSV export pulls every export column
// (including `phone`, `terms_text`, country/city/region, etc.) since the
// export use case is bulk extraction for follow-up campaigns.

import { isOriginAllowed, json, jsonError } from "@splash/http";
import {
  csvResponseHeaders,
  parseReportParams,
  toCsv
} from "@splash/report-kit";
import {
  SIGNUPS_EXPORT_SELECT,
  SIGNUPS_LIST_SELECT,
  signupsCsvFilename,
  signupsReport,
  type SignupsReportRow
} from "@splash/report-kit/reports/signups";
import type { Env } from "../env.js";
import { adminGate, userCanAccessLocation } from "./admin-pricing.js";

const ROW_LIMIT = 200;
const CSV_SAFETY_CAP = 10_000;

function parseLimit(url: URL): number | { error: Response } {
  const raw = url.searchParams.get("limit");
  if (raw == null || raw === "") return ROW_LIMIT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1) {
    return { error: jsonError(400, "Invalid 'limit'") };
  }
  return Math.min(n, ROW_LIMIT);
}

/** Echo `days` only when the legacy param is what actually chose the range. */
function legacyDaysUsed(url: URL): number | null {
  const sp = url.searchParams;
  if (sp.get("range") || sp.get("from") || sp.get("to")) return null;
  const n = Number(sp.get("days"));
  return signupsReport.legacyDays?.includes(n) ? n : null;
}

function signupsQuery(env: Env, loc: string, fromIso: string, toIso: string): URL {
  const u = new URL(`${env.SUPABASE_URL}/rest/v1/maxpass_signups`);
  u.searchParams.set("location_code", `eq.${loc}`);
  u.searchParams.append("submitted_at", `gte.${fromIso}`);
  u.searchParams.append("submitted_at", `lte.${toIso}`);
  u.searchParams.set("order", "submitted_at.desc");
  return u;
}

function supabaseHeaders(env: Env): HeadersInit {
  return {
    apikey: env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
  };
}

/* ============================================================
 * Handlers
 * ============================================================ */

/**
 * GET /admin/api/locations/{loc}/signups
 *
 *   200 SignupsResponse
 *   400 on a malformed `limit`
 *   401 / 403 from adminGate or per-location scope check
 *   500 on Supabase error
 */
export async function handleGetAdminLocationSignups(
  request: Request,
  env: Env,
  locationCode: string
): Promise<Response> {
  const gate = await adminGate(request, env);
  if (!gate.ok) return gate.response;
  if (!userCanAccessLocation(gate.session, locationCode)) {
    return jsonError(403, "forbidden");
  }

  const url = new URL(request.url);
  const { range } = parseReportParams(signupsReport, url.searchParams);

  const limit = parseLimit(url);
  if (typeof limit === "object") return limit.error;

  const loc = locationCode.toLowerCase();
  const u = signupsQuery(env, loc, range.fromIso, range.toIso);
  u.searchParams.set("select", SIGNUPS_LIST_SELECT);
  u.searchParams.set("limit", String(limit));

  const resp = await fetch(u.toString(), { headers: supabaseHeaders(env) });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    return jsonError(500, `Signups fetch failed: ${resp.status} ${errText}`);
  }

  const raw = (await resp.json().catch(() => [])) as unknown;
  const rows: SignupsReportRow[] = Array.isArray(raw) ? (raw as SignupsReportRow[]) : [];

  return json({
    rows,
    count: rows.length,
    // `since` is the Brief 56 field name; kept for back-compat.
    since: range.fromIso,
    from: range.fromIso,
    to: range.toIso,
    from_ymd: range.fromYmd,
    to_ymd: range.toYmd,
    days: legacyDaysUsed(url),
    limit,
    limit_hit: rows.length === limit
  });
}

/**
 * GET /admin/api/locations/{loc}/signups.csv
 *
 * CSV export of all matching rows up to the safety cap. Same auth gate as
 * the JSON endpoint.
 *
 *   200 text/csv on success
 *   401 / 403 from adminGate or per-location scope check
 *   416 if the result exceeds CSV_SAFETY_CAP
 *   500 on Supabase error
 */
export async function handleGetAdminLocationSignupsCsv(
  request: Request,
  env: Env,
  locationCode: string
): Promise<Response> {
  // CSRF: GET-only handler; isOriginAllowed is enforced as defense-in-depth
  // even though GETs aren't traditionally CSRFable. Service-binding callers
  // from apps/web set Origin to the worker's URL origin; same-origin browser
  // downloads pass too.
  if (!isOriginAllowed(request)) {
    return jsonError(403, "bad origin");
  }

  const gate = await adminGate(request, env);
  if (!gate.ok) return gate.response;
  if (!userCanAccessLocation(gate.session, locationCode)) {
    return jsonError(403, "forbidden");
  }

  const url = new URL(request.url);
  const { range } = parseReportParams(signupsReport, url.searchParams);

  const loc = locationCode.toLowerCase();
  const u = signupsQuery(env, loc, range.fromIso, range.toIso);
  u.searchParams.set("select", SIGNUPS_EXPORT_SELECT);
  // One row above the cap detects overflow without a separate count.
  u.searchParams.set("limit", String(CSV_SAFETY_CAP + 1));

  const resp = await fetch(u.toString(), { headers: supabaseHeaders(env) });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    return jsonError(500, `CSV fetch failed: ${resp.status} ${errText}`);
  }

  const raw = (await resp.json().catch(() => [])) as unknown;
  if (!Array.isArray(raw)) {
    return jsonError(500, "CSV fetch returned non-array");
  }
  if (raw.length > CSV_SAFETY_CAP) {
    return jsonError(
      416,
      `Result exceeds safety cap of ${CSV_SAFETY_CAP} rows. Narrow the date range.`
    );
  }

  const csv = toCsv(signupsReport, raw as SignupsReportRow[]);
  return new Response(csv, {
    status: 200,
    headers: csvResponseHeaders(signupsCsvFilename(loc, range.fromYmd, range.toYmd))
  });
}
