// Inline signature path — production default.
//
// Worker renders the picker + signup form HTML directly. Customer agrees
// to terms via a checkbox; form posts to /api/submit-signup which (in
// Chunk 3) writes straight to maxpass_signups.
//
// HTML rendering eventually moves to apps/web (Next.js) per the migration
// plan, replacing this module + the render/ directory entirely. Until
// then this is the production rendering path.

import type { PricingSimpleResolvedRow } from "@splash/types/pricing";
import type { Env } from "../env.js";
import { renderPicker } from "../render/picker.js";
import { renderSignupForm } from "../render/form.js";
import { addMonthsClamp, buildTermsText, isFamilyPlan, mmddyyyy, yyyymmdd } from "./terms.js";

/** Marker for the dispatch registry. Mirrors JOTFORM_MODE_ID in jotform.ts. */
export const INLINE_MODE_ID = "inline" as const;

/**
 * Render the package picker for a location. Returns a 200 HTML Response.
 * Caller is responsible for resolving the pricing rows from the cache
 * before calling this.
 */
export function renderInlinePackagePicker(args: {
  env: Env;
  locationCode: string;
  rows: PricingSimpleResolvedRow[];
  /** Route prefix the request came in on — "/signup", "/q", or "/join". */
  prefix: string;
}): Response {
  const html = renderPicker({
    locationCode: args.locationCode,
    rows: args.rows,
    prefix: args.prefix
  });
  return htmlResponse(html);
}

/**
 * Render the signup form for a specific package. Returns a 200 HTML
 * Response. Caller is responsible for resolving the pricing row from the
 * cache before calling this.
 *
 * Terms text is generated here at render time (not at submission time)
 * because the customer must SEE the exact text they're agreeing to. The
 * form's hidden `terms` field carries this string back on submit so the
 * `maxpass_signups.terms_text` write captures the same string.
 */
export function renderInlineSignupForm(args: {
  env: Env;
  locationCode: string;
  packageCode: string;
  row: PricingSimpleResolvedRow;
}): Response {
  const today = Number(args.row.today ?? 0);
  const monthly = Number(args.row.ongoing ?? 0);

  // ET wall-clock dates. Previously this used `new Date()` directly, which
  // produces UTC wall-clock in the Workers runtime — for late-evening ET
  // submissions that flipped the displayed date forward a day. Mirror the
  // legacy worker's pattern: convert "now" through an en-US toLocaleString
  // in the America/New_York zone to get the local Y/M/D, then construct
  // a fresh local Date from those components.
  const tz = "America/New_York";
  const localNow = new Date(new Date().toLocaleString("en-US", { timeZone: tz }));
  const todayDate = new Date(
    localNow.getFullYear(),
    localNow.getMonth(),
    localNow.getDate()
  );
  const nextDate = addMonthsClamp(todayDate, 1);

  const isBogo = args.row.bogo === true;
  const month3Date = isBogo ? addMonthsClamp(todayDate, 2) : null;
  const month3Str = month3Date ? mmddyyyy(month3Date) : "";
  const month3Iso = month3Date ? yyyymmdd(month3Date) : "";
  const todayStr = mmddyyyy(todayDate);
  const nextBillingStr = mmddyyyy(nextDate);

  const termsText = buildTermsText({
    todayPrice: today,
    monthlyPrice: monthly,
    todayStr,
    nextBillingStr,
    familyPlan: isFamilyPlan(args.packageCode),
    bogo: isBogo,
    month3Str
  });

  const priceTextToday = `$${today} plus tax`;
  const priceTextMonthly = isFamilyPlan(args.packageCode)
    ? `$${monthly} + $0.01 per additional vehicle, plus tax`
    : `$${monthly} plus tax`;

  const html = renderSignupForm({
    locationCode: args.locationCode,
    packageCode: args.packageCode,
    row: args.row,
    termsText,
    isBogo,
    todayStr,
    nextBillingStr,
    month3Str,
    month3Iso,
    priceTextToday,
    priceTextMonthly
  });
  return htmlResponse(html);
}

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // Pricing is cached worker-side; no value in browser caching the
      // rendered HTML. no-store also avoids back-button stale-form weirdness
      // during cutover.
      "Cache-Control": "no-store"
    }
  });
}
