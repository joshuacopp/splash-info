// Resolve `am_email` / `rm_email` / `location_code` filter params for the
// JotForm admin list / CSV endpoints (Brief 110).
//
// Each filter resolves to a set of `site_number` strings (BOTH zero-padded
// 3-digit AND unpadded forms per the Brief 107 convention — JotForm's
// `typeA` widget returns site numbers as strings sometimes padded
// "090" and sometimes not "127"). The result is the intersection of
// all resolved filter sets AND the caller's `accessibleSiteNumbersForSession`.
//
// Returns `{ siteNumbers: Set<string> | "all" }`. The "all" case means
// no scope filter at all (super_admin / admin with no filter params).
// Empty intersection collapses to an empty Set — handlers short-circuit
// to a 200 with rows: [].

import { accessibleSiteNumbersForSession } from "./auth-gate.js";
import { getLocationsByContactEmail } from "@splash/db-supabase";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const LOCATION_CODE_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Sanitize an email-typed filter param.
 *
 * Returns the trimmed-lowercase form if it looks like an email, else null.
 */
function sanitizeEmail(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;
  return EMAIL_RE.test(s) ? s : null;
}

/**
 * Sanitize a location_code filter param against a tame charset.
 */
function sanitizeLocationCode(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  return LOCATION_CODE_RE.test(s) ? s : null;
}

/**
 * Expand a numeric site_number to both padded and unpadded string forms.
 */
function siteNumberVariants(n) {
  const unpadded = String(n);
  const padded3 = unpadded.padStart(3, "0");
  return padded3 === unpadded ? [unpadded] : [unpadded, padded3];
}

/**
 * Resolve `am_email` to the set of `site_number` strings the AM covers.
 */
async function resolveAmEmail(env, email) {
  const locations = await getLocationsByContactEmail(env, email);
  const set = new Set();
  for (const loc of locations) {
    if (loc.matched_via !== "am_email") continue;
    const n = loc.site_number;
    if (typeof n !== "number" || !Number.isFinite(n)) continue;
    for (const v of siteNumberVariants(n)) set.add(v);
  }
  return set;
}

/**
 * Resolve `rm_email` to the set of `site_number` strings the RM covers.
 */
async function resolveRmEmail(env, email) {
  const locations = await getLocationsByContactEmail(env, email);
  const set = new Set();
  for (const loc of locations) {
    if (loc.matched_via !== "rm_email") continue;
    const n = loc.site_number;
    if (typeof n !== "number" || !Number.isFinite(n)) continue;
    for (const v of siteNumberVariants(n)) set.add(v);
  }
  return set;
}

/**
 * Resolve `location_code` → single `site_number` via `pricing_simple`.
 * Returns an empty Set on miss / failure.
 */
async function resolveLocationCode(env, locationCode) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) return new Set();
  const url = new URL("/rest/v1/pricing_simple", env.SUPABASE_URL);
  url.searchParams.set("location_code", `eq.${locationCode}`);
  url.searchParams.set("select", "site");
  url.searchParams.set("limit", "1");

  let resp;
  try {
    resp = await fetch(url.toString(), {
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
      }
    });
  } catch (err) {
    console.error("[jotform.filters] resolveLocationCode fetch threw:", err);
    return new Set();
  }
  if (!resp.ok) {
    console.error(
      "[jotform.filters] resolveLocationCode non-2xx:",
      resp.status
    );
    return new Set();
  }
  const rows = (await resp.json().catch(() => [])) || [];
  if (!Array.isArray(rows) || rows.length === 0) return new Set();
  const site = typeof rows[0].site === "string" ? rows[0].site.trim() : "";
  if (!site) return new Set();
  // `pricing_simple.site` is the denormalized text site_number (e.g.,
  // "147"). Expand to both padded and unpadded forms so the downstream
  // filter matches JotForm's `typeA` widget output either way.
  const n = Number.parseInt(site, 10);
  if (!Number.isFinite(n)) {
    // Not numeric — fall back to the literal string.
    return new Set([site]);
  }
  return new Set(siteNumberVariants(n));
}

/**
 * Intersect a `Set<string>` with a base scope which may be "all".
 */
function intersectWithScope(filterSet, scope) {
  if (scope === "all") return filterSet;
  if (!(scope instanceof Set)) return new Set();
  const out = new Set();
  for (const v of filterSet) if (scope.has(v)) out.add(v);
  return out;
}

/**
 * Resolve the combined filter set for a caller. Returns
 * `{ siteNumbers: Set<string> | "all" }`. "all" means the caller is
 * admin-tier AND no filter params were passed. Any filter param narrows
 * to a Set (possibly empty → handler short-circuits to []).
 */
export async function resolveLocationFilters(env, session, searchParams) {
  const scope = await accessibleSiteNumbersForSession(env, session);

  const amEmail = sanitizeEmail(searchParams.get("am_email"));
  const rmEmail = sanitizeEmail(searchParams.get("rm_email"));
  const locationCode = sanitizeLocationCode(searchParams.get("location_code"));

  const noFilters = !amEmail && !rmEmail && !locationCode;
  if (noFilters) return { siteNumbers: scope };

  // Resolve each provided filter to a site_number set, then intersect
  // with the caller's accessible scope.
  const sets = [];
  if (amEmail) sets.push(await resolveAmEmail(env, amEmail));
  if (rmEmail) sets.push(await resolveRmEmail(env, rmEmail));
  if (locationCode) sets.push(await resolveLocationCode(env, locationCode));

  // Start from the first set; intersect successively with the others.
  let combined = sets[0];
  for (let i = 1; i < sets.length; i++) {
    const next = sets[i];
    const out = new Set();
    for (const v of combined) if (next.has(v)) out.add(v);
    combined = out;
  }
  combined = intersectWithScope(combined, scope);
  return { siteNumbers: combined };
}
