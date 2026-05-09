// Admin signups JSON + CSV API (Brief 56 + Brief 84).
//
// Per-location read-only view of recent customer submissions in
// `maxpass_signups`. Powers /admin/signups/{location} on apps/web.
//
// =============================================================================
// ROUTES
// =============================================================================
//
//   GET /admin/api/locations/{loc}/signups?days=N
//   GET /admin/api/locations/{loc}/signups?from=YYYY-MM-DD&to=YYYY-MM-DD&limit=N
//   GET /admin/api/locations/{loc}/signups.csv?from=YYYY-MM-DD&to=YYYY-MM-DD
//
//   Auth: identical to /admin/api/locations/{loc} (admin-pricing.ts adminGate
//         + per-location scope check). super_admin sees any location;
//         location_admin must have the location in session.locations AND
//         the "pricing" tool grant.
//
//   Param resolution (Brief 84):
//     1. If both `from` AND `to` present: use them (YYYY-MM-DD validated).
//     2. Else if `days` present: existing Brief 56 behavior — N ∈ {1, 7, 30},
//        from = today - N, to = today (back-compat for old bookmarked URLs).
//     3. Else: default from = today - 30 days, to = today.
//
//   `limit` query param: integer 1..200 for the JSON list; default 200.
//   The CSV endpoint ignores `limit` and uses the 10000-row safety cap.
//
// =============================================================================
// JSON RESPONSE
// =============================================================================
//
//   200 {
//     rows: [{
//       submitted_at, phone_formatted, email, package_pretty,
//       today_price, city, region
//     }, ...],
//     count: number,         // rows.length
//     since: string,          // ISO timestamp lower bound (back-compat field)
//     from: string,           // ISO timestamp lower bound (Brief 84)
//     to: string,             // ISO timestamp upper bound (Brief 84)
//     days: number | null,    // present when caller used `days=N`; null otherwise
//     limit: number,
//     limit_hit: boolean
//   }
//
// `phone` (raw 10-digit) is intentionally NOT in the JSON select — the UI
// displays `phone_formatted`. The CSV export pulls every user-facing column
// (including `phone`, `terms_text`, country/city/region, etc.) since the
// export use case is bulk extraction for follow-up campaigns.

import { isOriginAllowed, json, jsonError } from "@splash/http";
import type { Env } from "../env.js";
import { adminGate, userCanAccessLocation } from "./admin-pricing.js";

/** Allow-list for the legacy `days` query param (back-compat for Brief 56). */
const ALLOWED_DAYS: ReadonlySet<number> = new Set([1, 7, 30]);
const ROW_LIMIT = 200;
const DEFAULT_WINDOW_DAYS = 30;
const CSV_SAFETY_CAP = 10_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Shape of each row returned from PostgREST for the JSON list endpoint. */
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
 * CSV column inventory. `key` reads the column directly from the row;
 * the columns mirror the user-facing fields stored on `maxpass_signups`
 * plus the implicit `id` (UUID) and `confirmation_token` (used as a
 * support-lookup handle). `terms_text` is included so the export
 * captures the exact string each customer signed.
 */
interface CsvColumn {
  key: string;
  label: string;
}

const CSV_COLUMNS: ReadonlyArray<CsvColumn> = [
  { key: "id", label: "id" },
  { key: "submitted_at", label: "submitted_at" },
  { key: "name", label: "name" },
  { key: "email", label: "email" },
  { key: "phone", label: "phone" },
  { key: "phone_formatted", label: "phone_formatted" },
  { key: "location_code", label: "location_code" },
  { key: "location_pretty", label: "location_pretty" },
  { key: "package", label: "package" },
  { key: "package_pretty", label: "package_pretty" },
  { key: "today_price", label: "today_price" },
  { key: "monthly_price", label: "monthly_price" },
  { key: "terms_text", label: "terms_text" },
  { key: "country", label: "country" },
  { key: "city", label: "city" },
  { key: "region", label: "region" },
  { key: "user_agent", label: "user_agent" },
  { key: "confirmation_token", label: "confirmation_token" }
];

