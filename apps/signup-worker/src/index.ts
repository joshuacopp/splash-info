// Splash Signup Worker — Chunk 4: ADMIN PRICING JSON API.
//
// PUBLIC ROUTES (Chunks 1-3, no auth):
//   GET  /signup/{loc}             — package picker (renders HTML)
//   GET  /signup/{loc}/{pkg}       — signup form OR JotForm redirect
//   GET  /q/...   /join/...        — aliases of /signup/*
//   POST /api/submit-signup        — fraud detection + maxpass_signups insert
//
// ADMIN ROUTES (Chunk 4 — this commit):
//   GET  /admin/api/locations                          — list user's locations
//   GET  /admin/api/locations/{loc}                    — packages + pricing
//   POST /admin/api/locations/{loc}/set-mode           — set mode (some/all pkgs)
//   POST /admin/api/locations/{loc}/flip               — quick-flip full↔same
//   POST /admin/api/bulk-set-mode                      — super_admin only
//
//   All admin routes: authenticate + checkToolAccess(session, "pricing").
//   POSTs additionally require isOriginAllowed (CSRF defense in depth).
//   Per-location auth: super_admin always; otherwise must be in session.locations.
//
// SECURITY POSTURE:
//   - Public signup routes: no auth gate, no CSRF on the form post (the
//     fraud-detection layer is the primary defense; SameSite=Lax cookies
//     aren't relevant for an unauthenticated customer flow).
//   - Admin routes: auth + tool grant + per-row scope + CSRF on writes.
//   - Cache reads/writes use the service-key Supabase client.
//   - HTML responses are no-store; no cookies set on render.

import { createServiceClient } from "@splash/db-supabase";
import { jsonError } from "@splash/http";
import type { Env } from "./env.js";
import { resolveSignatureMode } from "./env.js";
import {
  handleBulkSetMode,
  handleFlip,
  handleGetAdminLocation,
  handleListAdminLocations,
  handleSetMode
} from "./handlers/admin-pricing.js";
import { handleSignupSubmission } from "./handlers/submit-signup.js";
import { getCachedPricingForLocation } from "./pricing/cache.js";
import { renderInlinePackagePicker, renderInlineSignupForm } from "./signature/inline.js";
import {
  buildJotFormRedirectResponse,
  isJotFormModeActive
} from "./signature/jotform.js";

/** Signup-worker route prefixes — legacy aliases preserved. */
const SIGNUP_PREFIXES = ["/signup", "/q", "/join"] as const;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    try {
      // ---- POST /api/submit-signup — fraud detection + maxpass_signups insert.
      if (pathname === "/api/submit-signup" && method === "POST") {
        return handleSignupSubmission(request, env, ctx);
      }

      // ---- /admin/api/* — JSON admin API (auth-gated; see admin-pricing.ts).
      if (pathname.startsWith("/admin/api/")) {
        return dispatchAdminApi(request, env, pathname, method);
      }

      // ---- GET /signup/{loc}[/{pkg}] (and aliases /q, /join).
      for (const prefix of SIGNUP_PREFIXES) {
        if (pathname === prefix || pathname.startsWith(prefix + "/")) {
          if (method !== "GET") return new Response("Not found", { status: 404 });

          const segs = pathname
            .slice(prefix.length)
            .replace(/^\/+/, "")
            .split("/")
            .filter(Boolean);
          if (segs.length === 0) return new Response("Not found", { status: 404 });

          const locationCode = decodeURIComponent(segs[0]!).toLowerCase();

          if (segs.length === 1) {
            return handlePicker({ env, ctx, locationCode, prefix });
          }
          // segs.length >= 2 — first two are loc + pkg; ignore extras.
          const packageCode = decodeURIComponent(segs[1]!).toLowerCase();
          return handleSignupForm({ env, ctx, locationCode, packageCode });
        }
      }

      return new Response("Not found", { status: 404 });
    } catch (err) {
      console.error("signup-worker request failed:", pathname, err);
      return jsonError(500, err instanceof Error ? err.message : "server error");
    }
  }
} satisfies ExportedHandler<Env>;

