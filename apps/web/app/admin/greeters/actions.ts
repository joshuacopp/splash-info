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
const REPORT_PATH = "/admin/greeters/report";

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
function fail(message: string, back: string = LIST_PATH): RedirectResult {
  const sep = back.includes("?") ? "&" : "?";
  return {
    redirectTo: `${back}${sep}action_error=${encodeURIComponent(message)}`
  };
}

/**
 * The two screens a correction may return to, matched on the path alone.
 *
 * ALLOW-LISTED RATHER THAN ECHOED. `return_to` arrives in a form body, and a
 * form body is whatever the poster says it is — reflecting one straight into a
 * redirect is an open redirect. Anything unrecognised falls back to the list
 * page rather than failing, because the correction itself already succeeded and
 * refusing to redirect would strand the user on a blank action response.
 *
 * The query string is preserved because it IS the report page's state: window,
 * preset, manager filters and both drill-through selections all live there, and
 * dropping it would answer "void this day" by closing the report.
 */
const RETURN_PATHS = ["/admin/greeters", "/admin/greeters/report"];

function returnPath(formData: FormData): string {
  const raw = strField(formData, "return_to");
  // "//evil.example" starts with "/" and is still an absolute URL, so the
  // leading-slash test alone is not enough.
  if (!raw.startsWith("/") || raw.startsWith("//")) return LIST_PATH;
  const path = raw.split("?")[0] ?? "";
  return RETURN_PATHS.includes(path) ? raw : LIST_PATH;
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
  // The screen this was posted from, filters and all. It matters most on an
  // EDIT: the row being fixed was found by narrowing the Daily submissions
  // table to a date range and a site, and returning to the bare list page threw
  // that away — so saving a correction scrolled the user away from the row they
  // just corrected, while Cancel (which already carried the query string) kept
  // their place. Absent on a form that doesn't send it, and absent means the
  // plain list page.
  const back = returnPath(formData);

  const businessDate = strField(formData, "business_date");
  if (!businessDate) return fail("Pick a date before saving.", back);

  const locationId = strField(formData, "location_id");
  if (!locationId) return fail("Pick a location before saving.", back);

  const greeterName = strField(formData, "greeter_name");
  if (!greeterName) return fail("Pick or type a greeter before saving.", back);

  const pickedId = strField(formData, "beekeeper_user_id");

  // Caught here so the user gets the message without a round trip; the worker
  // and a DB check constraint both re-enforce it.
  const shiftStart = strOrNull(formData, "shift_start");
  const shiftEnd = strOrNull(formData, "shift_end");
  if ((shiftStart === null) !== (shiftEnd === null)) {
    return fail(
      "Enter both a shift start and a shift end, or leave both blank.",
      back
    );
  }

  // EDIT MODE IS THIS SAME POST WITH AN id. The worker branches on nothing else,
  // so the field list, the coercions and the goal snapshot cannot drift between
  // adding a day and fixing one. Absent on a new day, and absent means insert.
  const editId = strOrNull(formData, "id");

  const result = await performancePostJson("/pertrack/api/greeter/days", {
    id: editId,
    business_date: businessDate,
    location_id: locationId,
    beekeeper_user_id: pickedId || manualGreeterId(greeterName),
    greeter_name: greeterName,
    shift_start: shiftStart,
    shift_end: shiftEnd,
    ...sharedMetricFields(formData)
  });

  if (!result.ok) return fail(result.error, back);

  // Both screens. The report reads the same day rows this just wrote, so
  // revalidating only the list page left a stale report behind whenever a
  // correction was made — the same asymmetry the void actions used to have.
  revalidatePath(LIST_PATH);
  revalidatePath(REPORT_PATH);

  const sep = back.includes("?") ? "&" : "?";
  return {
    redirectTo: `${back}${sep}success=${editId ? "day_edited" : "day"}`
  };
}