/* ============================================================
 * Date-range parsing
 * ============================================================ */

interface DateRangeOk {
  ok: true;
  fromIso: string;
  toIso: string;
  fromYmd: string;
  toYmd: string;
  days: number | null;
}
interface DateRangeErr {
  ok: false;
  response: Response;
}

/**
 * Parse `from` / `to` / `days` from the URL. Returns ISO timestamps that
 * bracket the inclusive day range (UTC).
 *
 *   1. Both `from` AND `to` present → use them.
 *   2. `days` present → days ∈ {1, 7, 30}; from = today - days, to = today.
 *   3. Neither → default last-30-days.
 *
 * `days` returned in the result is non-null only when path (2) was taken,
 * so the response can echo it back for back-compat callers.
 */
function parseDateRange(url: URL): DateRangeOk | DateRangeErr {
  const fromRaw = url.searchParams.get("from");
  const toRaw = url.searchParams.get("to");
  const daysRaw = url.searchParams.get("days");

  const now = new Date();
  const todayUtc = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
  const endOfToday = new Date(todayUtc.getTime() + 86_400_000 - 1);

  // Path 1: explicit from/to.
  if (fromRaw != null && fromRaw !== "" && toRaw != null && toRaw !== "") {
    if (!DATE_RE.test(fromRaw)) {
      return {
        ok: false,
        response: jsonError(400, "Invalid 'from' (expected YYYY-MM-DD)")
      };
    }
    if (!DATE_RE.test(toRaw)) {
      return {
        ok: false,
        response: jsonError(400, "Invalid 'to' (expected YYYY-MM-DD)")
      };
    }
    const fromDate = new Date(`${fromRaw}T00:00:00.000Z`);
    if (Number.isNaN(fromDate.getTime())) {
      return { ok: false, response: jsonError(400, "Invalid 'from' date") };
    }
    const toMidnight = new Date(`${toRaw}T00:00:00.000Z`);
    if (Number.isNaN(toMidnight.getTime())) {
      return { ok: false, response: jsonError(400, "Invalid 'to' date") };
    }
    const toDate = new Date(toMidnight.getTime() + 86_400_000 - 1);
    if (fromDate.getTime() > toDate.getTime()) {
      return {
        ok: false,
        response: jsonError(400, "'from' must be on or before 'to'")
      };
    }
    return {
      ok: true,
      fromIso: fromDate.toISOString(),
      toIso: toDate.toISOString(),
      fromYmd: fromDate.toISOString().slice(0, 10),
      toYmd: toDate.toISOString().slice(0, 10),
      days: null
    };
  }

  // One of from/to alone is ambiguous — reject so callers don't accidentally
  // depend on the implicit half-default.
  if ((fromRaw != null && fromRaw !== "") || (toRaw != null && toRaw !== "")) {
    return {
      ok: false,
      response: jsonError(400, "'from' and 'to' must both be provided together")
    };
  }

  // Path 2: legacy `days=N` (Brief 56 back-compat).
  if (daysRaw != null && daysRaw !== "") {
    const parsed = Number.parseInt(daysRaw, 10);
    if (!Number.isInteger(parsed) || !ALLOWED_DAYS.has(parsed)) {
      return {
        ok: false,
        response: jsonError(400, "Invalid days; must be 1, 7, or 30")
      };
    }
    const fromDate = new Date(todayUtc.getTime() - parsed * 86_400_000);
    return {
      ok: true,
      fromIso: fromDate.toISOString(),
      toIso: endOfToday.toISOString(),
      fromYmd: fromDate.toISOString().slice(0, 10),
      toYmd: endOfToday.toISOString().slice(0, 10),
      days: parsed
    };
  }

  // Path 3: default last-30-days.
  const fromDate = new Date(todayUtc.getTime() - DEFAULT_WINDOW_DAYS * 86_400_000);
  return {
    ok: true,
    fromIso: fromDate.toISOString(),
    toIso: endOfToday.toISOString(),
    fromYmd: fromDate.toISOString().slice(0, 10),
    toYmd: endOfToday.toISOString().slice(0, 10),
    days: null
  };
}

