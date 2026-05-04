// JotForm signature path — DORMANT in production today, fully built so it
// can be flipped on with one env var change (SIGNATURE_MODE = "jotform")
// when legally-binding signatures are needed again.
//
// =============================================================================
// CONTRACT — documented (not legacy-validated)
// =============================================================================
//
// JotForm has no live integration in legacy/signupworker.js (the FORM_ID
// constant is declared at line 9 but never referenced). The legacy worker
// renders the signup form inline and POSTs to /api/submit-signup directly.
// This module is therefore a fresh implementation of the documented contract:
//
//   Form ID (most locations):   252697336786980
//   Family Plan forms:          separate per-package — IDs TBD (see below)
//   Prefill fields (per
//     MIGRATION_PLAN.md gotcha):  package49, todaysDate, todaysPayment,
//                                 nextBilling, typeA19
//   Phone format in prefill:    "(607)768-5674" (parens, NO space after `)`)
//   Date format:                MM-DD-YYYY (matches legacy mmddyyyy)
//
// At flip time, RE-VALIDATE this entire pipeline against JotForm's current
// behavior:
//   1. The 5 prefill field names are still bound to the same form fields.
//   2. The Family Plan form IDs are filled in (see FAMILY_FORM_IDS below).
//   3. JotForm accepts the URL-encoded prefill values as-is (no special
//      escape rules we don't know about).
//   4. The post-submit webhook back into our system is wired up — JotForm
//      doesn't insert into maxpass_signups directly; we'd need either a
//      JotForm "POST submission to URL" integration or a Power Automate
//      flow to do that write.
//
// =============================================================================

import type { Env } from "../env.js";
import { addMonthsClamp, isFamilyPlan, mmddyyyy } from "./terms.js";

/**
 * Default JotForm ID for non-family-plan packages. Source: MIGRATION_PLAN.md
 * gotcha "JotForm/MS Forms integration" + legacy/signupworker.js:9.
 */
export const DEFAULT_FORM_ID = "252697336786980";

/**
 * Form IDs for Family Plan packages — TBD. Each package routes to its own
 * form because the legal copy and form layout differ.
 *
 * REQUIRED BEFORE FLIP: replace these placeholders with real JotForm IDs.
 * See MIGRATION_PLAN.md gotcha #264 — "Family Plan packages have separate
 * JotForm routing: family_bubble_bath, family_ultra_bath, family_express".
 * The migration plan does not record the actual form IDs, so they need to
 * be sourced from the JotForm dashboard at flip time.
 */
export const FAMILY_FORM_IDS: Readonly<Record<string, string>> = {
  family_bubble_bath: "FAMILY_BUBBLE_BATH_FORM_ID_TBD",
  family_ultra_bath: "FAMILY_ULTRA_BATH_FORM_ID_TBD",
  family_express: "FAMILY_EXPRESS_FORM_ID_TBD"
};

/**
 * Pick the right JotForm ID for a given package code.
 * Returns DEFAULT_FORM_ID for non-family packages.
 */
export function selectJotFormId(packageCode: string): string {
  const code = packageCode.toLowerCase();
  if (isFamilyPlan(code)) {
    return FAMILY_FORM_IDS[code] ?? DEFAULT_FORM_ID;
  }
  return DEFAULT_FORM_ID;
}

export interface JotFormPrefill {
  /** Lowercase location code, written into typeA19. */
  locationCode: string;
  /** Package code (e.g., "ultra_bath"), written into package49. */
  packageCode: string;
  /** Today's price (resolved from the active pricing mode). */
  todayPrice: number;
  /** Recurring monthly price. */
  monthlyPrice: number;
  /**
   * Customer's phone in display format `(607)768-5674` (no space after `)`).
   * Optional — JotForm field name not in the documented prefill list, so
   * we omit by default. If JotForm's form has a phone-prefill field at
   * flip time, set this and update PHONE_FIELD_NAME below.
   */
  phoneFormatted?: string;
  /**
   * Override "today" — defaults to current date. Useful for testing /
   * server-time-pinning. Otherwise the function uses Date.now().
   */
  today?: Date;
}

/**
 * JotForm prefill field name for phone — UNVERIFIED. The migration plan's
 * documented prefill list (package49, todaysDate, todaysPayment,
 * nextBilling, typeA19) does NOT include phone, but the prompt explicitly
 * specified the phone format for prefill. At flip time, confirm the actual
 * JotForm phone field name and update this constant.
 */
const PHONE_FIELD_NAME = "phoneNumber";

/**
 * Build the JotForm redirect URL with prefilled fields.
 *
 * Output shape:
 *   https://form.jotform.com/{formId}?package49={pkg}&todaysDate={date}
 *     &todaysPayment={today}&nextBilling={next}&typeA19={loc}
 *     [&phoneNumber={phone}]
 *
 * URL-encoded via URLSearchParams. Caller 302s to the result.
 */
export function buildJotFormRedirectUrl(prefill: JotFormPrefill): string {
  const formId = selectJotFormId(prefill.packageCode);

  const today = prefill.today ?? new Date();
  const next = addMonthsClamp(today, 1);

  const params = new URLSearchParams();
  params.set("package49", prefill.packageCode);
  params.set("todaysDate", mmddyyyy(today));
  params.set("todaysPayment", prefill.todayPrice.toFixed(2));
  params.set("nextBilling", mmddyyyy(next));
  params.set("typeA19", prefill.locationCode);

  if (prefill.phoneFormatted) {
    params.set(PHONE_FIELD_NAME, prefill.phoneFormatted);
  }

  return `https://form.jotform.com/${formId}?${params.toString()}`;
}

/**
 * Build a 302 redirect Response to the JotForm prefill URL. Convenience
 * wrapper for the router — once SIGNATURE_MODE === "jotform", the
 * `/signup/{loc}/{pkg}` GET handler calls this.
 */
export function buildJotFormRedirectResponse(prefill: JotFormPrefill): Response {
  const url = buildJotFormRedirectUrl(prefill);
  return new Response("", {
    status: 302,
    headers: { Location: url }
  });
}

/**
 * Convenience marker that this module is wired to the env. Imported (and
 * void-referenced) by index.ts to keep the JotForm path live in the import
 * graph until the router actually invokes it in Chunk 2 / 3.
 */
export const JOTFORM_MODE_ID = "jotform" as const;

/**
 * Sanity check at request time — verifies the env var is "jotform" before
 * the caller commits to the JotForm redirect path. Defaults to false when
 * env.SIGNATURE_MODE is anything else.
 */
export function isJotFormModeActive(env: Env): boolean {
  return (env.SIGNATURE_MODE ?? "").toLowerCase() === JOTFORM_MODE_ID;
}
