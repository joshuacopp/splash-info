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
//   - a DISCONTINUED package carries no prices at all (its four prices are
//     stored as ""): nothing about its price is being asked
//   - a RENAME is a display name, trimmed; applying it stays manual
//
// Multi-site grids run the same row rules once per site, and additionally:
// every site number must be a real site (its name is read and STORED, so the
// request still reads right after a rename), a site may appear once, and a
// site must ask for at least one change -- a package, a new package, or a
// lube/detail service. New packages need a name and both prices; services
// need a category, a name and a current price (blank new = unchanged, same
// rule as packages).
//
// Errors come back field-keyed so the form shows them against the grid.

import {
  isFieldVisible,
  normalizePrice,
  packageLabel,
  type FormSchema,
  type NewPackage,
  type PackagePriceRow,
  type PackagePriceSite,
  type ServicePrice
} from "@splash/forms-schema";
import type { Env } from "../index.js";
import { readSitePackages } from "../db/forms.js";

const MAX_ROWS = 50;
/** A regional rollout, not the whole estate in one signature. */
const MAX_SITES = 40;
const MAX_NEW_PACKAGES = 30;
const MAX_SERVICES = 60;
const MAX_NAME = 100;

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
        const rawNew = Array.isArray(s.new_packages) ? s.new_packages : [];
        const rawServices = Array.isArray(s.services) ? s.services : [];
        if (rawRows.length + rawNew.length + rawServices.length === 0) {
          problems.push(`${label}: add at least one change, or remove the site`);
          continue;
        }
        if (rawRows.length > MAX_ROWS || rawNew.length > MAX_NEW_PACKAGES || rawServices.length > MAX_SERVICES) {
          problems.push(`${label}: too many entries`);
          continue;
        }

        const r = resolveRows(rawRows, found.packages);
        const n = resolveNewPackages(rawNew, found.packages);
        const v = resolveServices(rawServices);
        problems.push(...[...r.problems, ...n.problems, ...v.problems].map((p) => `${label}: ${p}`));
        sites.push({
          site: found.site,
          site_name: found.siteName,
          rows: r.rows,
          // Omitted rather than [] when unused, so a request with neither reads
          // exactly like one made before these existed.
          ...(n.items.length ? { new_packages: n.items } : {}),
          ...(v.items.length ? { services: v.items } : {})
        });
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

const text = (r: Record<string, unknown>, k: string) =>
  typeof r[k] === "string" ? (r[k] as string) : "";

/** Trimmed, length-capped display name; "" when absent. */
function cleanName(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
}

/**
 * One site's existing-package rows, checked against that site's package list.
 * Returned in the site's own display order, not tick order, so every
 * rendering lists packages the way the site does.
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

    if (r.discontinue === true) {
      rows.push({
        pkg,
        current_single: "",
        current_monthly: "",
        new_single: "",
        new_monthly: "",
        discontinue: true
      });
      continue;
    }

    const currentSingle = normalizePrice(text(r, "current_single"));
    const currentMonthly = normalizePrice(text(r, "current_monthly"));
    if (!currentSingle || !currentMonthly) {
      problems.push(`${packageLabel(pkg)}: enter both current prices`);
      continue;
    }
    // Blank new price = keep the current price. A non-blank one that isn't
    // a price is an error rather than a silent "no change".
    const newSingleRaw = text(r, "new_single").trim();
    const newMonthlyRaw = text(r, "new_monthly").trim();
    const newSingle = newSingleRaw ? normalizePrice(newSingleRaw) : currentSingle;
    const newMonthly = newMonthlyRaw ? normalizePrice(newMonthlyRaw) : currentMonthly;
    if (!newSingle || !newMonthly) {
      problems.push(`${packageLabel(pkg)}: a new price isn't a valid amount`);
      continue;
    }
    const renameTo = cleanName(text(r, "rename_to"));
    rows.push({
      pkg,
      current_single: currentSingle,
      current_monthly: currentMonthly,
      new_single: newSingle,
      new_monthly: newMonthly,
      // A "rename" to its own current name is not a rename.
      ...(renameTo && renameTo.toLowerCase() !== packageLabel(pkg).toLowerCase()
        ? { rename_to: renameTo }
        : {})
    });
  }
  rows.sort((a, b) => offered.indexOf(a.pkg) - offered.indexOf(b.pkg));
  return { rows, problems };
}

/** Packages that do not exist at the site yet: a name and both prices. */
function resolveNewPackages(
  raw: unknown[],
  offered: string[]
): { items: NewPackage[]; problems: string[] } {
  const items: NewPackage[] = [];
  const problems: string[] = [];
  const existing = new Set(offered.map((p) => packageLabel(p).toLowerCase()));
  const seen = new Set<string>();
  for (const entry of raw) {
    const r = (entry ?? {}) as Record<string, unknown>;
    const name = cleanName(text(r, "name"));
    const single = normalizePrice(text(r, "single"));
    const monthly = normalizePrice(text(r, "monthly"));
    // A wholly blank row is an "add" click nobody filled in, not an error.
    if (!name && !text(r, "single").trim() && !text(r, "monthly").trim()) continue;
    if (!name) {
      problems.push("a new package needs a name");
      continue;
    }
    if (existing.has(name.toLowerCase())) {
      problems.push(`new package "${name}" already exists here -- tick it above instead`);
      continue;
    }
    if (seen.has(name.toLowerCase())) {
      problems.push(`new package "${name}" is listed twice`);
      continue;
    }
    seen.add(name.toLowerCase());
    if (!single || !monthly) {
      problems.push(`new package "${name}": enter both prices`);
      continue;
    }
    items.push({ name, single, monthly });
  }
  return { items, problems };
}

/** Lube / detail services: one price each, typed by name. */
function resolveServices(raw: unknown[]): { items: ServicePrice[]; problems: string[] } {
  const items: ServicePrice[] = [];
  const problems: string[] = [];
  for (const entry of raw) {
    const r = (entry ?? {}) as Record<string, unknown>;
    const name = cleanName(text(r, "name"));
    if (!name && !text(r, "current").trim() && !text(r, "new").trim()) continue;
    const category = r.category === "detail" ? "detail" : r.category === "lube" ? "lube" : null;
    if (!category) {
      problems.push(`service "${name || "(unnamed)"}": choose Lube or Detail`);
      continue;
    }
    if (!name) {
      problems.push("a service needs a name");
      continue;
    }
    const current = normalizePrice(text(r, "current"));
    if (!current) {
      problems.push(`${name}: enter the current price`);
      continue;
    }
    const newRaw = text(r, "new").trim();
    const next = newRaw ? normalizePrice(newRaw) : current;
    if (!next) {
      problems.push(`${name}: the new price isn't a valid amount`);
      continue;
    }
    items.push({ category, name, current, new: next });
  }
  return { items, problems };
}
