// Package price grid -- payload shape and the ONE formatter every surface
// uses (email, PDF, CSV, wide table, detail page, emailed approval page).
// Six renderings of the same row drift; one function cannot.

/** One ticked package. Prices are strings normalised to two decimals
 *  ("12.00"), never floats: a price that round-trips through a double can come
 *  back as 11.999999 and a price-change request must say exactly what it says.
 *
 *  `rename_to` and `discontinue` (2026-10-27) widen the grid from "price
 *  change" to "menu change". A discontinued package carries no prices -- its
 *  four price strings are "" -- because nothing about its price is being
 *  asked for. A renamed one carries prices as usual (unchanged prices are
 *  simply equal). Both are display names, not pricing_simple codes: applying
 *  an approved change stays manual. */
export interface PackagePriceRow {
  pkg: string;
  current_single: string;
  current_monthly: string;
  new_single: string;
  new_monthly: string;
  rename_to?: string;
  discontinue?: boolean;
}

/** A package that does not exist at the site yet. Multi-site only. */
export interface NewPackage {
  name: string;
  single: string;
  monthly: string;
}

/** A lube or detail service price -- one price, not single/monthly, and typed
 *  by name because pricing_simple does not track these. Multi-site only. */
export interface ServicePrice {
  category: "lube" | "detail";
  name: string;
  current: string;
  new: string;
}

/** Accepts "12", "12.5", "12.50", "$12.50", "1,299.00". */
const PRICE_RE = /^\d{1,6}(\.\d{1,2})?$/;

/**
 * "12.5" -> "12.50". Returns null for anything that is not a price, and for
 * the empty string -- callers decide what blank means.
 */
export function normalizePrice(raw: string): string | null {
  const cleaned = raw.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!cleaned || !PRICE_RE.test(cleaned)) return null;
  return Number(cleaned).toFixed(2);
}

function isRow(r: unknown): r is PackagePriceRow {
  return (
    r != null &&
    typeof r === "object" &&
    typeof (r as PackagePriceRow).pkg === "string" &&
    typeof (r as PackagePriceRow).current_single === "string" &&
    typeof (r as PackagePriceRow).new_single === "string"
  );
}

/** A non-empty list of rows -- the single-site grid's whole value. */
export function isPackagePriceRows(v: unknown): v is PackagePriceRow[] {
  return Array.isArray(v) && v.length > 0 && v.every(isRow);
}

/**
 * "college_bubble_bath" -> "College Bubble Bath". pricing_simple has no
 * display name for a package, only its code, and the code is what the
 * payload stores (it is how the package is matched back to the site). This is
 * display only. forms-public.js carries a copy, since it cannot import this.
 */
