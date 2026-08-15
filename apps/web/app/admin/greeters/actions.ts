// Server actions for /admin/greeters.
//
// Same shape as the performance tracker's actions (FormData -> JSON body ->
// performancePostJson -> redirect with ?action_error= or ?success=): the two
// pages talk to the same worker over the same transport, so they should fail
// the same way.
//
// Numerics are forwarded as strings. performance-worker re-coerces every field
// with toIntOrNull / toNumOrNull, so parsing here would just be a second place
// for the rules to drift.

"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { performancePostJson } from "../performance/_lib/worker-fetch";

const LIST_PATH = "/admin/greeters";

function strField(formData: FormData, name: string): string {
  const v = formData.get(name);
  return typeof v === "string" ? v.trim() : "";
}

function strOrNull(formData: FormData, name: string): string | null {
  const s = strField(formData, name);
  return s ? s : null;
}

/** The five typed-in metrics, identical for both day forms. */
function metricFields(formData: FormData): Record<string, unknown> {
  return {
    total_cars: strOrNull(formData, "total_cars"),
    wash_sales: strOrNull(formData, "wash_sales"),
    package_dollars: strOrNull(formData, "package_dollars"),
    extras_dollars: strOrNull(formData, "extras_dollars"),
    sign_ups: strOrNull(formData, "sign_ups"),
    comments: strOrNull(formData, "comments")
  };
}

function fail(message: string): never {
  redirect(`${LIST_PATH}?action_error=${encodeURIComponent(message)}`);
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

export async function submitGreeterDayAction(formData: FormData): Promise<void> {
  const businessDate = strField(formData, "business_date");
  if (!businessDate) fail("Pick a date before saving.");

  const locationId = strField(formData, "location_id");
  if (!locationId) fail("Pick a location before saving.");

  const greeterName = strField(formData, "greeter_name");
  if (!greeterName) fail("Pick or type a greeter before saving.");

  const pickedId = strField(formData, "beekeeper_user_id");

  const result = await performancePostJson("/pertrack/api/greeter/days", {
    business_date: businessDate,
    location_id: locationId,
    beekeeper_user_id: pickedId || manualGreeterId(greeterName),
    greeter_name: greeterName,
    ...metricFields(formData)
  });

  if (!result.ok) fail(result.error);

  revalidatePath(LIST_PATH);
  redirect(`${LIST_PATH}?success=day`);
}

export async function submitLocationDayAction(formData: FormData): Promise<void> {
  const businessDate = strField(formData, "business_date");
  if (!businessDate) fail("Pick a date before saving.");

  const locationId = strField(formData, "location_id");
  if (!locationId) fail("Pick a location before saving.");

  const result = await performancePostJson("/pertrack/api/greeter/location-days", {
    business_date: businessDate,
    location_id: locationId,
    ...metricFields(formData)
  });

  if (!result.ok) fail(result.error);

  revalidatePath(LIST_PATH);
  redirect(`${LIST_PATH}?success=location`);
}

/**
 * Add a goal window for a site.
 *
 * Goals are per location + date range, not per submission: the numbers a
 * submission is graded against are snapshotted from the window covering its
 * business date. Overlapping windows come back from the worker as a 409 with an
 * explanatory message, which lands in the action-error banner unchanged.
 */
export async function createGoalAction(formData: FormData): Promise<void> {
  const locationId = strField(formData, "location_id");
  if (!locationId) fail("Pick a location before saving the goal.");

  const effectiveFrom = strField(formData, "effective_from");
  if (!effectiveFrom) fail("A goal needs a start date.");

  const signUpGoal = strField(formData, "sign_up_goal");
  const extrasGoal = strField(formData, "extras_goal");
  if (!signUpGoal || !extrasGoal) {
    fail("Enter both a sign-up goal and an extras goal.");
  }

  const result = await performancePostJson("/pertrack/api/greeter/goals", {
    location_id: locationId,
    effective_from: effectiveFrom,
    effective_to: strOrNull(formData, "effective_to"),
    sign_up_goal: signUpGoal,
    extras_goal: extrasGoal,
    note: strOrNull(formData, "note")
  });

  if (!result.ok) fail(result.error);

  revalidatePath(LIST_PATH);
  redirect(`${LIST_PATH}?success=goal`);
}
