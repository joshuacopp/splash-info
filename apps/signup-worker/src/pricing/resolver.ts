// Client-side price resolver — used when reading raw `pricing_simple` rows
// instead of the pre-resolved `pricing_simple_resolved` view.
//
// PRIMARY PATH for signup-worker is the resolved view (today / ongoing
// pre-computed by Postgres — matches legacy/signupworker.js:3232). This
// resolver exists for two cases:
//
//   1. Admin pricing UI that re-resolves prices client-side after a mode
//      change (so the display updates without a server round-trip).
//   2. Future caching strategies that prefetch raw rows and resolve at
//      request time.
//
// COLUMN NAMES NOT YET VERIFIED — see PricingSimpleRowWithRawPrices in
// @splash/types/pricing for the schema-confirmation TODO. Until that's
// resolved, callers should treat this resolver as provisional.

import type { PricingSimpleRowWithRawPrices } from "@splash/types/pricing";

/**
 * Today's price for the active pricing mode on a row.
 *
 * Defensive default: ANY unrecognized mode (including legacy "penny" rows
 * that may exist in production) falls back to full-price. This guarantees
 * the worker never returns NaN or a runtime error for a customer signup
 * just because the pricing row was in an unexpected state.
 *
 * Source of truth for the per-mode → column mapping is the Supabase view
 * `pricing_simple_resolved` — see the TODO in @splash/types/pricing.
 */
export function resolveTodayPrice(row: PricingSimpleRowWithRawPrices): number {
  switch (row.pricing) {
    case "full":
      return Number(row["pkg$"]);
    case "same":
      return Number(row.single);
    case "flash5":
      return Number(row.flash5);
    case "flash2":
      return Number(row.flash2);
    case "special":
      // Null special → full price. Caller-friendly default; matches the
      // Step-5A `PricingSimpleRow.special: number | null` typing.
      return Number(row.special ?? row["pkg$"]);
    default:
      console.warn(
        `[pricing] Unknown pricing mode "${row.pricing}" for ${row.location_code}/${row.pkg} — falling back to full`
      );
      return Number(row["pkg$"]);
  }
}

/**
 * Ongoing (recurring monthly) price.
 *
 * Always the full-price column regardless of mode — promotional pricing
 * applies to today's charge only, not the recurring billing.
 */
export function resolveOngoingPrice(row: PricingSimpleRowWithRawPrices): number {
  return Number(row["pkg$"]);
}
