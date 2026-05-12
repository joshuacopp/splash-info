// GET /admin/jotform/api/roster (Brief 110).
//
// Backs the RD / RM / Location dropdowns on the apps/web JotForm viewer.
// Returns three arrays scoped to the caller's
// `accessibleSiteNumbersForSession` set in a single round-trip:
//
//   {
//     regional_directors: [{ email, name, site_numbers }],
//     regional_managers:  [{ email, name, site_numbers }],
//     locations: [{ location_code, site_number, location_pretty,
//                   am_email, rm_email }],
//     scope: "all" | "scoped"
//   }
//
// Mirrors damage-worker's `/manage/api/contact-roster` (Brief 59) but folds
// all three rosters into one response. Any authenticated session passes;
// rows are scoped via the accessible-site-numbers gate (admin-tier sees
// everything, RD/RM/GM see only sites under their email).

import { jsonError } from "@splash/http";
import {
  authenticateForAdminApi,
  accessibleSiteNumbersForSession
} from "../auth-gate.js";

export async function handleRoster(request, env) {
  const gate = await authenticateForAdminApi(request, env);
  if (!gate.ok) return gate.response;

  const scope = await accessibleSiteNumbersForSession(env, gate.session);
  // Empty scope → caller is non-admin with no email matches; return
  // empty rosters rather than 5xx.
  if (scope !== "all" && scope.size === 0) {
    return jsonOk({
      regional_directors: [],
      regional_managers: [],
      locations: [],
      scope: "scoped"
    });
  }

  // Pull every relevant column off `locations` in one round-trip, scoped
  // when not admin-tier. The `site_number` column is the integer canonical
  // key (per Brief 71); the customer-display name lives in
  // `pricing_simple.location_pretty`, so we need a second query for that.
  const locationsRows = await fetchLocationsRows(env, scope);
  // Lookup table `pricing_simple.site → location_pretty` keyed by the
  // text site_number (denormalized by `trg_sync_pricing_simple`).
  const prettyByPrice = await fetchPrettyMap(env, locationsRows);

  // De-dupe + assemble: one Location entry per locations row whose
  // site_number matches a pricing_simple.location_code we can resolve.
  // pricing_simple has many rows per location (one per package); we
  // dedupe by location_code.
  const locations = [];
  const rdGroup = new Map();
  const rmGroup = new Map();

  for (const row of locationsRows) {
    const siteNumber =
      typeof row.site_number === "number" && Number.isFinite(row.site_number)
        ? row.site_number
        : null;
    if (siteNumber == null) continue;
    const siteStr = String(siteNumber);
    const meta =
      prettyByPrice.get(siteStr) ||
      prettyByPrice.get(siteStr.padStart(3, "0")) ||
      null;

    const amEmail = normEmail(row.am_email);
    const rmEmail = normEmail(row.rm_email);
    const amName = strOrEmpty(row.area_manager);
    const rmName = strOrEmpty(row.regional_manager);

    // Location entry — prefer the pricing_simple location_pretty if
    // present; fall back to the locations.location (postal address) or
    // the site/site_number itself.
    locations.push({
      location_code: meta?.location_code ?? "",
      site_number: siteStr,
      location_pretty:
        meta?.location_pretty ||
        strOrEmpty(row.location) ||
        siteStr,
      am_email: amEmail || null,
      rm_email: rmEmail || null
    });

    if (amEmail) {
      let g = rdGroup.get(amEmail);
      if (!g) {
        g = { email: amEmail, nameCounts: new Map(), siteNumbers: new Set() };
        rdGroup.set(amEmail, g);
      }
      g.siteNumbers.add(siteStr);
      if (amName) {
        g.nameCounts.set(amName, (g.nameCounts.get(amName) ?? 0) + 1);
      }
    }
    if (rmEmail) {
      let g = rmGroup.get(rmEmail);
      if (!g) {
        g = { email: rmEmail, nameCounts: new Map(), siteNumbers: new Set() };
        rmGroup.set(rmEmail, g);
      }
      g.siteNumbers.add(siteStr);
      if (rmName) {
        g.nameCounts.set(rmName, (g.nameCounts.get(rmName) ?? 0) + 1);
      }
    }
  }

  const regional_directors = collapseGroups(rdGroup);
  const regional_managers = collapseGroups(rmGroup);

  // Sort: locations by pretty (or site_number numerically as fallback);
  // RD/RM alphabetically by display name.
  locations.sort((a, b) => {
    const ap = a.location_pretty || "";
    const bp = b.location_pretty || "";
    const cmp = ap.localeCompare(bp);
    if (cmp !== 0) return cmp;
    return Number(a.site_number) - Number(b.site_number);
  });
  regional_directors.sort((a, b) => a.name.localeCompare(b.name));
  regional_managers.sort((a, b) => a.name.localeCompare(b.name));

  return jsonOk({
    regional_directors,
    regional_managers,
    locations,
    scope: scope === "all" ? "all" : "scoped"
  });
}

