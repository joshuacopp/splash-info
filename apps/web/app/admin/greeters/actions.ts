// Server actions for /admin/greeters.
//
// Same shape as the performance tracker's actions (FormData -> JSON body ->
// performancePostJson -> a URL with ?action_error= or ?success=): the two pages
// talk to the same worker over the same transport, so they should fail the same
// way.
//
// NOTHING HERE CALLS redirect(), AND NOTHING HERE MAY. Every action returns
// `{ redirectTo }` and <RedirectForm> pushes it from the client. A redirect()
// throw inside a server action costs ~20 seconds under OpenNext on Cloudflare
// Workers, with the row already committed the whole time; returning a value
// answers immediately. Same URLs as before, so the banners are unchanged. See
// app/admin/_components/RedirectForm.tsx for the measurements.
//
// Numerics are forwarded as strings. performance-worker re-coerces every field
// with toIntOrNull / toNumOrNull, so parsing here would just be a second place
// for the rules to drift.

"use server";

import { revalidatePath } from "next/cache";
import { performancePostJson } from "../performance/_lib/worker-fetch";
import type { RedirectResult } from "../_components/RedirectForm";

const LIST_PATH = "/admin/greeters";

function strField(formData: FormData, name: string): string {
  const v = formData.get(name);
  return typeof v === "string" ? v.trim() : "";
}

function strOrNull(formData: FormData, name: string): string | null {
  const s = strField(formData, name);
  return s ? s : null;
}

/**
 * The metrics both day forms collect.
 *
 * The two forms diverge beyond this — the site's day adds total_cars,
 * cancellations, total_members, house_accounts and churn_pct (facts a single
 * greeter can't own), and the greeter's day adds a shift window (a fact a site
 * doesn't have) — so each action spreads this and then names its own extras.
 *
 * `reactivations` is shared as a FIELD but not as a metric: the site's copy
 * feeds net_members, the greeter's copy is informational only. That asymmetry
 * lives downstream (in the SQL), not here — both forms just post the box.
 * `google_reviews` is shared the same way, and is informational on BOTH sides.
 */
function sharedMetricFields(formData: FormData): Record<string, unknown> {
  return {
    wash_sales: strOrNull(formData, "wash_sales"),
    rewashes: strOrNull(formData, "rewashes"),
    package_dollars: strOrNull(formData, "package_dollars"),
    extras_dollars: strOrNull(formData, "extras_dollars"),
    sign_ups: strOrNull(formData, "sign_ups"),
    reactivations: strOrNull(formData, "reactivations"),
    google_reviews: strOrNull(formData, "google_reviews"),
    comments: strOrNull(formData, "comments")
  };
}

/**
 * RETURNS, IT DOES NOT THROW — so every call site needs its own `return`.
 *
 * This used to be typed `never` and call redirect(), which meant `if (!x)
 * fail(...)` terminated the action on its own. It doesn't any more, so a
 * `fail()` without a `return` in front of it falls through and posts the
 * invalid body to the worker.
 */
function fail(message: string): RedirectResult {
  return {
    redirectTo: `${LIST_PATH}?action_error=${encodeURIComponent(message)}`
  };
}

/**
 * Identity key for a greeter typed in by hand, at a site with no Beekeeper
 * schedule mapped.
 *
 * Must be deterministic: (location, beekeeper_user_id, date) is the uniqueness
 * key, so a random id would turn every correction into a duplicate row instead
 * of an update. The `manual:` prefix keeps these from ever colliding with a
 * real Beekeeper uuid, and makes them greppable if a site is onboarded later
 * and the rows need reconciling.
 */
function manualGreeterId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `manual:${slug || "unnamed"}`;
}

export async function submitGreeterDayAction(
  formData: FormData
): Promise<RedirectResult> {
  const businessDate = strField(formData, "business_date");
  if (!businessDate) return fail("Pick a date before saving.");

  const locationId = strField(formData, "location_id");
  if (!locationId) return fail("Pick a location before saving.");

  const greeterName = strField(formData, "greeter_name");
  if (!greeterName) return fail("Pick or type a greeter before saving.");

  const pickedId = strField(formData, "beekeeper_user_id");

  // Caught here so the user gets the message without a round trip; the worker
  // and a DB check constraint both re-enforce it.
  const shiftStart = strOrNull(formData, "shift_start");
  const shiftEnd = strOrNull(formData, "shift_end");
  if ((shiftStart === null) !== (shiftEnd === null)) {
    return fail(
      "Enter both a shift start and a shift end, or leave both blank."
    );
  }

  const result = await performancePostJson("/pertrack/api/greeter/days", {
    business_date: businessDate,
    location_id: locationId,
    beekeeper_user_id: pickedId || manualGreeterId(greeterName),
    greeter_name: greeterName,
    shift_start: shiftStart,
    shift_end: shiftEnd,
    ...sharedMetricFields(formData)
  });

  if (!result.ok) return fail(result.error);

  revalidatePath(LIST_PATH);
  return { redirectTo: `${LIST_PATH}?success=day` };
}