function parseLimit(url: URL): number | { error: Response } {
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

/**
 * GET /admin/api/locations/{loc}/signups?from=&to=&limit=
 * GET /admin/api/locations/{loc}/signups?days=N            (Brief 56 back-compat)
 *
 *   200 SignupsResponse
 *   400 on malformed params
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
  const range = parseDateRange(url);
  if (!range.ok) return range.response;

  const limit = parseLimit(url);
  if (typeof limit === "object") return limit.error;

  const loc = locationCode.toLowerCase();

  // Direct PostgREST GET — same headers pattern as the other Supabase REST
  // calls in this monorepo. The select list omits `phone` (raw 10-digit),
  // terms_text, and the fraud-detection columns intentionally; CSV uses a
  // wider select.
  const u = new URL(`${env.SUPABASE_URL}/rest/v1/maxpass_signups`);
  u.searchParams.set("location_code", `eq.${loc}`);
  u.searchParams.append("submitted_at", `gte.${range.fromIso}`);
  u.searchParams.append("submitted_at", `lte.${range.toIso}`);
  u.searchParams.set(
    "select",
    "submitted_at,phone_formatted,email,package_pretty,today_price,city,region"
  );
  u.searchParams.set("order", "submitted_at.desc");
  u.searchParams.set("limit", String(limit));

  const resp = await fetch(u.toString(), {
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
    // `since` is the Brief 56 field name; kept for back-compat. `from` and
    // `to` (Brief 84) carry the same semantic and are preferred by new code.
    since: range.fromIso,
    from: range.fromIso,
    to: range.toIso,
    days: range.days,
    limit,
    limit_hit: rows.length === limit
  });
}

/**
 * GET /admin/api/locations/{loc}/signups.csv?from=&to=
 *
 * CSV export of all matching rows up to the safety cap. Same auth gate as
 * the JSON endpoint. RFC 4180 quoting; Content-Disposition: attachment.
 *
 *   200 text/csv on success
 *   400 on malformed params
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
  const range = parseDateRange(url);
  if (!range.ok) return range.response;

  const loc = locationCode.toLowerCase();

  const u = new URL(`${env.SUPABASE_URL}/rest/v1/maxpass_signups`);
  u.searchParams.set("location_code", `eq.${loc}`);
  u.searchParams.append("submitted_at", `gte.${range.fromIso}`);
  u.searchParams.append("submitted_at", `lte.${range.toIso}`);
  u.searchParams.set("select", "*");
  u.searchParams.set("order", "submitted_at.desc");
  // Request one row above the cap so we can detect overflow without
  // fetching the full count.
  u.searchParams.set("limit", String(CSV_SAFETY_CAP + 1));

  const resp = await fetch(u.toString(), {
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
    }
  });
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

  const csv = toCsv(raw as Array<Record<string, unknown>>, CSV_COLUMNS);
  const filename = `signups-${loc}-${range.fromYmd}-to-${range.toYmd}.csv`;
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
 * CSV rendering (RFC 4180)
 * ============================================================ */

function toCsv(
  rows: ReadonlyArray<Record<string, unknown>>,
  columns: ReadonlyArray<CsvColumn>
): string {
  const escape = (v: unknown): string => {
    const s = v == null ? "" : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = columns.map((c) => escape(c.label)).join(",");
  const body = rows
    .map((r) => columns.map((c) => escape(r[c.key])).join(","))
    .join("\n");
  return header + "\n" + body + (rows.length > 0 ? "\n" : "");
}