/**
 * Read `locations` rows, scoped to the caller's accessible set when not
 * admin-tier. Selects only the columns the roster needs.
 */
async function fetchLocationsRows(env, scope) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) return [];
  const url = new URL("/rest/v1/locations", env.SUPABASE_URL);
  url.searchParams.set(
    "select",
    "site_number,location,area_manager,regional_manager,am_email,rm_email"
  );
  url.searchParams.set("limit", "1000");
  url.searchParams.set("order", "site_number.asc");

  if (scope !== "all") {
    const numeric = new Set();
    for (const v of scope) {
      const n = Number.parseInt(v, 10);
      if (Number.isFinite(n)) numeric.add(n);
    }
    if (numeric.size === 0) return [];
    url.searchParams.set("site_number", `in.(${[...numeric].join(",")})`);
  }

  let resp;
  try {
    resp = await fetch(url.toString(), {
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
      }
    });
  } catch (err) {
    console.error("[jotform.roster] fetchLocationsRows fetch threw:", err);
    return [];
  }
  if (!resp.ok) {
    console.error("[jotform.roster] fetchLocationsRows non-2xx:", resp.status);
    return [];
  }
  return (await resp.json().catch(() => [])) || [];
}

/**
 * Build a Map<site_number_string, {location_code, location_pretty}> from
 * `pricing_simple` for the given site_number set. There are many
 * pricing_simple rows per site (one per package); the first one wins.
 * `pricing_simple.site` is the text site_number (denormalized).
 */
async function fetchPrettyMap(env, locationsRows) {
  const out = new Map();
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) return out;
  if (locationsRows.length === 0) return out;
  // Build the in-filter set from the locations rows' site_numbers.
  const sites = new Set();
  for (const r of locationsRows) {
    if (typeof r.site_number === "number" && Number.isFinite(r.site_number)) {
      sites.add(String(r.site_number));
    }
  }
  if (sites.size === 0) return out;

  const url = new URL("/rest/v1/pricing_simple", env.SUPABASE_URL);
  url.searchParams.set("select", "location_code,site,location_pretty");
  url.searchParams.set("limit", "5000");
  url.searchParams.set(
    "site",
    `in.(${[...sites].map((s) => `"${s}"`).join(",")})`
  );

  let resp;
  try {
    resp = await fetch(url.toString(), {
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
      }
    });
  } catch (err) {
    console.error("[jotform.roster] fetchPrettyMap fetch threw:", err);
    return out;
  }
  if (!resp.ok) {
    console.error("[jotform.roster] fetchPrettyMap non-2xx:", resp.status);
    return out;
  }
  const rows = (await resp.json().catch(() => [])) || [];
  for (const r of rows) {
    const site = strOrEmpty(r.site);
    if (!site) continue;
    if (!out.has(site)) {
      out.set(site, {
        location_code: strOrEmpty(r.location_code),
        location_pretty: strOrEmpty(r.location_pretty)
      });
    }
  }
  return out;
}

/**
 * Collapse a grouping map into the array shape returned by the roster.
 * Picks the most-common name; ties broken lexicographically (matches
 * `listContactRoster` in @splash/db-supabase).
 */
function collapseGroups(group) {
  const out = [];
  for (const [, entry] of group.entries()) {
    let chosenName = "";
    let chosenCount = -1;
    for (const [n, c] of entry.nameCounts.entries()) {
      if (
        c > chosenCount ||
        (c === chosenCount && n.localeCompare(chosenName) < 0)
      ) {
        chosenName = n;
        chosenCount = c;
      }
    }
    out.push({
      email: entry.email,
      name: chosenName || entry.email,
      site_numbers: [...entry.siteNumbers].sort((a, b) => Number(a) - Number(b))
    });
  }
  return out;
}

function normEmail(raw) {
  return typeof raw === "string" ? raw.trim().toLowerCase() : "";
}

function strOrEmpty(raw) {
  return typeof raw === "string" ? raw.trim() : "";
}

function jsonOk(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}
