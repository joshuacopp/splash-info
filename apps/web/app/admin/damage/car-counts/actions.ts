// Server actions for /admin/damage/car-counts.
//
// Same shape as the greeters/performance actions (FormData -> damage-worker
// POST -> a URL with ?action_error= or ?success=): they all talk to a worker
// over the same transport, so they should fail the same way.
//
// NOTHING HERE CALLS redirect(), AND NOTHING HERE MAY. Every action returns
// `{ redirectTo }` and <RedirectForm> pushes it from the client. A redirect()
// throw inside a server action costs ~20 seconds under OpenNext on Cloudflare
// Workers, with the row already committed the whole time; returning a value
// answers immediately. See app/admin/_components/RedirectForm.tsx.
//
// The worker validates location scope, date shape (YYYY-MM-DD), end>=start,
// cars integer>=0, and rejects overlapping ranges with HTTP 409. All of those
// land in damagePostForm's { ok:false, error } branch as a plain sentence and
// are surfaced verbatim in the action-error banner — no second copy of the
// rules here to drift out of step with the worker.

"use server";

import { revalidatePath } from "next/cache";
import { damagePostForm } from "../_lib/worker-fetch";
import type { RedirectResult } from "../../_components/RedirectForm";

const LIST_PATH = "/admin/damage/car-counts";
const REPORT_PATH = "/admin/damage/reporting";

function strField(formData: FormData, name: string): string {
  const v = formData.get(name);
  return typeof v === "string" ? v.trim() : "";
}

/**
 * RETURNS, IT DOES NOT THROW — so every call site needs its own `return`.
 * Mirrors the greeters actions' fail(): a `fail()` without a `return` in
 * front of it falls through and posts the invalid body to the worker.
 */
function fail(message: string): RedirectResult {
  const sep = LIST_PATH.includes("?") ? "&" : "?";
  return {
    redirectTo: `${LIST_PATH}${sep}action_error=${encodeURIComponent(message)}`
  };
}

/** Build the form body damagePostForm expects from a set of named fields. */
function bodyFrom(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

/**
 * Create or update one car-count range for a location.
 *
 * NO DATE / OVERLAP / CARS VALIDATION HERE, AND THAT IS DELIBERATE. The worker
 * owns those rules (dates YYYY-MM-DD, end>=start, cars integer>=0, no
 * overlapping ranges -> 409) and returns a sentence that lands in the banner
 * unchanged. A second copy here would be a second place for them to drift.
 * The only thing checked up front is location, because the worker can't
 * produce a friendlier message for an empty select than "pick a location".
 */
export async function setCarCountAction(
  formData: FormData
): Promise<RedirectResult> {
  const locationCode = strField(formData, "location_code");
  if (!locationCode) {
    return fail("Pick a location before saving the car count.");
  }

  const startDate = strField(formData, "start_date");
  if (!startDate) return fail("Pick a start date before saving.");

  const endDate = strField(formData, "end_date");
  if (!endDate) return fail("Pick an end date before saving.");

  const cars = strField(formData, "cars");
  if (!cars) return fail("Enter a car count before saving.");

  const id = strField(formData, "id");

  const body: Record<string, string> = {
    location_code: locationCode,
    start_date: startDate,
    end_date: endDate,
    cars,
    note: strField(formData, "note")
  };
  // Only send `id` when editing — the worker treats a present id as an update.
  if (id) body.id = id;

  const result = await damagePostForm(
    "/manage/api/car-counts",
    bodyFrom(body)
  );

  if (!result.ok) return fail(result.error);

  // The cost-per-car panel on the reporting page reads these rows, so it is
  // exactly as stale as this list is.
  revalidatePath(LIST_PATH);
  revalidatePath(REPORT_PATH);

  const sep = LIST_PATH.includes("?") ? "&" : "?";
  return { redirectTo: `${LIST_PATH}${sep}success=car_count` };
}

/**
 * Delete one car-count range.
 *
 * NO CONFIRMATION STEP HERE; the button that posts this asks on the client.
 */
export async function deleteCarCountAction(
  formData: FormData
): Promise<RedirectResult> {
  const id = strField(formData, "id");
  if (!id) {
    return fail("That car count could not be identified. Reload the page.");
  }

  const result = await damagePostForm(
    "/manage/api/car-counts/delete",
    bodyFrom({ id })
  );

  if (!result.ok) return fail(result.error);

  revalidatePath(LIST_PATH);
  revalidatePath(REPORT_PATH);

  const sep = LIST_PATH.includes("?") ? "&" : "?";
  return { redirectTo: `${LIST_PATH}${sep}success=car_count_deleted` };
}
