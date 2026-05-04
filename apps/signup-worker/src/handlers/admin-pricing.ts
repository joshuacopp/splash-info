// Admin pricing JSON API.
//
// =============================================================================
// ROUTE TABLE (post-Step-7 cutover; production paths in comments)
// =============================================================================
//
// All routes:
//   - authenticate() at the top — must be a valid session
//   - checkToolAccess(session, "pricing") — super_admin bypasses, location_admin
//     must have user_tool_access.tool='pricing'
//   - per-location auth: super_admin always; otherwise the location must be
//     in session.locations
//
// Reads (no CSRF — GETs are idempotent):
//   GET  /admin/api/locations                          — list user's locations
//   GET  /admin/api/locations/{loc}                    — packages + pricing
//
// Writes (isOriginAllowed CSRF check at top):
//   POST /admin/api/locations/{loc}/set-mode           — { mode, pkgList?, specialPrice? }
//   POST /admin/api/locations/{loc}/flip               — quick-flip full↔same
//   POST /admin/api/bulk-set-mode                      — super_admin only
//                                                        { locationCodes[], mode, pkgList?, specialPrice? }
//
// =============================================================================
// CACHE INVALIDATION
// =============================================================================
// Every successful pricing write calls invalidatePricingCache(locationCode).
// Bulk endpoint calls it once per affected location (per-location key scheme;
// see apps/signup-worker/src/pricing/cache.ts contract).
//
// =============================================================================
// LEGACY DIVERGENCE NOTES (port not refactor — flagged for review)
// =============================================================================
//   - Legacy was HTML-form-based; this is JSON-only. Form-action names mapped
//     to endpoint paths:
//        legacy POST /admin/{loc}  action=full    → POST /admin/api/locations/{loc}/set-mode { mode: "full" }
//        legacy POST /admin/{loc}  action=flip    → POST /admin/api/locations/{loc}/flip
//   - No audit log writes — legacy doesn't either. If pricing-change auditing
//     becomes a requirement, add via @splash/db-supabase logSysadminAudit
//     equivalent (sysadmin_audit_log already supports arbitrary action types).
//   - Per-package modal selection: legacy's modal asked for `pkg_list[]` on
//     every mode button. The new API accepts `pkgList?: string[]` — when
//     omitted, applies to all packages at the location (matches legacy
//     "no checkboxes" semantic).

import { isOriginAllowed, json, jsonError } from "@splash/http";
import {
  authenticate,
  checkToolAccess
} from "@splash/auth";
import {
  createServiceClient,
  fetchPricingResolvedByLocation,
  getPricingMode,
  listDistinctLocations,
  listLocationPkgs,
  logSysadminAudit,
  setPricingMode,
  type SupabaseClient
} from "@splash/db-supabase";
import type { PricingMode, PricingSimpleResolvedRow, PricingSimpleRow } from "@splash/types/pricing";
import type { Session } from "@splash/types/session";
import type { Env } from "../env.js";
import { invalidatePricingCache } from "../pricing/cache.js";

/* ============================================================
 * Auth + scope helpers
 * ============================================================ */

/** True if session may read/write the given location_code. */
function userCanAccessLocation(session: Session, locationCode: string): boolean {
  if (session.role === "super_admin") return true;
  const code = locationCode.toLowerCase();
  return session.locations.some((l) => l.toLowerCase() === code);
}

/** Discriminated-union outcome of the common admin gate. */
type AdminGate =
  | { ok: true; session: Session; sb: SupabaseClient }
  | { ok: false; response: Response };

/**
 * Common gate for every /admin/api/* handler: authenticate + tool grant.
 * Returns the session + a service-key client on success, or a typed
 * error response on failure. CSRF check is the caller's responsibility
 * (POST handlers run isOriginAllowed BEFORE calling this).
 */
async function adminGate(request: Request, env: Env): Promise<AdminGate> {
  const auth = await authenticate(request, env);
  if (auth.status !== "authenticated") {
    return { ok: false, response: jsonError(401, "unauthorized") };
  }
  if (!checkToolAccess(auth.session, "pricing")) {
    return { ok: false, response: jsonError(403, "forbidden") };
  }
  return { ok: true, session: auth.session, sb: createServiceClient(env) };
}

