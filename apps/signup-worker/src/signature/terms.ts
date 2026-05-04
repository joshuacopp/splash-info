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
  /** Next billing date as MM-DD-YYYY. */
  nextBillingStr: string;
  /** Whether the package is a Family Plan (controls which template). */
  familyPlan: boolean;
}

/**
 * Build the terms-of-service text customers agree to. Verbatim port of
 * legacy/signupworker.js:2271-2273 (text strings are the legal copy and
 * must not be edited without legal review).
 */
export function buildTermsText(ctx: TermsContext): string {
  const priceTextToday = `$${ctx.todayPrice} plus tax`;
  const priceTextMonthly = ctx.familyPlan
    ? `$${ctx.monthlyPrice} + $0.01 per additional vehicle, plus tax`
    : `$${ctx.monthlyPrice} plus tax`;

  if (ctx.familyPlan) {
    return (
      `This recurring program will charge ${priceTextToday} today (${ctx.todayStr})` +
      ` and $${ctx.monthlyPrice} + $0.01 per additional vehicle (limit 4 total vehicles)` +
      ` plus tax beginning on ${ctx.nextBillingStr} and every anniversary date of each` +
      ` month thereafter until paused or cancelled by the customer or Splash. Members` +
      ` use vehicle license plate and/or receive a barcode to identify their vehicle.` +
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
      ` I am aware that I can cancel my Unlimited Car Wash Membership at any time.`
    );
  }

  return (
    `This recurring program will charge ${priceTextToday} today (${ctx.todayStr})` +
    ` and ${priceTextMonthly} beginning on ${ctx.nextBillingStr} and every anniversary` +
    ` date of each month thereafter until paused or cancelled by the customer or Splash.` +
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
    ` time.`
  );
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
