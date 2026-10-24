// Submit-time resolution for package price grids. Runs after parse and before
// payload validation, and REWRITES the grid's payload into its canonical form:
//
//   - every package must be one the site actually sells, read fresh from
//     pricing_simple -- the page's list is UX, not authority (same posture as
//     the lookup re-resolve in submit/index.ts)
//   - prices are normalised to two decimals ("12.5" -> "12.50")
//   - a blank NEW price becomes the CURRENT price, so every stored row is
//     complete and nobody reading it later has to know blank meant "unchanged"
//   - a blank CURRENT price is an error: the request exists to say what the
//     price is now, and pricing_simple is not trusted to know
//
// Multi-site grids run the same row rules once per site, and additionally:
// every site number must be a real site (its name is read and STORED, so the
// request still reads right after a rename), a site may appear once, and a
// site added with nothing ticked is an error rather than silently dropped --
// the submitter added it for a reason.
//
// Errors come back field-keyed so the form shows them against the grid.

import {
  isFieldVisible,
  normalizePrice,
  packageLabel,
  type FormSchema,
  type PackagePriceRow,
  type PackagePriceSite
} from "@splash/forms-schema";
import type { Env } from "../index.js";
import { readSitePackages } from "../db/forms.js";

const MAX_ROWS = 50;
/** A regional rollout, not the whole estate in one signature. */
const MAX_SITES = 40;

export type PriceGridResult =
  | { ok: true }
  | { ok: false; status: 422 | 502; fields: Record<string, string> };

export async function resolvePriceGrids(
  env: Env,
  schema: FormSchema,
  payload: Record<string, unknown>
): Promise<PriceGridResult> {
  const errors: Record<string, string> = {};
  let unavailable = false;

  for (const field of schema.fields) {
    if (field.type !== "package_price_grid") continue;
    if (!isFieldVisible(field, payload)) {
      delete payload[field.key];
      continue;
    }

    const raw = payload[field.key];
    if (raw == null) continue; // nothing entered; the validator decides if that's allowed
    if (!Array.isArray(raw) || raw.length > (field.multiSite ? MAX_SITES : MAX_ROWS)) {
      errors[field.key] = field.multiSite && Array.isArray(raw)
        ? `At most ${MAX_SITES} sites per request.`
        : "The package list couldn't be read. Reload the page and try again.";
      continue;
    }
    if (raw.length === 0) {
      delete payload[field.key];
      continue;
    }

    // ---- multi-site -------------------------------------------------------
    if (field.multiSite) {
      const sites: PackagePriceSite[] = [];
      const seenSites = new Set<string>();
      const problems: string[] = [];
      for (const entry of raw) {
        const s = (entry ?? {}) as Record<string, unknown>;
        const typed = typeof s.site === "string" ? s.site.trim() : "";
        if (!typed) continue; // an empty "add site" box
        const found = await readSitePackages(env, "pricing_simple.site", typed);
        if (found === null) {
          unavailable = true;
          problems.push(`couldn't check site ${typed}, please try again`);
          continue;
        }
        if (!found.siteName || found.packages.length === 0) {
          problems.push(`site ${typed} isn't a known site`);
          continue;
        }
        const label = `${found.siteName} (${found.site})`;
        if (seenSites.has(found.site)) {
          problems.push(`${label} is listed twice`);
          continue;
        }
        seenSites.add(found.site);
        const rawRows = Array.isArray(s.rows) ? s.rows : [];
        if (rawRows.length === 0) {
          problems.push(`${label}: tick at least one package, or remove the site`);
          continue;
        }
        if (rawRows.length > MAX_ROWS) {
          problems.push(`${label}: too many packages`);
          continue;
        }
        const r = resolveRows(rawRows, found.packages);
        problems.push(...r.problems.map((p) => `${label}: ${p}`));
        sites.push({ site: found.site, site_name: found.siteName, rows: r.rows });
      }
      if (problems.length > 0) {
        errors[field.key] = problems.join("; ");
        continue;
      }
      if (sites.length === 0) delete payload[field.key];
      else payload[field.key] = sites;
      continue;
    }

    // ---- single site (site named by another field) ------------------------
    const keyValue = String(payload[field.keyFieldKey] ?? "").trim();
    if (!keyValue) {
      errors[field.key] = "Choose a site first.";
      continue;
    }
    const found = await readSitePackages(env, field.keyColumn, keyValue);
    if (found === null) {
      unavailable = true;
      errors[field.key] = "Couldn't check packages for that site. Please try again.";
      continue;
    }
    const r = resolveRows(raw, found.packages);
    if (r.problems.length > 0) {
      errors[field.key] = r.problems.join("; ");
      continue;
    }
    payload[field.key] = r.rows;
  }

  if (Object.keys(errors).length > 0) {
    return { ok: false, status: unavailable ? 502 : 422, fields: errors };
  }
  return { ok: true };
}

/**
 * One site's rows, checked against that site's package list. Returned in the
 * site's own display order, not tick order, so every rendering lists packages
 * the way the site does.
 */
function resolveRows(
  raw: unknown[],
  offered: string[]
): { rows: PackagePriceRow[]; problems: string[] } {
  const rows: PackagePriceRow[] = [];
  const seen = new Set<string>();
  const problems: string[] = [];
  for (const entry of raw) {
    const r = (entry ?? {}) as Record<string, unknown>;
    const pkg = typeof r.pkg === "string" ? r.pkg : "";
    if (!offered.includes(pkg)) {
      problems.push(`"${pkg ? packageLabel(pkg) : "(blank)"}" isn't a package at this site`);
      continue;
    }
    if (seen.has(pkg)) continue;
    seen.add(pkg);

    const text = (k: string) => (typeof r[k] === "string" ? (r[k] as string) : "");
    const currentSingle = normalizePrice(text("current_single"));
    const currentMonthly = normalizePrice(text("current_monthly"));
    if (!currentSingle || !currentMonthly) {
      problems.push(`${packageLabel(pkg)}: enter both current prices`);
      continue;
    }
    // Blank new price = keep the current price. A non-blank one that isn't
    // a price is an error rather than a silent "no change".
    const newSingleRaw = text("new_single").trim();
    const newMonthlyRaw = text("new_monthly").trim();
    const newSingle = newSingleRaw ? normalizePrice(newSingleRaw) : currentSingle;
    const newMonthly = newMonthlyRaw ? normalizePrice(newMonthlyRaw) : currentMonthly;
    if (!newSingle || !newMonthly) {
      problems.push(`${packageLabel(pkg)}: a new price isn't a valid amount`);
      continue;
    }
    rows.push({
      pkg,
      current_single: currentSingle,
      current_monthly: currentMonthly,
      new_single: newSingle,
      new_monthly: newMonthly
    });
  }
  rows.sort((a, b) => offered.indexOf(a.pkg) - offered.indexOf(b.pkg));
  return { rows, problems };
}