/** Aggregated per-location summary for the picker. */
interface LocationSummary {
  location_code: string;
  location_pretty: string;
  /** Current pricing mode (best-effort — first row's `pricing` value). */
  pricing: string;
}

/**
 * Resolve the user's accessible locations + their current modes.
 *   - super_admin: every location in pricing_simple
 *   - location_admin: session.locations enriched with location_pretty + mode
 */
async function listAccessibleLocations(
  sb: SupabaseClient,
  session: Session
): Promise<LocationSummary[]> {
  if (session.role === "super_admin") {
    return listDistinctLocations(sb);
  }
  if (session.locations.length === 0) return [];

  const rows = await listLocationPkgs(sb, session.locations);
  const seen = new Map<string, LocationSummary>();
  for (const r of rows) {
    const code = r.location_code.toLowerCase();
    if (!seen.has(code)) {
      seen.set(code, {
        location_code: code,
        location_pretty: r.location_pretty ?? code,
        pricing: r.pricing ?? ""
      });
    }
  }
  return Array.from(seen.values()).sort((a, b) =>
    a.location_pretty.localeCompare(b.location_pretty)
  );
}

/* ============================================================
 * Read endpoints
 * ============================================================ */

/**
 * GET /admin/api/locations — list of locations the user can manage.
 *   200 { locations: [{ location_code, location_pretty, pricing }] }
 *   401 / 403 from adminGate
 */
export async function handleListAdminLocations(
  request: Request,
  env: Env
): Promise<Response> {
  const gate = await adminGate(request, env);
  if (!gate.ok) return gate.response;
  const locations = await listAccessibleLocations(gate.sb, gate.session);
  return json({ locations });
}

/**
 * GET /admin/api/locations/{loc} — packages + pricing for a single location.
 *   200 { location_code, location_pretty, packages: PricingSimpleRow[] }
 *   404 if no packages exist for the location
 *   401 / 403 from adminGate or scope check
 */
export async function handleGetAdminLocation(
  request: Request,
  env: Env,
  locationCode: string
): Promise<Response> {
  const gate = await adminGate(request, env);
  if (!gate.ok) return gate.response;
  if (!userCanAccessLocation(gate.session, locationCode)) {
    return jsonError(403, "forbidden");
  }

  const packages = await listLocationPkgs(gate.sb, [locationCode.toLowerCase()]);
  if (packages.length === 0) {
    return jsonError(404, `No packages found for ${locationCode}`);
  }

  // Also surface pricing_simple_resolved (today / ongoing already computed)
  // so the UI can show resolved prices alongside the raw-table mode.
  const resolved = await fetchPricingResolvedByLocation(gate.sb, locationCode);

  // Fall back to first row's location_pretty when present.
  const first = packages[0]!;
  return json({
    location_code: locationCode.toLowerCase(),
    location_pretty: first.location_pretty,
    packages,
    resolved
  });
}

/* ============================================================
 * Write endpoints
 * ============================================================ */

interface SetModeBody {
  mode: PricingMode;
  pkgList?: string[];
  specialPrice?: number;
}

/**
 * POST /admin/api/locations/{loc}/set-mode
 *
 * Body:
 *   { mode: "full"|"same"|"flash5"|"flash2"|"special", pkgList?: string[], specialPrice?: number }
 *
 *   - If pkgList omitted/empty: apply to ALL packages at the location.
 *   - If mode === "special" and specialPrice provided: set pricing_simple.special.
 *
 * Cache: invalidatePricingCache(locationCode) on success.
 * Audit: logSysadminAudit with action="pricing_set_mode" on success.
 * Refresh: returns both `packages` (raw rows w/ mode) and `resolved`
 *   (today/ongoing pre-computed) so the UI updates without follow-up GETs.
 */
