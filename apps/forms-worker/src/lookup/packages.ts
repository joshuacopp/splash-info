// `POST /forms/api/packages/{slug}` body `{field_key, key_value}`
// → `{packages: string[]}`.
//
// Backs the package price grid: when the submitter picks a site, the page asks
// for that site's package names and draws one row per package. UX only -- the
// submit handler re-reads the list and rejects any package not on it, so a
// tampered or stale page cannot request a price change for a package the site
// does not sell.
//
// Same defenses as the lookup endpoint (lookup/resolve.ts): same-origin, form
// published, and the field must be a package_price_grid in the CURRENT schema,
// so this cannot be used to enumerate pricing_simple for an arbitrary form.

import { isOriginAllowed, jsonError } from "@splash/http";
import type { PackagePriceGridField } from "@splash/forms-schema";
import type { Env } from "../index.js";
import { getFormBySlug, getCurrentVersion, readSitePackages } from "../db/forms.js";

export async function handlePackagesForSite(
  env: Env,
  req: Request,
  slug: string
): Promise<Response> {
  if (!isOriginAllowed(req)) return jsonError(403, "bad_origin");

  const form = await getFormBySlug(env, slug);
  if (!form) return jsonError(404, "form_not_found");
  if (form.status !== "published" || !form.currentVersionId) {
    return jsonError(410, "form_not_accepting");
  }
  const version = await getCurrentVersion(env, form.id, form.currentVersionId);
  if (!version) return jsonError(500, "form_version_missing");

  let body: { field_key?: unknown; key_value?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return jsonError(400, "bad_json");
  }
  const field = version.schema.fields.find(
    (f) => f.key === body.field_key && f.type === "package_price_grid"
  ) as PackagePriceGridField | undefined;
  if (!field) return jsonError(400, "unknown_field");

  const keyValue = typeof body.key_value === "string" ? body.key_value : "";
  // A multi-site grid's sites are always typed 3-digit site numbers.
  const keyColumn = field.multiSite ? "pricing_simple.site" : field.keyColumn;
  const found = keyValue
    ? await readSitePackages(env, keyColumn, keyValue)
    : { packages: [], siteName: null, site: "" };
  if (found === null) return jsonError(502, "packages_unavailable");

  // site_name / site let the page label a multi-site section "Binghamton (122)"
  // and use the canonical 3-digit number; single-site grids ignore them.
  return new Response(
    JSON.stringify({ packages: found.packages, site_name: found.siteName, site: found.site }),
    {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
    }
  );
}
