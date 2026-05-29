// Terms-of-service text generation for signup.
//
// Source: legacy/signupworker.js:2266-2273. Two distinct templates — one
// for Family Plan packages, one for everything else. Both substitute the
// today/monthly/start/next strings; rest of the text is fixed legal copy.
//
// Both signature paths consume this:
//   - inline: renders into the signup form HTML + writes verbatim to
//     maxpass_signups.terms_text on submission
//   - jotform (dormant): if a JotForm prefill field for terms is added in
//     the future, this is the source. Today's documented prefill list
//     (package49, todaysDate, todaysPayment, nextBilling, typeA19) does
//     not include a terms field — re-validate at flip time.

const FAMILY_PACKAGES: ReadonlySet<string> = new Set([
  "family_express",
  "family_ultra_bath",
  "family_bubble_bath"
]);

/** True for Family Plan package codes (case-insensitive). */
export function isFamilyPlan(packageCode: string | null | undefined): boolean {
  if (!packageCode) return false;
  return FAMILY_PACKAGES.has(packageCode.toLowerCase());
}

export interface TermsContext {
  /** Numeric price for today's charge — formatted into the body text. */
  todayPrice: number;
  /** Numeric price for the recurring monthly charge. */
  monthlyPrice: number;
  /** Today's date as MM-DD-YYYY (matches legacy mmddyyyy formatting). */
  todayStr: string;
  /** Next billing date as MM-DD-YYYY (today + 1 month). On BOGO this is
   *  the "second month FREE" date; on non-BOGO it's the recurring start. */
  nextBillingStr: string;
  /** Whether the package is a Family Plan (controls which template). */
  familyPlan: boolean;
  /** BOGO ("Buy One Get One") flag — swaps the recurring sentence to the
   *  3-step (today / month-2 free / month-3 recurring) schedule. */
  bogo: boolean;
  /** Month-3 (today + 2 months) date as MM-DD-YYYY. Empty string when
   *  bogo === false. Equal to the date the customer sees in the BOGO
   *  callout and the date persisted as `recurring_start_date`. */
  month3Str: string;
}

/**
 * Build the terms-of-service text customers agree to. Verbatim port of
 * legacy/signupworker.js (text strings are the legal copy and must not be
 * edited without legal review). Four branches:
 *
 *   - non-BOGO + family       : standard Family Plan recurring sentence
 *   - non-BOGO + standard     : standard recurring sentence
 *   - BOGO + family           : 3-step schedule + Family Plan per-vehicle clause
 *   - BOGO + standard         : 3-step schedule
 *
 * The "BOGO" branches swap the FIRST sentence (the recurring schedule
 * description). The rest of the body — cancellation, fleet exclusion,
 * Promotional Pricing + Presale Offer appendix — is identical across all
 * four branches (legal boilerplate stays put on BOGO too).
 *
 * Source: legacy/signup_worker_with_BOGO.js renderSignupForm (~line 2217-2223).
 */