export async function handleSetMode(
  request: Request,
  env: Env,
  locationCode: string
): Promise<Response> {
  if (!isOriginAllowed(request)) return jsonError(403, "bad origin");

  const gate = await adminGate(request, env);
  if (!gate.ok) return gate.response;
  if (!userCanAccessLocation(gate.session, locationCode)) {
    return jsonError(403, "forbidden");
  }

  let body: SetModeBody;
  try {
    body = (await request.json()) as SetModeBody;
  } catch {
    return jsonError(400, "Invalid JSON");
  }

  if (!isPricingMode(body.mode)) {
    return jsonError(400, `Invalid mode: ${String(body.mode)}`);
  }

  const loc = locationCode.toLowerCase();
  const pkgList = body.pkgList && body.pkgList.length > 0 ? body.pkgList : null;

  const ok = await setPricingMode(gate.sb, {
    locationCode: loc,
    mode: body.mode,
    pkgList,
    specialPrice: body.specialPrice ?? null
  });
  if (!ok) return jsonError(500, "Pricing update failed");

  // Cache invalidation, refetch raw + resolved in parallel, audit log.
  // Best-effort audit; refetch failures DO surface (the UI needs them).
  await invalidatePricingCache(locationCode);
  const [packages, resolved] = await Promise.all([
    listLocationPkgs(gate.sb, [loc]),
    fetchPricingResolvedByLocation(gate.sb, loc)
  ]);
  await logPricingAudit(gate.sb, gate.session, {
    action: "pricing_set_mode",
    target_id: loc,
    after: {
      mode: body.mode,
      packages_affected: pkgList ?? listAllPkgCodes(packages),
      ...(body.specialPrice !== undefined && { special_price: body.specialPrice })
    }
  });

  return json({ ok: true, mode: body.mode, packages, resolved });
}

/**
 * POST /admin/api/locations/{loc}/flip
 *
 * No body. Reads the location's current mode and toggles full↔same across
 * ALL packages at the location. Mirrors legacy action="flip" exactly
 * (legacy/signupworker.js:191).
 */
export async function handleFlip(
  request: Request,
  env: Env,
  locationCode: string
): Promise<Response> {
  if (!isOriginAllowed(request)) return jsonError(403, "bad origin");

  const gate = await adminGate(request, env);
  if (!gate.ok) return gate.response;
  if (!userCanAccessLocation(gate.session, locationCode)) {
    return jsonError(403, "forbidden");
  }

  const loc = locationCode.toLowerCase();

  // Determine current mode (read first row's `pricing`). Legacy semantic:
  // current === "full" → flip to "same"; anything else → flip to "full".
  const current = await getPricingMode(gate.sb, loc);
  const nextMode: PricingMode = current === "full" ? "same" : "full";

  const ok = await setPricingMode(gate.sb, {
    locationCode: loc,
    mode: nextMode,
    pkgList: null,
    specialPrice: null
  });
  if (!ok) return jsonError(500, "Flip failed");

  await invalidatePricingCache(locationCode);
  const [packages, resolved] = await Promise.all([
    listLocationPkgs(gate.sb, [loc]),
    fetchPricingResolvedByLocation(gate.sb, loc)
  ]);
  await logPricingAudit(gate.sb, gate.session, {
    action: "pricing_flip",
    target_id: loc,
    before: { mode: current ?? null },
    after: { mode: nextMode, packages_affected: listAllPkgCodes(packages) }
  });

  return json({ ok: true, mode: nextMode, packages, resolved });
}

interface BulkSetModeBody {
  locationCodes: string[];
  mode: PricingMode;
  pkgList?: string[];
  specialPrice?: number;
}

/**
 * POST /admin/api/bulk-set-mode (super_admin only)
 *
 * Apply the same mode change to multiple locations in a single call.
 * Iterates per-location; cache invalidation runs per-location too.
 *
 * Stops on the first failure and returns the partial result so the
 * caller can decide whether to retry the rest.
 */
