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
// Errors come back field-keyed so the form shows them against the grid.

import {
  isFieldVisible,
  normalizePrice,
  type FormSchema,
  type PackagePriceRow
} from "@splash/forms-schema";
import type { Env } from "../index.js";
import { listPackagesForSite } from "../db/forms.js";

const MAX_ROWS = 50;

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
    if (raw == null) continue; // nothing ticked; the validator decides if that's allowed
    if (!Array.isArray(raw) || raw.length > MAX_ROWS) {
      errors[field.key] = "The package list couldn't be read. Reload the page and try again.";
      continue;
    }
    if (raw.length === 0) {
      delete payload[field.key];
      continue;
    }

    const keyValue = String(payload[field.keyFieldKey] ?? "").trim();
    if (!keyValue) {
      errors[field.key] = "Choose a site first.";
      continue;
    }
    const offered = await listPackagesForSite(env, field.keyColumn, keyValue);
    if (offered === null) {
      unavailable = true;
      errors[field.key] = "Couldn't check packages for that site. Please try again.";
      continue;
    }

    const rows: PackagePriceRow[] = [];
    const seen = new Set<string>();
    const problems: string[] = [];
    for (const entry of raw) {
      const r = (entry ?? {}) as Record<string, unknown>;
      const pkg = typeof r.pkg === "string" ? r.pkg : "";
      if (!offered.includes(pkg)) {
        problems.push(`"${pkg || "(blank)"}" isn't a package at this site`);
        continue;
      }
      if (seen.has(pkg)) continue;
      seen.add(pkg);

      const text = (k: string) => (typeof r[k] === "string" ? (r[k] as string) : "");
      const currentSingle = normalizePrice(text("current_single"));
      const currentMonthly = normalizePrice(text("current_monthly"));
      if (!currentSingle || !currentMonthly) {
        problems.push(`${pkg}: enter both current prices`);
        continue;
      }
      // Blank new price = keep the current price. A non-blank one that isn't
      // a price is an error rather than a silent "no change".
      const newSingleRaw = text("new_single").trim();
      const newMonthlyRaw = text("new_monthly").trim();
      const newSingle = newSingleRaw ? normalizePrice(newSingleRaw) : currentSingle;
      const newMonthly = newMonthlyRaw ? normalizePrice(newMonthlyRaw) : currentMonthly;
      if (!newSingle || !newMonthly) {
        problems.push(`${pkg}: a new price isn't a valid amount`);
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

    if (problems.length > 0) {
      errors[field.key] = problems.join("; ");
      continue;
    }
    // Site's own display order, not tick order, so every rendering of the
    // request lists packages the way the site does.
    rows.sort((a, b) => offered.indexOf(a.pkg) - offered.indexOf(b.pkg));
    payload[field.key] = rows;
  }

  if (Object.keys(errors).length > 0) {
    return { ok: false, status: unavailable ? 502 : 422, fields: errors };
  }
  return { ok: true };
}
