// Package price grid -- payload shape and the ONE formatter every surface
// uses (email, PDF, CSV, wide table, detail page, emailed approval page).
// Six renderings of the same row drift; one function cannot.

/** One ticked package. Prices are strings normalised to two decimals
 *  ("12.00"), never floats: a price that round-trips through a double can come
 *  back as 11.999999 and a price-change request must say exactly what it says. */
export interface PackagePriceRow {
  pkg: string;
  current_single: string;
  current_monthly: string;
  new_single: string;
  new_monthly: string;
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

export function isPackagePriceRows(v: unknown): v is PackagePriceRow[] {
  return (
    Array.isArray(v) &&
    v.length > 0 &&
    v.every(
      (r) =>
        r != null &&
        typeof r === "object" &&
        typeof (r as PackagePriceRow).pkg === "string" &&
        typeof (r as PackagePriceRow).current_single === "string" &&
        typeof (r as PackagePriceRow).new_single === "string"
    )
  );
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

function priceChange(current: string, next: string): string {
  return current === next ? `$${current} (no change)` : `$${current} → $${next}`;
}

/** "Ultimate: Single $12.00 → $14.00 · Monthly $29.99 (no change)" */
export function formatPackagePriceRow(r: PackagePriceRow): string {
  return (
    `${packageLabel(r.pkg)}: Single ${priceChange(r.current_single, r.new_single)}` +
    ` · Monthly ${priceChange(r.current_monthly, r.new_monthly)}`
  );
}

/** One line per package, for plain-text surfaces. */
export function formatPackagePriceRows(rows: PackagePriceRow[]): string {
  return rows.map(formatPackagePriceRow).join("\n");
}
