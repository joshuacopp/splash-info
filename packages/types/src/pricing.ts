// Pricing types — column names extracted directly from legacy/signupworker.js.
// DO NOT rename columns here without verifying the schema in Supabase.
//
// Sources cited inline: file:line.

/**
 * Pricing mode stored in `pricing_simple.pricing`.
 *
 * Five values are validated by legacy/signupworker.js (see line 185 admin POST
 * handler and line 600 bulk update). The migration plan §5 mentions a sixth
 * mode "penny" which is NOT present in the legacy code — see Step 5A
 * findings for the open question.
 */
export type PricingMode = "full" | "same" | "flash5" | "flash2" | "special";

export const PRICING_MODES: readonly PricingMode[] = [
  "full",
  "same",
  "flash5",
  "flash2",
  "special"
] as const;

/**
 * Row shape of the `pricing_simple` table. Column names extracted from:
 *   - legacy/signupworker.js:3083 fetchAllLocationPkgs select
 *   - legacy/signupworker.js:3106 listDistinctLocations select
 *   - legacy/signupworker.js:3133 getCurrentMode select
 *   - legacy/signupworker.js:3158 setMode update body (pricing, special, updated_at)
 *   - legacy/signupworker.js:768 location-by-email filter (site_email/am_email/rm_email)
 *
 * Additional underlying price columns (per-mode prices: full, same, flash5,
 * flash2, penny + monthly variants) certainly exist on this table — the
 * `pricing_simple_resolved` view is computed from them — but the legacy code
 * never reads or writes them directly. Their exact names are NOT VERIFIED
 * here. Add them in Step 6 only after reading the Supabase schema, per
 * gotcha #252 (do not infer column names).
 */
export interface PricingSimpleRow {
  location_code: string;
  location_pretty: string;
  pkg: string;
  pricing: PricingMode | "" | null;
  /** Set by signupworker.js setMode when mode === "special". */
  special: number | null;
  /** ISO timestamp; bumped by setMode on every write. */
  updated_at: string | null;
  /** Email of site contact — used for site-manager scoping. */
  site_email: string | null;
  /** Email of area manager. */
  am_email: string | null;
  /** Email of regional manager. */
  rm_email: string | null;
}

/**
 * Row shape of the `pricing_simple_resolved` VIEW.
 * Cached 5min fresh / 24h stale-while-revalidate per worker.
 *
 * Source: legacy/signupworker.js:3232 fetchAndCachePricing select.
 *
 * NOTE: pricing_simple_resolved is a VIEW — do not write to it (gotcha #256).
 */
export interface PricingSimpleResolvedRow {
  location_pretty: string;
  location_code: string;
  pkg: string;
  pretty_pkg: string;
  /** Today's price (resolved from the active mode). */
  today: number | null;
  /** Ongoing monthly price. */
  ongoing: number | null;
  /** Sort order for the package picker. */
  sort: number | null;
}

/**
 * Form action accepted by the legacy admin pricing UI. "flip" toggles the
 * current mode between "full" and "same" rather than setting one of the
 * five real modes — see legacy/signupworker.js:191.
 */
export type PricingAction = PricingMode | "flip";

/**
 * Extension of PricingSimpleRow with the per-mode price columns the
 * client-side resolver function needs (apps/signup-worker/src/pricing/resolver.ts).
 *
 * COLUMN NAMES NOT VERIFIED AGAINST SCHEMA: legacy/signupworker.js NEVER
 * reads these columns directly — it consumes the pre-computed
 * `pricing_simple_resolved` view's `today` / `ongoing` instead. The names
 * below come from the Chunk 1 prompt and need to be confirmed against the
 * actual Supabase schema before any caller depends on this resolver in
 * production.
 *
 * Suspicious specifically:
 *   - `pkg$` — literal `$` in the column name. Bracket notation works in
 *     JS, but confirm it isn't a typo for `pkg_dollar`, `pkg_price`,
 *     `package_price`, or similar.
 *   - `single` — name suggests "same as today" baseline (single wash
 *     price?). Confirm semantics.
 *
 * If the schema disagrees, this interface gets the database's column names
 * and the resolver gets updated to read them. The resolver's defensive
 * fallback to `full` for unknown modes keeps the worker safe during the
 * gap.
 */
export interface PricingSimpleRowWithRawPrices extends PricingSimpleRow {
  /** Full-price column. NAME UNVERIFIED — see interface doc. */
  "pkg$": number;
  /** "Same as today" baseline price. NAME UNVERIFIED. */
  single: number;
  /** $5 Flash mode price column. NAME UNVERIFIED. */
  flash5: number;
  /** $2 Flash mode price column. NAME UNVERIFIED. */
  flash2: number;
  // `special: number | null` already inherited from PricingSimpleRow.
}
