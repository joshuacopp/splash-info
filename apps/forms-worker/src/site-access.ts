// Who may see and act on a given SITE -- the one answer to that question.
//
// Started life as action-items/access.ts and moved here when the SDS list
// needed the same answer. It is deliberately ONE implementation: two features
// each deciding who counts as the site or the RM would drift, and the drift
// would be silent -- somebody quietly able to edit one list and not the other.
//
// NO NEW PERMISSION MODEL. `getLocationsByContactEmail` already answers both
// questions in one indexed read:
//
//   which sites can you see  -> the rows it returns
//   are you the site or RM   -> matched_via
//
// That is exactly what /workorders has run on since Brief 71. It needs no
// dc_role, no tool grant and no new table, and — unlike role-based grants — it
// takes effect immediately instead of after a sign-out/in.
//
// THE JOIN KEY IS PADDED, AND THIS IS THE WHOLE TRAP OF THIS FILE.
//
//   getLocationsByContactEmail returns `site_number` as an INTEGER (19).
//   action_items.location_code is a pricing_simple location_code ("bedford").
//   The bridge is pricing_simple.site, which is ZERO-PADDED TO 3 DIGITS
//   ("019") — matching the pricing_simple_site_is_3_digits CHECK constraint.
//
//   A plain `site_number::text` cast produces "19" and matches NOTHING.
//   Verified against production: the naive join returns zero rows for every
//   site. It does not error — every caller would simply see an empty page,
//   which reads as "no action items" rather than as a bug. Same family as the
//   Brief 62 / Brief 49 join-key failures.
//
//   (CLAUDE.md describes pricing_simple.site as "site_number::text". That is
//   imprecise: it is padded. Trust this file.)

import { getLocationsByContactEmail } from "@splash/db-supabase";
import type { Env } from "./index.js";

export type SiteRole = "admin" | "rm" | "site";

export interface SiteAccess {
  /** location_codes the caller may read. Empty means no access. */
  locationCodes: string[];
  /** location_code -> the strongest role the caller holds there. */
  roleByLocation: Map<string, SiteRole>;
  isAdmin: boolean;
}

/** Bridge a `locations.site_number` integer to the `pricing_simple.site` text
 *  it is stored as. Exported so the join key is testable in isolation rather
 *  than buried in a query. */
export function siteNumberToPricingSite(siteNumber: number): string {
  return String(siteNumber).padStart(3, "0");
}

/**
 * `am_email` is the Regional DIRECTOR and `rm_email` the Regional MANAGER (see
 * the label-vs-data note in CLAUDE.md). Both outrank the site for verification
 * purposes: an RD standing in for an RM should not be blocked from verifying.
 */
function roleFor(matchedVia: "am_email" | "rm_email" | "site_email"): SiteRole {
  return matchedVia === "site_email" ? "site" : "rm";
}

export async function resolveSiteAccess(
  env: Env,
  email: string,
  isAdminTier: boolean
): Promise<SiteAccess> {
  const roleByLocation = new Map<string, SiteRole>();

  // Admin tier sees everything, so there is no location list to build. Callers
  // must check `isAdmin` BEFORE filtering on `locationCodes`, which is empty
  // for an admin precisely because no filter applies.
  if (isAdminTier) {
    return { locationCodes: [], roleByLocation, isAdmin: true };
  }

  let accessible: Awaited<ReturnType<typeof getLocationsByContactEmail>>;
  try {
    accessible = await getLocationsByContactEmail(env, email);
  } catch (err) {
    // Fail CLOSED. An unreadable permission source must not widen access.
    console.error("[forms.site-access] location lookup threw", err);
    return { locationCodes: [], roleByLocation, isAdmin: false };
  }
  if (accessible.length === 0) {
    return { locationCodes: [], roleByLocation, isAdmin: false };
  }

  // site (padded) -> strongest role, so the pricing_simple rows can be mapped
  // back to a role after the lookup.
  const roleBySite = new Map<string, SiteRole>();
  for (const loc of accessible) {
    const site = siteNumberToPricingSite(loc.site_number);
    const role = roleFor(loc.matched_via);
    // rm beats site when someone is on both, because it is the strictly wider
    // capability and taking the weaker one would remove the verify button from
    // an RM who also happens to be a site contact.
    if (role === "rm" || !roleBySite.has(site)) roleBySite.set(site, role);
  }

  const sites = [...roleBySite.keys()];
  const quoted = sites.map((s) => `"${s.replace(/"/g, '""')}"`).join(",");
  const url = new URL("/rest/v1/pricing_simple", env.SUPABASE_URL);
  url.searchParams.set("select", "site,location_code");
  url.searchParams.set("site", `in.(${quoted})`);

  try {
    const resp = await fetch(url.toString(), {
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
      }
    });
    if (!resp.ok) {
      console.error("[forms.site-access] pricing_simple lookup", resp.status);
      return { locationCodes: [], roleByLocation, isAdmin: false };
    }
    // Many rows per location (one per package), so dedupe by location_code.
    const rows = (await resp.json().catch(() => [])) as {
      site: string;
      location_code: string;
    }[];
    for (const r of rows) {
      if (!r.location_code) continue;
      const role = roleBySite.get(r.site);
      if (!role) continue;
      const existing = roleByLocation.get(r.location_code);
      if (role === "rm" || !existing) roleByLocation.set(r.location_code, role);
    }
  } catch (err) {
    console.error("[forms.site-access] pricing_simple lookup threw", err);
    return { locationCodes: [], roleByLocation, isAdmin: false };
  }

  return {
    locationCodes: [...roleByLocation.keys()],
    roleByLocation,
    isAdmin: false
  };
}

/** Read access to one location. */
export function canRead(access: SiteAccess, locationCode: string): boolean {
  return access.isAdmin || access.roleByLocation.has(locationCode);
}

/** Moving status and editing description / priority / due date. Site and RM
 *  both do the work, so both may. */
export function canEdit(access: SiteAccess, locationCode: string): boolean {
  return canRead(access, locationCode);
}

/** Verification is the RM confirming the site's claim, so the site cannot do
 *  it to itself — that is the entire content of the button. */
export function canVerify(access: SiteAccess, locationCode: string): boolean {
  if (access.isAdmin) return true;
  return access.roleByLocation.get(locationCode) === "rm";
}
