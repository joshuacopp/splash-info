// The one server action behind /admin/expenses/labor-rate.
//
// SEPARATE FROM ../actions.ts ON PURPOSE. Every action in that file rebuilds
// the expense log's URL from a hidden `return_qs` — month, location, category,
// search — because on that page the filters ARE the view. This page has no
// filters and one destination, so it carries none of that machinery and cannot
// accidentally send somebody back to a month they weren't looking at.
//
// LIKE EVERY ACTION IN THIS SECTION, IT DOES NOT CALL redirect(). A redirect()
// throw inside a server action costs ~20 seconds under OpenNext on Cloudflare
// Workers. It returns `{ redirectTo }` and <RedirectForm> pushes it. See
// app/admin/_components/RedirectForm.tsx for the measurements.
//
// SETTING A RATE IS INSERT-ONLY, AND THERE IS DELIBERATELY NO EDIT OR DELETE
// ACTION HERE. Entries stamp `labor_rate` at insert time, so a rate row is the
// evidence for every dollar figure priced under it — editing one would restate
// history that a CHECK constraint says agrees. A rate is superseded by a newer
// row with a later effective date, never replaced.
//
// THE AUTHORISATION IS THE WORKER'S. apiCreateLaborRate 403s anyone who isn't a
// super admin. The page also checks, so that the form isn't offered to someone
// who can't use it, but that check is courtesy and this action does not repeat
// it — a second copy of the rule is a second thing to get out of step with the
// one that is actually enforced.

"use server";

import { revalidatePath } from "next/cache";
import { performancePostJson } from "../../performance/_lib/worker-fetch";
import type { RedirectResult } from "../../_components/RedirectForm";

const PATH = "/admin/expenses/labor-rate";

/** The expense log itself. Revalidated alongside this page because the entry
 *  form prices its hours preview from the rate history, and a new rate that
 *  doesn't show up there until a hard refresh looks like the save failed. */
const EXPENSE_PATH = "/admin/expenses";

function strField(formData: FormData, name: string): string {
  const v = formData.get(name);
  return typeof v === "string" ? v.trim() : "";
}

function fail(message: string): RedirectResult {
  return { redirectTo: `${PATH}?action_error=${encodeURIComponent(message)}` };
}

/**
 * Set the company-wide hourly rate, effective from a date.
 *
 * NO MECHANIC FIELD. The column exists and the database resolves per-mechanic
 * rates already (Josh, 2026-08-21: "may set by mechanic and have a rate for
 * each mechanic — may be worth building the table to account for that even if
 * it's not currently utilized"), but nothing collects a mechanic yet, so this
 * writes the company-wide row every time. Adding the field later is a field and
 * a pass-through, not a migration.
 *
 * BACKDATING IS ALLOWED AND DOES NOT REPRICE ANYTHING. Setting a rate effective
 * from last month changes what NEW entries dated last month cost, and leaves
 * every entry already logged exactly as it was priced. That is the point of
 * stamping the rate on the row. The copy on the page says so, because "I fixed
 * the rate, why didn't the totals move" is the obvious wrong expectation.
 */
export async function setLaborRateAction(
  formData: FormData
): Promise<RedirectResult> {
  const effectiveFrom = strField(formData, "effective_from");
  if (!effectiveFrom) {
    return fail(
      "Pick the date the rate starts applying. It is the purchase date on an entry that decides which rate prices it, not the date you set it here."
    );
  }
  // Shape only. <input type="date"> submits YYYY-MM-DD, and the worker checks
  // it again; this catches a hand-built POST before a ten-second round trip
  // spends itself on a message the user could have had instantly.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) {
    return fail("The effective date must be a calendar date (YYYY-MM-DD).");
  }

  const rateRaw = strField(formData, "rate_per_hour");
  if (!rateRaw) {
    return fail("Enter the hourly rate.");
  }
  // Parsed HERE and nowhere else in this section, which is the opposite of the
  // rule in ../actions.ts (numerics forwarded as strings). The difference is
  // that `amount` there is signed and a refund is legitimately negative, so
  // there is nothing to check locally; a rate is CHECKed strictly positive in
  // the database and zero or minus is a typo worth catching in front of the
  // user. The value still goes over the wire as the string they typed — Number
  // is used to test it, not to rewrite it.
  const rate = Number(rateRaw);
  if (!Number.isFinite(rate) || rate <= 0) {
    return fail(
      "The hourly rate must be a number greater than zero. Zero is not a rate — an entry priced at it would record hours worked and no cost."
    );
  }

  const result = await performancePostJson(
    "/pertrack/api/expenses/labor-rates",
    {
      effective_from: effectiveFrom,
      rate_per_hour: rateRaw,
      note: strField(formData, "note") || null,
      // Always null in v1. Sent explicitly rather than omitted so the field is
      // visible at the call site the day a mechanic picker is added.
      mechanic_key: null
    }
  );

  // Passed through as-is. The worker's messages here are specific and better
  // than anything this layer could paraphrase — a duplicate effective date
  // comes back as a 409 explaining that rates are superseded rather than
  // edited, which is the actual thing the user needs to know.
  if (!result.ok) return fail(result.error);

  revalidatePath(PATH);
  revalidatePath(EXPENSE_PATH);
  return { redirectTo: `${PATH}?success=rate` };
}
