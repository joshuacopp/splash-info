// Permission gate for /admin/jotform/api/* read endpoints (Brief 107).
//
// Three auth tiers in this worker:
//
//   authenticateAdminOrHigher(request, env)
//     — super_admin / admin tier. Used for `/forms` (the global form list +
//       per-form counts) since RM/RD/GM go straight to per-form views and
//       the global form list isn't meaningful for them. Mirrors fleet's
//       Brief 83 gate.
//
//   authenticateForAdminApi(request, env)
//     — any authenticated session. Used for the per-form list / detail /
//       CSV endpoints. Pair with `accessibleSiteNumbersForSession` to
//       compute the filter set; super_admin / admin skip the filter.
//
//   authenticateSuperAdmin(request, env)
//     — super_admin role only (legacy user_permissions tier; NOT
//       dcRole). Used for /backfill since it's a one-shot operator action.
//
// `accessibleSiteNumbersForSession`: super_admin / admin / dcRole admin /
// dcRole super_admin → `"all"` (skip scope filter). Anyone else → resolve
// the set of `site_number` strings the user can see via
// `getLocationsByContactEmail` (RM via rm_email, RD via am_email, GM via
// site_email). JotForm's `typeA` widget returns the site number as a
// string sometimes padded ("090" for Milford) and sometimes not ("127"
// for Elmira Heights) — observed in the operator's sample payloads. The
// `locations` table stores `site_number` as an integer; we convert each
// integer site to BOTH string variants (zero-padded 3-digit AND unpadded)
// here so the downstream PostgREST `in.(...)` filter matches either form.

import { authenticate } from "@splash/auth";
import { getLocationsByContactEmail } from "@splash/db-supabase";
import { jsonError } from "@splash/http";

/**
 * Build the accepted `site_number` set for the caller. Returns `"all"` for
 * super_admin / admin (skip filter), or a `Set<string>` of accepted
 * site_number strings (both padded and unpadded forms).
 */
export async function accessibleSiteNumbersForSession(env, session) {
  if (!session || typeof session !== "object") return new Set();

  const isAdminTier =
    session.role === "super_admin" ||
    session.dcRole === "admin" ||
    session.dcRole === "super_admin";
  if (isAdminTier) return "all";

  const email = typeof session.email === "string" ? session.email : "";
  if (!email) return new Set();

  const locations = await getLocationsByContactEmail(env, email);
  const set = new Set();
  for (const loc of locations) {
    const n = loc.site_number;
    if (typeof n !== "number" || !Number.isFinite(n)) continue;
    const unpadded = String(n);
    const padded3 = unpadded.padStart(3, "0");
    set.add(unpadded);
    if (padded3 !== unpadded) set.add(padded3);
  }
  return set;
}

/**
 * Gate for endpoints that require super_admin / admin tier (mirrors fleet
 * Brief 83). Returns the session on success or a typed error response on
 * failure.
 */
export async function authenticateAdminOrHigher(request, env) {
  const base = await authenticateAnyAdmin(request, env);
  if (!base.ok) return base;
  const { session } = base;
  const allowed =
    session.role === "super_admin" ||
    session.dcRole === "admin" ||
    session.dcRole === "super_admin";
  if (!allowed) return { ok: false, response: jsonError(403, "forbidden") };
  return { ok: true, session };
}

/**
 * Gate for the per-form list / detail / CSV endpoints — any authenticated
 * session passes; downstream `accessibleSiteNumbersForSession` applies the
 * per-site scope. RM / RD / GM with no matching locations effectively see
 * an empty result set.
 */
export async function authenticateForAdminApi(request, env) {
  return authenticateAnyAdmin(request, env);
}

/**
 * Gate for /backfill — super_admin role only. dcRole tiers are NOT
 * permitted because backfill is an operator-driven one-shot per form.
 */
export async function authenticateSuperAdmin(request, env) {
  const base = await authenticateAnyAdmin(request, env);
  if (!base.ok) return base;
  if (base.session.role !== "super_admin") {
    return { ok: false, response: jsonError(403, "super_admin required") };
  }
  return { ok: true, session: base.session };
}

/**
 * Inner helper — validates cookie session via @splash/auth. Returns the
 * session on success or a typed error response on failure. Used by the
 * three exported gates above.
 */
async function authenticateAnyAdmin(request, env) {
  if (!env.SUPABASE_SERVICE_KEY) {
    return {
      ok: false,
      response: jsonError(
        503,
        "admin endpoints not configured (SUPABASE_SERVICE_KEY unbound)"
      )
    };
  }
  const auth = await authenticate(request, env);
  if (auth.status !== "authenticated") {
    return { ok: false, response: jsonError(401, "unauthorized") };
  }
  return { ok: true, session: auth.session };
}