export function buildTermsText(ctx: TermsContext): string {
  const priceTextToday = `$${ctx.todayPrice} plus tax`;
  const priceTextMonthly = ctx.familyPlan
    ? `$${ctx.monthlyPrice} + $0.01 per additional vehicle, plus tax`
    : `$${ctx.monthlyPrice} plus tax`;

  // ---- Family-plan body (verbatim from non-BOGO branch).
  const familyBodyAfterFirstSentence =
    ` Members use vehicle license plate and/or receive a barcode to identify their vehicle.` +
    ` Each vehicle enrolled in the Family Plan must have its own license plate and/or` +
    ` barcode on file. Unless otherwise specified this program cannot be combined with` +
    ` other offers or discounts. Retail unlimited programs exclude Limos, Taxis, Uber` +
    ` & Lyft vehicles. * I understand I will be charged monthly the agreed amount of` +
    ` the plan I selected plus any applicable tax every month until the agreement is` +
    ` terminated by either Splash or myself. Cancellations may be made at any time` +
    ` during the month to discontinue the membership, which will be effective the next` +
    ` month. However, notice of cancellation must be made at least five (5) days prior` +
    ` to the end of my billing date to avoid the next months charge to my credit card.` +
    ` Splash Car Wash will continue to charge me each month until I cancel. I may` +
    ` cancel either in person, via www.splashcarwashes.com and clicking "Manage My` +
    ` Membership", or by phone (203-324-8451). Upon cancellation, all vehicles enrolled` +
    ` under this Family Plan will be deactivated effective the next billing cycle. If` +
    ` I do use my membership, NO REFUNDS WILL BE MADE. Terms and conditions are` +
    ` subject to change, and I will be notified either on site, via email, or by text` +
    ` 30 days prior. I will make sure my email address and/or phone number are on file` +
    ` with Splash is up to date and accurate. *Livery, Taxis, Uber & Lyft vehicles` +
    ` shall be on commercial plans set up through our fleet program. If found not` +
    ` using authorized fleet program, Splash reserves the right to: 1) Terminate the` +
    ` unlimited membership and deactivate all vehicles enrolled under the Family Plan.` +
    ` 2) Retroactively charge the difference of retail washes and unlimited program` +
    ` effective date of initial misuse. 3) Suspend or deny any vehicle who has` +
    ` violated these terms. *Promotional Pricing – I understand my credit card will` +
    ` be charged the one time promotional price at sign up. After 30 Days, I` +
    ` acknowledge Splash Car Wash will continue to charge the card on file each month,` +
    ` at full price, until I cancel. I am aware that I can cancel my Unlimited Car` +
    ` Wash Membership at any time. *Presale Offer – I understand my credit card will` +
    ` be charged $0.01 at sign up. After 2 months, I acknowledge Splash Car Wash will` +
    ` continue to charge the card on file each month, at full price, until I cancel.` +
    ` I am aware that I can cancel my Unlimited Car Wash Membership at any time.`;

  // ---- Standard body (verbatim from non-BOGO branch).
  const standardBodyAfterFirstSentence =
    ` Members use vehicle license plate and/or receive a barcode to identify their` +
    ` vehicle. Unless otherwise specified this program cannot be combined with other` +
    ` offers or discounts. Retail unlimited programs exclude Limos, Taxis, Uber & Lyft` +
    ` vehicles. * I understand I will be charged monthly the agreed amount of the plan` +
    ` I selected plus any applicable tax every month until the agreement is terminated` +
    ` by either Splash or myself. Cancellations may be made at any time during the` +
    ` month to discontinue the membership, which will be effective the next month.` +
    ` However, notice of cancellation must be made at least five (5) days prior to the` +
    ` end of my billing date to avoid the next months charge to my credit card. Splash` +
    ` Car Wash will continue to charge me each month until I cancel. I may cancel either` +
    ` in person, via www.splashcarwashes.com and clicking "Manage My Membership", or by` +
    ` phone (203-324-8451). If I do use my membership, NO REFUNDS WILL BE MADE. Terms` +
    ` and conditions are subject to change, and I will be notified either on site, via` +
    ` email, or by text 30 days prior. I will make sure my email address and/or phone` +
    ` number are on file with Splash is up to date and accurate. *Livery, Taxis, Uber` +
    ` & Lyft vehicles shall be on commercial plans set up through our fleet program. If` +
    ` found not using authorized fleet program, Splash reserves the right to: 1)` +
    ` Terminate the unlimited membership. 2) Retroactively charge the difference of` +
    ` retail washes and unlimited program effective date of initial misuse. 3) Suspend` +
    ` or deny any vehicle who has violated these terms. *Promotional Pricing – I` +
    ` understand my credit card will be charged the one time promotional price at sign` +
    ` up. After 30 Days, I acknowledge Splash Car Wash will continue to charge the card` +
    ` on file each month, at full price, until I cancel. I am aware that I can cancel` +
    ` my Unlimited Car Wash Membership at any time. *Presale Offer – I understand my` +
    ` credit card will be charged $0.01 at sign up. After 2 months, I acknowledge Splash` +
    ` Car Wash will continue to charge the card on file each month, at full price, until` +
    ` I cancel. I am aware that I can cancel my Unlimited Car Wash Membership at any` +
    ` time.`;

  if (ctx.bogo && ctx.familyPlan) {
    const firstSentence =
      `This recurring program will charge ${priceTextToday} today (${ctx.todayStr}),` +
      ` your second month (${ctx.nextBillingStr}) is FREE, and then $${ctx.monthlyPrice}` +
      ` + $0.01 per additional vehicle (limit 4 total vehicles) plus tax beginning on` +
      ` ${ctx.month3Str} and every anniversary date of each month thereafter until` +
      ` paused or cancelled by the customer or Splash.`;
    return firstSentence + familyBodyAfterFirstSentence;
  }

  if (ctx.bogo) {
    const firstSentence =
      `This recurring program will charge ${priceTextToday} today (${ctx.todayStr}),` +
      ` your second month (${ctx.nextBillingStr}) is FREE, and then ${priceTextMonthly}` +
      ` beginning on ${ctx.month3Str} and every anniversary date of each month thereafter` +
      ` until paused or cancelled by the customer or Splash.`;
    return firstSentence + standardBodyAfterFirstSentence;
  }

  if (ctx.familyPlan) {
    const firstSentence =
      `This recurring program will charge ${priceTextToday} today (${ctx.todayStr})` +
      ` and $${ctx.monthlyPrice} + $0.01 per additional vehicle (limit 4 total vehicles)` +
      ` plus tax beginning on ${ctx.nextBillingStr} and every anniversary date of each` +
      ` month thereafter until paused or cancelled by the customer or Splash.`;
    return firstSentence + familyBodyAfterFirstSentence;
  }

  const firstSentence =
    `This recurring program will charge ${priceTextToday} today (${ctx.todayStr})` +
    ` and ${priceTextMonthly} beginning on ${ctx.nextBillingStr} and every anniversary` +
    ` date of each month thereafter until paused or cancelled by the customer or Splash.`;
  return firstSentence + standardBodyAfterFirstSentence;
}

/**
 * Format a Date as MM-DD-YYYY. Source: legacy/signupworker.js:3270 mmddyyyy.
 */
export function mmddyyyy(dt: Date): string {
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  const d = String(dt.getDate()).padStart(2, "0");
  const y = dt.getFullYear();
  return `${m}-${d}-${y}`;
}

/**
 * Format a Date as YYYY-MM-DD using LOCAL getFullYear/getMonth/getDate.
 *
 * Why not .toISOString(): the Date objects passed in represent ET wall-clock
 * (see render/form.ts / inline.ts), and `.toISOString()` converts to UTC.
 * For a late-evening ET submission the UTC day is +1, so the stored
 * `recurring_start_date` would not match the MM-DD-YYYY date the customer
 * signed in the terms. Building from local components keeps the stored ISO
 * date identical to the mmddyyyy date in the signed terms.
 *
 * Source: legacy/signup_worker_with_BOGO.js yyyymmdd.
 */
export function yyyymmdd(dt: Date): string {
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  const d = String(dt.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Add N months to a date, clamping the day to the last valid day of the
 * destination month. Source: legacy/signupworker.js:3294 addMonthsClamp.
 *
 * Example: addMonthsClamp(Jan 31, 1) → Feb 28 (or 29 in a leap year).
 */
export function addMonthsClamp(date: Date, months: number): Date {
  const d = new Date(date);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return d;
}