export async function submitLocationDayAction(
  formData: FormData
): Promise<RedirectResult> {
  const businessDate = strField(formData, "business_date");
  if (!businessDate) return fail("Pick a date before saving.");

  const locationId = strField(formData, "location_id");
  if (!locationId) return fail("Pick a location before saving.");

  const result = await performancePostJson("/pertrack/api/greeter/location-days", {
    business_date: businessDate,
    location_id: locationId,
    total_cars: strOrNull(formData, "total_cars"),
    cancellations: strOrNull(formData, "cancellations"),
    total_members: strOrNull(formData, "total_members"),
    // Site only, and NOT in sharedMetricFields even though its partner
    // `rewashes` is: nobody hands a greeter a house account to log under their
    // own name. Both are deducted from the scan-rate denominator downstream.
    house_accounts: strOrNull(formData, "house_accounts"),
    // Site only — a greeter has no member base to churn. The worker range-checks
    // it and returns a readable 400, so nothing is validated here.
    churn_pct: strOrNull(formData, "churn_pct"),
    ...sharedMetricFields(formData)
  });

  if (!result.ok) return fail(result.error);

  revalidatePath(LIST_PATH);
  return { redirectTo: `${LIST_PATH}?success=location` };
}

/**
 * How many already-submitted days a goal change re-graded, pulled out of the
 * worker's response so the success banner can say so.
 *
 * Goals are snapshotted onto each submission at submit time, so adding or
 * deleting a window that is even partly in the past silently changes how days
 * already entered are graded. Reporting the count is what turns that from a
 * surprise into a confirmation — and a zero is just as informative, because it
 * is what a goal set entirely in the future should produce.
 *
 * DEFENSIVE TO THE POINT OF PARANOIA about the body's shape, because
 * performancePostJson types it as `unknown` and a missing count must degrade to
 * "no re-grading mentioned" rather than to "NaN days re-graded".
 */
function restampCounts(body: unknown): { greeter: number; location: number } {
  const r =
    body && typeof body === "object" && "restamped" in body
      ? (body as { restamped?: unknown }).restamped
      : null;
  if (!r || typeof r !== "object") return { greeter: 0, location: 0 };
  const g = (r as { greeter_rows?: unknown }).greeter_rows;
  const l = (r as { location_rows?: unknown }).location_rows;
  return {
    greeter: typeof g === "number" && Number.isFinite(g) ? g : 0,
    location: typeof l === "number" && Number.isFinite(l) ? l : 0
  };
}

/**
 * The two counts as query params, omitted entirely when both are zero.
 *
 * Omitted rather than sent as zeros so the page can tell "nothing needed
 * re-grading" apart from "this redirect predates the feature" without either
 * one having to be a magic value.
 */
function restampQs(body: unknown): string {
  const { greeter, location } = restampCounts(body);
  if (greeter === 0 && location === 0) return "";
  return `&rg=${greeter}&rl=${location}`;
}

/**
 * Add a goal window for a site.
 *
 * Goals are per location + date range, not per submission: the numbers a
 * submission is graded against are snapshotted from the window covering its
 * business date.
 *
 * OVERLAPPING WINDOWS ARE FINE AND ARE THE POINT — a promo week laid over a
 * standing monthly baseline, with the shorter window winning for its days. Only
 * an exact duplicate window comes back as a 409, and its message (which lands
 * in the action-error banner unchanged) points at the delete button.
 *
 * Nothing here validates the date ORDER. `effective_to` before `effective_from`
 * is caught by the worker and again by greeter_goals_window_valid, and a third
 * copy of the rule in this file is a third place for it to drift.
 */
export async function createGoalAction(
  formData: FormData
): Promise<RedirectResult> {
  const locationId = strField(formData, "location_id");
  if (!locationId) return fail("Pick a location before saving the goal.");

  const effectiveFrom = strField(formData, "effective_from");
  if (!effectiveFrom) return fail("A goal needs a start date.");

  const captureGoal = strField(formData, "capture_goal_pct");
  const dobGoal = strField(formData, "dob_goal");
  if (!captureGoal || !dobGoal) {
    return fail("Enter both a capture % goal and a D.O.B. goal.");
  }

  const result = await performancePostJson("/pertrack/api/greeter/goals", {
    location_id: locationId,
    effective_from: effectiveFrom,
    effective_to: strOrNull(formData, "effective_to"),
    capture_goal_pct: captureGoal,
    dob_goal: dobGoal,
    // Optional: not every site sets a membership target.
    member_goal_month_end: strOrNull(formData, "member_goal_month_end"),
    note: strOrNull(formData, "note")
  });

  if (!result.ok) return fail(result.error);

  revalidatePath(LIST_PATH);
  return { redirectTo: `${LIST_PATH}?success=goal${restampQs(result.body)}` };
}

/**
 * Remove a goal window, and re-grade whatever it was grading.
 *
 * NO CONFIRMATION STEP HERE. The button that posts this is wrapped in one on
 * the page; an action can't prompt, and adding a second "are you sure" round
 * trip on the server would cost ~20 seconds under OpenNext for a question the
 * client already asked.
 *
 * A goal is deleted, never edited — there is no updateGoalAction and there
 * should not be one. Editing a window in place would have to re-stamp under
 * both the old and the new shape, and the delete already does exactly half of
 * that correctly.
 */
export async function deleteGoalAction(
  formData: FormData
): Promise<RedirectResult> {
  const id = strField(formData, "goal_id");
  if (!id) return fail("That goal could not be identified. Reload the page.");

  const result = await performancePostJson(
    "/pertrack/api/greeter/goals/delete",
    { id }
  );

  if (!result.ok) return fail(result.error);

  revalidatePath(LIST_PATH);
  return {
    redirectTo: `${LIST_PATH}?success=goal_deleted${restampQs(result.body)}`
  };
}
