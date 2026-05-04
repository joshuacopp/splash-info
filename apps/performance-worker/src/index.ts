// Splash Performance Tracker Worker.
//
// Mounted at /pertrack/* in production (Step 7). The prefix-strip lets the
// route table read naturally as "/", "/api/...". On the workers.dev URL
// during Step 6, paths arrive without the prefix and the strip is a no-op.
//
// Owned routes (post-prefix-strip):
//   POST /api/login         — Supabase password grant; sets ONLY the access
//                             cookie with an 8-hour TTL (no refresh — this
//                             worker is the odd one out across the five).
//   POST /api/logout        — clears auth cookies.
//   GET  /api/me            — { email, id } for the authenticated user.
//   GET  /api/locations     — search by site_number / site / mla_location /
//                             location.
//   POST /api/submissions   — insert performance_tracking row.
//   GET  /api/submissions   — list with date / location / greeter / gm /
//                             agm / regional_manager / area_manager /
//                             rm_group / fivestar filters.
//
// AUTH GATE POSITION:
//   /api/login    — no gate (this IS the auth flow).
//   /api/logout   — no gate (cookie clear is unauthenticated-safe).
//   /api/me       — authenticate() FIRST.
//   everything else — checkToolAccess() FIRST with tool="pertrack".
//                     Super-admins bypass; explicit user_tool_access grant
//                     required otherwise. Forbidden → 403; unauthenticated → 401.
//
// HTML APP SHELL: previously served at GET /pertrack/ via ./ui.js — that
// HTML moves to apps/web's app/admin/performance/page.tsx in Step 7. This
// worker no longer owns the GET / handler.
//
// SUPABASE_SERVICE_KEY: the legacy file referred to SUPABASE_SERVICE_ROLE_KEY.
// We standardize on SUPABASE_SERVICE_KEY across all 5 workers per the
// migration plan §1. Update the binding name in the Cloudflare dashboard
// before deploying to workers.dev.

import {
  authenticate,
  buildAuthCookies,
  buildLogoutCookies,
  checkToolAccess,
  supabasePasswordLogin,
  type Session
} from "@splash/auth";
import {
  createServiceClient,
  insertPerformanceSubmission,
  listPerformanceSubmissions,
  searchLocations,
  type SupabaseEnv
} from "@splash/db-supabase";
import { isOriginAllowed, json as jsonResponse } from "@splash/http";
import type { PerformanceTrackingInsert } from "@splash/types/performance";

type Env = SupabaseEnv;

const ROUTE_PREFIX = "/pertrack";
/** 8 hours — performance-worker's distinctive cookie TTL. */
const ACCESS_TOKEN_MAX_AGE = 60 * 60 * 8;

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    let { pathname } = url;
    const method = request.method;

    // Strip the production-route prefix when present. On workers.dev URLs
    // it's absent, so this is a no-op there.
    if (pathname === ROUTE_PREFIX) {
      return Response.redirect(url.origin + ROUTE_PREFIX + "/", 302);
    }
    if (pathname.startsWith(ROUTE_PREFIX + "/")) {
      pathname = pathname.slice(ROUTE_PREFIX.length);
    }

    try {
      // CSRF defense-in-depth on every state-changing POST. GET endpoints
      // skip — idempotent. Same-origin SameSite=Lax cookies remain the
      // primary mitigation; isOriginAllowed is layer two. Chunk 5 retrofit.
      if (method === "POST" && !isOriginAllowed(request)) {
        return jsonResponse({ error: "bad origin" }, 403);
      }

      // Public auth endpoints
      if (pathname === "/api/login" && method === "POST") return apiLogin(request, env);
      if (pathname === "/api/logout" && method === "POST") return apiLogout();

      // Authenticated identity endpoint — gate at the call site for finer
      // control over the response shape (returns user fields vs 401).
      if (pathname === "/api/me" && method === "GET") return apiMe(request, env);

      // Everything below requires authentication AND the "pertrack" tool grant
      // (or super_admin). Single gate call, then dispatch.
      if (
        (pathname === "/api/locations" && method === "GET") ||
        (pathname === "/api/submissions" && (method === "GET" || method === "POST"))
      ) {
        // Two-step gate: authenticate, then check tool access.
        const auth = await authenticate(request, env);
        if (auth.status !== "authenticated") {
          return jsonResponse({ error: "unauthorized" }, 401);
        }
        if (!checkToolAccess(auth.session, "pertrack")) {
          return jsonResponse({ error: "forbidden" }, 403);
        }
        const { session } = auth;

        if (pathname === "/api/locations" && method === "GET") {
          return apiLocations(url, env);
        }
        if (pathname === "/api/submissions" && method === "POST") {
          return apiCreateSubmission(request, env, session);
        }
        if (pathname === "/api/submissions" && method === "GET") {
          return apiListSubmissions(url, env);
        }
      }

      return jsonResponse({ error: "not found" }, 404);
    } catch (err) {
      console.error("performance-worker request failed:", err);
      return jsonResponse(
        { error: err instanceof Error ? err.message : "server error" },
        500
      );
    }
  }
} satisfies ExportedHandler<Env>;

/* ============================================================
 * Auth
 * ============================================================ */

