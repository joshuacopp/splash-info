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
  /** BOGO ("Buy One Get One") schedule modifier. Orthogonal to `pricing` —
   *  customer pays today's price, month 2 is free, recurring starts month 3.
   *  Optional in the type so unaware callers still typecheck; the column
   *  defaults to false in Supabase so rows always carry a boolean. */
  bogo?: boolean;
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
  /** BOGO schedule modifier. Same column as on pricing_simple — the view
   *  passes it through unchanged. Orthogonal to `today`/`ongoing` (BOGO
   *  stacks on any pricing mode). Optional for unaware callers. */
  bogo?: boolean;
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
 * legacy/signupworker.js never reads these columns directly — it consumes the
 * pre-computed `pricing_simple_resolved` view's `today` / `ongoing` instead —
 * so the names below originally came from the Chunk 1 prompt rather than the
 * schema. `single` was the one that mattered and is now confirmed (Josh,
 * 2026-08-15): see its field doc. `pkg$` is confirmed by use — the literal `$`
 * is real, bracket notation required. `flash5` / `flash2` are still only
 * corroborated by the admin pricing grid's "$5 Flash" / "$2 Flash" modes.
 *
 * The resolver's defensive fallback to `full` for unknown modes keeps the
 * worker safe if any of this is still wrong.
 */
export interface PricingSimpleRowWithRawPrices extends PricingSimpleRow {
  /** Full-price column — the unlimited monthly price. Literal `$` in the
   *  column name is real; requires bracket notation. */
  "pkg$": number;
  /**
   * The SINGLE-WASH price — and, when `pricing` is "same", also the first
   * month's price. Confirmed by Josh 2026-08-15; the old note here guessed it
   * might be a "same as today" monthly baseline, which it is not.
   *
   * Matters because a row's single-wash and monthly prices live side by side:
   * one pricing_simple row per package carries both (e.g. Express = $10
   * single / $20 unlimited), rather than separate single- and unlimited-
   * package rows.
   */
  single: number;
  /** $5 Flash mode price column. */
  flash5: number;
  /** $2 Flash mode price column. */
  flash2: number;
  // `special: number | null` already inherited from PricingSimpleRow.
}
