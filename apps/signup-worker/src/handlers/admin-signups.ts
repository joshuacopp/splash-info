// Admin signups JSON API (Brief 56).
//
// Per-location read-only view of recent customer submissions in
// `maxpass_signups`. Powers /admin/signups/{location} on apps/web.
//
// =============================================================================
// ROUTE
// =============================================================================
//
//   GET /admin/api/locations/{loc}/signups?days=N
//
//   Auth: identical to /admin/api/locations/{loc} (admin-pricing.ts adminGate
//         + per-location scope check). super_admin sees any location;
//         location_admin must have the location in session.locations AND
//         the "pricing" tool grant. The brief explicitly requires the
//         same gate verbatim — DO NOT loosen.
//
//   `days` query param: integer in {1, 7, 30}. Default 7 when missing.
//                       Any other value returns 400 (no silent coercion —
//                       protects against unbounded queries).
//
// =============================================================================
// RESPONSE
// =============================================================================
//
//   200 {
//     rows: [{
//       submitted_at, phone_formatted, email, package_pretty,
//       today_price, city, region
//     }, ...],
//     count: number,         // rows.length
//     since: string,          // ISO timestamp lower bound
//     days: 1 | 7 | 30,
//     limit_hit: boolean      // true when rows.length === 200; UI footer hint
//   }
//
// `phone` (raw 10-digit) is intentionally NOT in the select — the UI
// displays `phone_formatted`. Fraud-detection columns and `terms_text`
// are also excluded (operationally noisy).

import { json, jsonError } from "@splash/http";
import type { Env } from "../env.js";
import { adminGate, userCanAccessLocation } from "./admin-pricing.js";

/** Allow-list for the `days` query param. */
const ALLOWED_DAYS: ReadonlySet<number> = new Set([1, 7, 30]);
const DEFAULT_DAYS = 7;
const ROW_LIMIT = 200;

/** Shape of the row each select column returns from PostgREST. */
interface SignupRow {
  submitted_at: string;
  phone_formatted: string;
  email: string | null;
  package_pretty: string;
  today_price: number;
  city: string | null;
  region: string | null;
}

/**
 * GET /admin/api/locations/{loc}/signups?days=N
 *
 *   200 SignupsResponse
 *   400 if `days` present but not in {1, 7, 30}
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

  // Parse `days`. Missing → DEFAULT_DAYS. Present-but-invalid → 400.
  const url = new URL(request.url);
  const daysRaw = url.searchParams.get("days");
  let days: number;
  if (daysRaw === null || daysRaw === "") {
    days = DEFAULT_DAYS;
  } else {
    const parsed = Number.parseInt(daysRaw, 10);
    if (!Number.isInteger(parsed) || !ALLOWED_DAYS.has(parsed)) {
      return jsonError(400, "Invalid days; must be 1, 7, or 30");
    }
    days = parsed;
  }

  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const loc = locationCode.toLowerCase();

  // Direct PostgREST GET — same headers pattern as the other Supabase REST
  // calls in this monorepo (sysadmin-worker/src/index.ts). The
  // `select` list omits `phone` (raw 10-digit), terms_text, and the
  // fraud-detection columns intentionally.
  const restUrl =
    `${env.SUPABASE_URL}/rest/v1/maxpass_signups` +
    `?location_code=eq.${encodeURIComponent(loc)}` +
    `&submitted_at=gte.${encodeURIComponent(since)}` +
    `&select=submitted_at,phone_formatted,email,package_pretty,today_price,city,region` +
    `&order=submitted_at.desc` +
    `&limit=${ROW_LIMIT}`;

  const resp = await fetch(restUrl, {
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
    }
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    return jsonError(500, `Signups fetch failed: ${resp.status} ${errText}`);
  }

  const raw = (await resp.json().catch(() => [])) as unknown;
  const rows: SignupRow[] = Array.isArray(raw) ? (raw as SignupRow[]) : [];

  return json({
    rows,
    count: rows.length,
    since,
    days,
    limit_hit: rows.length === ROW_LIMIT
  });
}