export async function submitLocationDayAction(
  formData: FormData
): Promise<RedirectResult> {
  /** See submitGreeterDayAction — same reason, same fallback. */
  const back = returnPath(formData);

  const businessDate = strField(formData, "business_date");
  if (!businessDate) return fail("Pick a date before saving.", back);

  const locationId = strField(formData, "location_id");
  if (!locationId) return fail("Pick a location before saving.", back);

  /** See submitGreeterDayAction — an edit is this post with an id on it. */
  const editId = strOrNull(formData, "id");

  const result = await performancePostJson("/pertrack/api/greeter/location-days", {
    id: editId,
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

  if (!result.ok) return fail(result.error, back);

  revalidatePath(LIST_PATH);
  revalidatePath(REPORT_PATH);

  const sep = back.includes("?") ? "&" : "?";
  return {
    redirectTo: `${back}${sep}success=${editId ? "location_edited" : "location"}`
  };
}

/* ============================================================
 * Corrections — strike a day out, or put it back
 * ============================================================
 *
 * A day is NEVER deleted. "Submitted and then withdrawn" and "never submitted"
 * are different facts, and the missing-submissions panel exists to report the
 * second one — a hard delete would quietly move a day from the first category
 * into the second and make the site look like it never reported.
 *
 * VOIDING A DAY MAKES IT MISSING AGAIN, and that is intended rather than a side
 * effect: greeter_missing_days() reads the _live view, so a struck-out day
 * re-appears on the watchlist as a gap somebody still has to fill.
 *
 * Neither of these confirms anything server-side. The buttons that post them are
 * wrapped in a client confirm on the page; a second server round trip to ask
 * costs ~20 seconds under OpenNext for a question already answered.
 */

/** Shared by all four: same transport, same failure shape, different endpoint. */
async function correctDay(
  formData: FormData,
  endpoint: string,
  successKey: string
): Promise<RedirectResult> {
  // Where the button was pressed. The list page's four buttons send nothing and
  // get the old behaviour; the report's two send their own URL.
  const back = returnPath(formData);

  const id = strField(formData, "id");
  if (!id) {
    return fail("That day could not be identified. Reload the page.", back);
  }

  const result = await performancePostJson(endpoint, { id });
  if (!result.ok) return fail(result.error, back);

  // Both screens, always. The list page is where the row is managed and the
  // report is where it was struck out from; whichever one the user isn't
  // looking at right now is the one they'd otherwise find stale.
  revalidatePath(LIST_PATH);
  revalidatePath(REPORT_PATH);

  const sep = back.includes("?") ? "&" : "?";
  return { redirectTo: `${back}${sep}success=${successKey}` };
}

export async function voidDayAction(
  formData: FormData
): Promise<RedirectResult> {
  return correctDay(formData, "/pertrack/api/greeter/days/void", "day_voided");
}

export async function restoreDayAction(
  formData: FormData
): Promise<RedirectResult> {
  return correctDay(
    formData,
    "/pertrack/api/greeter/days/restore",
    "day_restored"
  );
}

export async function voidLocationDayAction(
  formData: FormData
): Promise<RedirectResult> {
  return correctDay(
    formData,
    "/pertrack/api/greeter/location-days/void",
    "location_voided"
  );
}

export async function restoreLocationDayAction(
  formData: FormData
): Promise<RedirectResult> {
  return correctDay(
    formData,
    "/pertrack/api/greeter/location-days/restore",
    "location_restored"
  );
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
  /** See submitGreeterDayAction — the goal form sits on the filtered list too. */
  const back = returnPath(formData);

  const locationId = strField(formData, "location_id");
  if (!locationId) return fail("Pick a location before saving the goal.", back);

  const effectiveFrom = strField(formData, "effective_from");
  if (!effectiveFrom) return fail("A goal needs a start date.", back);

  const captureGoal = strField(formData, "capture_goal_pct");
  const dobGoal = strField(formData, "dob_goal");
  if (!captureGoal || !dobGoal) {
    return fail("Enter both a capture % goal and a D.O.B. goal.", back);
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

  if (!result.ok) return fail(result.error, back);

  // A goal window re-stamps days that are already entered, so the report is as
  // stale after this as the list is.
  revalidatePath(LIST_PATH);
  revalidatePath(REPORT_PATH);

  const sep = back.includes("?") ? "&" : "?";
  return {
    redirectTo: `${back}${sep}success=goal${restampQs(result.body)}`
  };
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
  /** See submitGreeterDayAction. */
  const back = returnPath(formData);

  const id = strField(formData, "goal_id");
  if (!id) {
    return fail("That goal could not be identified. Reload the page.", back);
  }

  const result = await performancePostJson(
    "/pertrack/api/greeter/goals/delete",
    { id }
  );

  if (!result.ok) return fail(result.error, back);

  revalidatePath(LIST_PATH);
  revalidatePath(REPORT_PATH);

  const sep = back.includes("?") ? "&" : "?";
  return {
    redirectTo: `${back}${sep}success=goal_deleted${restampQs(result.body)}`
  };
}