async function apiLogin(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as {
    email?: string;
    password?: string;
  };
  const email = (body.email ?? "").trim();
  const password = (body.password ?? "").trim();
  if (!email || !password) {
    return jsonResponse({ error: "email and password required" }, 400);
  }

  let loginResult;
  try {
    loginResult = await supabasePasswordLogin(env, email, password);
  } catch (err) {
    return jsonResponse(
      { error: err instanceof Error ? err.message : "login failed" },
      401
    );
  }

  // 8-hour access cookie, NO refresh token — performance-worker pattern.
  // (buildAuthCookies skips the refresh cookie when refreshTokenMaxAge is null.)
  const cookies = buildAuthCookies(loginResult.access_token, null, {
    accessTokenMaxAge: ACCESS_TOKEN_MAX_AGE,
    refreshTokenMaxAge: null
  });
  const headers = new Headers();
  for (const c of cookies) headers.append("Set-Cookie", c);
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify({ email: loginResult.user.email }), {
    status: 200,
    headers
  });
}

function apiLogout(): Response {
  const headers = new Headers();
  for (const c of buildLogoutCookies()) headers.append("Set-Cookie", c);
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}

async function apiMe(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (auth.status !== "authenticated") {
    return jsonResponse({ error: "unauthorized" }, 401);
  }
  return jsonResponse({
    email: auth.session.email,
    id: auth.session.userId
  });
}

/* ============================================================
 * Locations
 * ============================================================ */

async function apiLocations(url: URL, env: Env): Promise<Response> {
  const q = (url.searchParams.get("q") ?? "").trim();
  const sb = createServiceClient(env);
  try {
    const rows = await searchLocations(sb, q, 20);
    return jsonResponse(rows);
  } catch (err) {
    return jsonResponse(
      { error: err instanceof Error ? err.message : "locations query failed" },
      500
    );
  }
}

/* ============================================================
 * Submissions
 * ============================================================ */

async function apiCreateSubmission(
  request: Request,
  env: Env,
  session: Session
): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

  if (!body.location_id) {
    return jsonResponse({ error: "location_id is required" }, 400);
  }

  const row: PerformanceTrackingInsert = {
    visit_at: stringOr(body.visit_at, new Date().toISOString()),
    location_id: Number(body.location_id),
    capture_rate: toNumOrNull(body.capture_rate),
    opportunities: toIntOrNull(body.opportunities),
    greeter_1_name: trimOrNull(body.greeter_1_name),
    greeter_2_name: trimOrNull(body.greeter_2_name),
    greeter_3_name: trimOrNull(body.greeter_3_name),
    greeter_1_shift_start: stringOrNull(body.greeter_1_shift_start),
    greeter_1_shift_end: stringOrNull(body.greeter_1_shift_end),
    greeter_2_shift_start: stringOrNull(body.greeter_2_shift_start),
    greeter_2_shift_end: stringOrNull(body.greeter_2_shift_end),
    greeter_3_shift_start: stringOrNull(body.greeter_3_shift_start),
    greeter_3_shift_end: stringOrNull(body.greeter_3_shift_end),
    gm_on_site: !!body.gm_on_site,
    gm_name: trimOrNull(body.gm_name),
    agm_on_site: !!body.agm_on_site,
    agm_name: trimOrNull(body.agm_name),
    comments: trimOrNull(body.comments),
    submitted_by: session.userId,
    submitted_by_email: session.email
  };

  const sb = createServiceClient(env);
  try {
    const inserted = await insertPerformanceSubmission(sb, row);
    return jsonResponse(inserted, 201);
  } catch (err) {
    return jsonResponse(
      {
        error: err instanceof Error ? err.message : "insert failed",
        details: err
      },
      500
    );
  }
}

async function apiListSubmissions(url: URL, env: Env): Promise<Response> {
  const sp = url.searchParams;
  const sb = createServiceClient(env);
  try {
    const rows = await listPerformanceSubmissions(sb, {
      date_from: sp.get("date_from"),
      date_to: sp.get("date_to"),
      location_id: sp.get("location_id") ? Number(sp.get("location_id")) : null,
      gm_on_site: triBool(sp.get("gm_on_site")),
      agm_on_site: triBool(sp.get("agm_on_site")),
      greeter: sp.get("greeter"),
      gm_name: sp.get("gm_name"),
      agm_name: sp.get("agm_name"),
      regional_manager: sp.get("regional_manager"),
      area_manager: sp.get("area_manager"),
      rm_group: sp.get("rm_group"),
      fivestar: sp.get("fivestar"),
      limit: sp.get("limit") ? Number(sp.get("limit")) : 200
    });
    return jsonResponse(rows);
  } catch (err) {
    return jsonResponse(
      { error: err instanceof Error ? err.message : "query failed" },
      500
    );
  }
}

/* ============================================================
 * Worker-local helpers
 * (jsonResponse moved to @splash/http as `json` after the rule-of-three
 * trigger fired at sysadmin-worker. The coercion helpers below are still
 * single-worker; revisit if a second worker needs row-build coercion.)
 * ============================================================ */

function trimOrNull(v: unknown): string | null {
  if (v == null) return null;
  const t = String(v).trim();
  return t ? t : null;
}

function toNumOrNull(v: unknown): number | null {
  if (v === "" || v == null) return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

function toIntOrNull(v: unknown): number | null {
  if (v === "" || v == null) return null;
  const n = parseInt(String(v), 10);
  return Number.isNaN(n) ? null : n;
}

function stringOr(v: unknown, fallback: string): string {
  if (v == null) return fallback;
  const t = String(v);
  return t || fallback;
}

function stringOrNull(v: unknown): string | null {
  if (v == null || v === "") return null;
  return String(v);
}

/**
 * Tri-state boolean parse: "true" → true, "false" → false, anything else → null.
 * Mirrors the legacy behavior — apiListSubmissions only narrows the query when
 * the param was explicitly set.
 */
function triBool(s: string | null): boolean | null {
  if (s === "true") return true;
  if (s === "false") return false;
  return null;
}