/* ============================================================
 * Handlers
 * ============================================================ */

interface HandlerArgs {
  env: Env;
  ctx: ExecutionContext;
  locationCode: string;
}

/**
 * GET /signup/{location} — package picker.
 * Reads pricing through the per-location cache; returns 200 HTML.
 */
async function handlePicker(args: HandlerArgs & { prefix: string }): Promise<Response> {
  const sb = createServiceClient(args.env);
  const rows = await getCachedPricingForLocation({
    client: sb,
    locationCode: args.locationCode,
    waitUntil: (p) => args.ctx.waitUntil(p)
  });
  return renderInlinePackagePicker({
    env: args.env,
    locationCode: args.locationCode,
    rows,
    prefix: args.prefix
  });
}

/**
 * GET /signup/{location}/{pkg} — signup form OR JotForm redirect, gated
 * by env.SIGNATURE_MODE.
 */
async function handleSignupForm(
  args: HandlerArgs & { packageCode: string }
): Promise<Response> {
  const sb = createServiceClient(args.env);
  const rows = await getCachedPricingForLocation({
    client: sb,
    locationCode: args.locationCode,
    waitUntil: (p) => args.ctx.waitUntil(p)
  });
  const row = rows.find((r) => r.pkg.toLowerCase() === args.packageCode);
  if (!row) return new Response("Package not found", { status: 404 });

  // Dispatch on signature mode. Default branch (inline) is today's
  // production path; jotform is dormant unless SIGNATURE_MODE is
  // explicitly set.
  if (isJotFormModeActive(args.env)) {
    return buildJotFormRedirectResponse({
      locationCode: args.locationCode,
      packageCode: args.packageCode,
      todayPrice: Number(row.today ?? 0),
      monthlyPrice: Number(row.ongoing ?? 0)
      // phoneFormatted omitted — JotForm phone field name unverified
      // (see signature/jotform.ts PHONE_FIELD_NAME).
    });
  }

  // Resolve mode for future logging hook; result not used directly.
  void resolveSignatureMode(args.env);

  return renderInlineSignupForm({
    env: args.env,
    locationCode: args.locationCode,
    packageCode: args.packageCode,
    row
  });
}

/* ============================================================
 * /admin/api/* dispatch
 * ============================================================ */

/**
 * Path layout:
 *   /admin/api/locations                          (GET)
 *   /admin/api/locations/{loc}                    (GET)
 *   /admin/api/locations/{loc}/set-mode           (POST)
 *   /admin/api/locations/{loc}/flip               (POST)
 *   /admin/api/bulk-set-mode                      (POST)
 *
 * Auth + scope checks live INSIDE each handler — kept there for clear
 * audit lines per endpoint rather than a single up-front gate that would
 * obscure the per-handler 403 anti-leak rules.
 */
async function dispatchAdminApi(
  request: Request,
  env: Env,
  pathname: string,
  method: string
): Promise<Response> {
  // Strip the /admin/api/ prefix.
  const rest = pathname.slice("/admin/api/".length).replace(/\/+$/, "");
  const segs = rest.split("/").filter(Boolean);

  // /admin/api/bulk-set-mode
  if (segs.length === 1 && segs[0] === "bulk-set-mode" && method === "POST") {
    return handleBulkSetMode(request, env);
  }

  // /admin/api/locations[...]
  if (segs[0] === "locations") {
    if (segs.length === 1 && method === "GET") {
      return handleListAdminLocations(request, env);
    }
    if (segs.length >= 2) {
      const loc = decodeURIComponent(segs[1]!);
      // /admin/api/locations/{loc}
      if (segs.length === 2 && method === "GET") {
        return handleGetAdminLocation(request, env, loc);
      }
      // /admin/api/locations/{loc}/{action}
      if (segs.length === 3 && method === "POST") {
        if (segs[2] === "set-mode") return handleSetMode(request, env, loc);
        if (segs[2] === "flip") return handleFlip(request, env, loc);
      }
    }
  }

  return new Response("Not found", { status: 404 });
}