export async function handleBulkSetMode(
  request: Request,
  env: Env
): Promise<Response> {
  if (!isOriginAllowed(request)) return jsonError(403, "bad origin");

  const gate = await adminGate(request, env);
  if (!gate.ok) return gate.response;
  if (gate.session.role !== "super_admin") {
    return jsonError(403, "super_admin required");
  }

  let body: BulkSetModeBody;
  try {
    body = (await request.json()) as BulkSetModeBody;
  } catch {
    return jsonError(400, "Invalid JSON");
  }
  if (!isPricingMode(body.mode)) {
    return jsonError(400, `Invalid mode: ${String(body.mode)}`);
  }
  if (!Array.isArray(body.locationCodes) || body.locationCodes.length === 0) {
    return jsonError(400, "locationCodes required");
  }

  const succeeded: string[] = [];
  const failed: { locationCode: string; reason: string }[] = [];
  const pkgList = body.pkgList && body.pkgList.length > 0 ? body.pkgList : null;

  for (const rawLoc of body.locationCodes) {
    const loc = rawLoc.toLowerCase();
    try {
      const ok = await setPricingMode(gate.sb, {
        locationCode: loc,
        mode: body.mode,
        pkgList,
        specialPrice: body.specialPrice ?? null
      });
      if (!ok) {
        failed.push({ locationCode: rawLoc, reason: "setPricingMode returned false" });
        continue;
      }

      // Per-location: invalidate cache, refresh raw rows for the audit
      // packages_affected detail, write one audit row scoped to THIS
      // location. Per-location rows make "what happened to {X} last week?"
      // queryable directly without parsing arrays.
      await invalidatePricingCache(rawLoc);
      const refreshed = await listLocationPkgs(gate.sb, [loc]);
      await logPricingAudit(gate.sb, gate.session, {
        action: "pricing_bulk_set_mode",
        target_id: loc,
        after: {
          mode: body.mode,
          packages_affected: pkgList ?? listAllPkgCodes(refreshed),
          ...(body.specialPrice !== undefined && { special_price: body.specialPrice })
        }
      });
      succeeded.push(rawLoc);
    } catch (err) {
      failed.push({
        locationCode: rawLoc,
        reason: err instanceof Error ? err.message : "unknown error"
      });
    }
  }

  return json({
    ok: failed.length === 0,
    mode: body.mode,
    succeeded,
    failed
  });
}

/* ============================================================
 * Helpers
 * ============================================================ */

const VALID_MODES: ReadonlySet<string> = new Set(["full", "same", "flash5", "flash2", "special"]);

function isPricingMode(value: unknown): value is PricingMode {
  return typeof value === "string" && VALID_MODES.has(value);
}

/** Pkg codes from a list of pricing_simple rows. Used in audit details
 *  when the caller didn't specify a pkgList (i.e., "all packages affected"). */
function listAllPkgCodes(rows: ReadonlyArray<PricingSimpleRow>): string[] {
  return rows.map((r) => r.pkg);
}

/** Pricing-audit detail shape — written into sysadmin_audit_log.after. */
interface PricingAuditAfter {
  mode: PricingMode;
  packages_affected: string[];
  special_price?: number;
}

/** Pricing-audit `before` shape — only "mode" today, but jsonb in Postgres. */
interface PricingAuditBefore {
  mode: string | null;
}

/**
 * Pricing-change audit log helper. Writes one row to sysadmin_audit_log
 * per pricing mutation. Best-effort — logSysadminAudit swallows errors.
 *
 * Schema-fit:
 *   target_type: "pricing_simple"
 *   target_id:   location_code (single) — bulk uses one row per location too
 *   before:      jsonb { mode } when known (flip captures it; set-mode skips
 *                to save a subrequest)
 *   after:       jsonb { mode, packages_affected, special_price? }
 *
 * Query patterns this enables:
 *   SELECT * FROM sysadmin_audit_log
 *   WHERE action LIKE 'pricing_%' AND target_id = 'binghamton'
 *   ORDER BY created_at DESC;                 -- "what changed at Binghamton?"
 *
 *   SELECT actor_email, target_id, after->>'mode' AS mode, created_at
 *   FROM sysadmin_audit_log
 *   WHERE action = 'pricing_set_mode' AND after->>'mode' = 'special';
 *
 * Reasoning (Chunk 5): legacy never audited pricing changes. Adding it
 * now closes a "who changed what" forensics gap; pricing changes are
 * money-affecting actions.
 */
async function logPricingAudit(
  client: SupabaseClient,
  session: Session,
  args: {
    action: "pricing_set_mode" | "pricing_flip" | "pricing_bulk_set_mode";
    target_id: string;
    before?: PricingAuditBefore;
    after: PricingAuditAfter;
  }
): Promise<void> {
  await logSysadminAudit(client, {
    actor: { id: session.userId, email: session.email },
    action: args.action,
    target_type: "pricing_simple",
    target_id: args.target_id,
    before: args.before ?? null,
    after: args.after
  });
}

// Re-export for the router's dispatch table — imports stay live without
// the satisfies pattern.
export type { PricingSimpleResolvedRow, PricingSimpleRow };