export function packageLabel(code: string): string {
  return code
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * The difference between two normalised prices: "+$2.00 (+8.3%)".
 *
 * ONE implementation for the PDF, the approval page, emails and the admin
 * views -- an approver comparing the PDF to the email must never see two
 * percentages for the same change. Cents arithmetic on the two-decimal
 * strings, never floats. A change too small to show at one decimal reads
 * "<0.1%" rather than "0%", which would contradict the dollar figure beside
 * it. `direction` lets renderers colour it.
 */
export function priceDiff(
  current: string,
  next: string
): { direction: "up" | "down" | "none"; text: string } {
  const cents = (s: string) => Math.round(Number(s) * 100);
  const diff = cents(next) - cents(current);
  if (!Number.isFinite(diff) || diff === 0) return { direction: "none", text: "no change" };
  const sign = diff > 0 ? "+" : "-";
  const base = cents(current);
  let pct = "";
  if (base > 0) {
    const p = Math.round((Math.abs(diff) / base) * 1000) / 10;
    pct = p < 0.1 ? " (<0.1%)" : ` (${sign}${p}%)`;
  }
  return {
    direction: diff > 0 ? "up" : "down",
    text: `${sign}$${(Math.abs(diff) / 100).toFixed(2)}${pct}`
  };
}

function priceChange(current: string, next: string): string {
  if (current === next) return `$${current} (no change)`;
  return `$${current} → $${next} ${priceDiff(current, next).text}`;
}

/** "Works → Bath (renamed)", "Ultimate (discontinued)", or just "Ultimate". */
export function rowTitle(r: PackagePriceRow): string {
  const name = packageLabel(r.pkg);
  if (r.discontinue) return `${name} (discontinued)`;
  if (r.rename_to) return `${name} → ${r.rename_to} (renamed)`;
  return name;
}

/** "Ultimate: Single $12.00 → $14.00 +$2.00 (+16.7%) · Monthly $29.99 (no change)" */
export function formatPackagePriceRow(r: PackagePriceRow): string {
  if (r.discontinue) return `${packageLabel(r.pkg)}: discontinued`;
  return (
    `${rowTitle(r)}: Single ${priceChange(r.current_single, r.new_single)}` +
    ` · Monthly ${priceChange(r.current_monthly, r.new_monthly)}`
  );
}

/** One line per package, for plain-text surfaces. */
export function formatPackagePriceRows(rows: PackagePriceRow[]): string {
  return rows.map(formatPackagePriceRow).join("\n");
}

/** "New package: Bubble Bath: Single $25.00 · Monthly $49.99" */
export function formatNewPackage(p: NewPackage): string {
  return `New package: ${p.name}: Single $${p.single} · Monthly $${p.monthly}`;
}

export function serviceCategoryLabel(c: ServicePrice["category"]): string {
  return c === "lube" ? "Lube" : "Detail";
}

/** "Lube · Full synthetic oil change: $79.99 → $84.99 +$5.00 (+6.3%)" */
export function formatServicePrice(s: ServicePrice): string {
  return `${serviceCategoryLabel(s.category)} · ${s.name}: ${priceChange(s.current, s.new)}`;
}

// ---------------------------------------------------------------------------
// Multi-site grids
// ---------------------------------------------------------------------------

/**
 * A multi-site grid's payload is one entry per SITE, each carrying its own
 * rows. A single-site grid stores bare rows (PackagePriceRow[]) and takes its
 * site from another field; both shapes stay readable forever because past
 * submissions are pinned to the schema version they were filled on.
 *
 * `site_name` is resolved server-side at submit (pricing_simple.location_pretty)
 * and stored, so the request still reads correctly if a site is renamed.
 *
 * `rows` may be EMPTY when the site's changes are only new packages or
 * services. `new_packages` / `services` are absent on requests made before
 * they existed; read them through `?? []`.
 */
export interface PackagePriceSite {
  site: string;
  site_name: string;
  rows: PackagePriceRow[];
  new_packages?: NewPackage[];
  services?: ServicePrice[];
}

export function isPackagePriceSites(v: unknown): v is PackagePriceSite[] {
  return (
    Array.isArray(v) &&
    v.length > 0 &&
    v.every(
      (s) =>
        s != null &&
        typeof s === "object" &&
        typeof (s as PackagePriceSite).site === "string" &&
        Array.isArray((s as PackagePriceSite).rows) &&
        (s as PackagePriceSite).rows.every(isRow)
    )
  );
}

/** "Binghamton (122)" -- or just the number when the name is unknown. */
export function siteLabel(s: Pick<PackagePriceSite, "site" | "site_name">): string {
  return s.site_name ? `${s.site_name} (${s.site})` : s.site;
}

/** Either grid shape. */
export function isPriceGridValue(v: unknown): v is PackagePriceRow[] | PackagePriceSite[] {
  return isPackagePriceRows(v) || isPackagePriceSites(v);
}

/** Every change at one site, one line each. */
export function formatSiteChanges(s: PackagePriceSite): string[] {
  return [
    ...s.rows.map(formatPackagePriceRow),
    ...(s.new_packages ?? []).map(formatNewPackage),
    ...(s.services ?? []).map(formatServicePrice)
  ];
}

/** Plain-text rendering of either shape, one change per line; multi-site
 *  values group under a site heading line, changes indented beneath it. */
export function formatPriceGridValue(v: PackagePriceRow[] | PackagePriceSite[]): string {
  if (isPackagePriceSites(v)) {
    return v
      .map((s) => `${siteLabel(s)}\n${formatSiteChanges(s).map((l) => `  ${l}`).join("\n")}`)
      .join("\n");
  }
  return formatPackagePriceRows(v);
}

/** "Binghamton (122), Vestal (127)" -- for subjects and headers. Empty for a
 *  single-site value, which carries no site of its own. */
export function priceGridSitesSummary(v: unknown): string {
  return isPackagePriceSites(v) ? v.map(siteLabel).join(", ") : "";
}
