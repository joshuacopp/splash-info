// Server actions for /admin/damage/vehicles (Vehicle Guide).
//
// Same transport and same rules as ../car-counts/actions.ts: FormData ->
// damagePostForm -> `{ redirectTo }` for <RedirectForm>. NOTHING HERE CALLS
// redirect() (it costs ~20s under OpenNext; see RedirectForm.tsx).
//
// The worker owns validation and the RM-and-above gate; its error sentences
// land in the banner verbatim, so none of those rules are repeated here.
//
// Media uploads do NOT go through here: the browser posts them straight to the
// worker (see _components/MediaUploader.tsx) so a 50 MB video never passes
// through the apps/web Worker.

"use server";

import { revalidatePath } from "next/cache";
import { damagePostForm } from "../_lib/worker-fetch";
import type { RedirectResult } from "../../_components/RedirectForm";

const LIST_PATH = "/admin/damage/vehicles";

function strField(formData: FormData, name: string): string {
  const v = formData.get(name);
  return typeof v === "string" ? v : "";
}

/** Returns, does not throw: every call site needs its own `return`. */
function fail(message: string, editId?: string): RedirectResult {
  const edit = editId ? `&edit=${encodeURIComponent(editId)}` : "";
  return { redirectTo: `${LIST_PATH}?action_error=${encodeURIComponent(message)}${edit}` };
}

function bodyFrom(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

/** Create (no id) or update (id) one entry. */
export async function saveVehicleIssueAction(formData: FormData): Promise<RedirectResult> {
  const id = strField(formData, "id").trim();
  const body: Record<string, string> = {
    make: strField(formData, "make"),
    model: strField(formData, "model"),
    year_from: strField(formData, "year_from"),
    year_to: strField(formData, "year_to"),
    issue_type: strField(formData, "issue_type"),
    issue: strField(formData, "issue"),
    solution: strField(formData, "solution")
  };
  if (id) body.id = id;

  const result = await damagePostForm("/manage/api/vehicle-issues", bodyFrom(body));
  if (!result.ok) return fail(result.error, id || undefined);

  revalidatePath(LIST_PATH);
  // A new entry lands in edit mode so photos and videos can be added straight
  // away -- they can only attach to an entry that already exists.
  const newId =
    !id && result.body && typeof result.body === "object" && "id" in result.body
      ? String((result.body as { id: unknown }).id)
      : "";
  if (newId) {
    return { redirectTo: `${LIST_PATH}?success=created&edit=${encodeURIComponent(newId)}#media` };
  }
  return { redirectTo: `${LIST_PATH}?success=saved` };
}

export async function deleteVehicleIssueAction(formData: FormData): Promise<RedirectResult> {
  const id = strField(formData, "id").trim();
  if (!id) return fail("That entry could not be identified. Reload the page.");
  const result = await damagePostForm("/manage/api/vehicle-issues/delete", bodyFrom({ id }));
  if (!result.ok) return fail(result.error);
  revalidatePath(LIST_PATH);
  return { redirectTo: `${LIST_PATH}?success=deleted` };
}

export async function deleteVehicleMediaAction(formData: FormData): Promise<RedirectResult> {
  const mediaId = strField(formData, "media_id").trim();
  const issueId = strField(formData, "issue_id").trim();
  if (!mediaId) return fail("That file could not be identified. Reload the page.", issueId);
  const result = await damagePostForm(
    `/manage/api/vehicle-issues/media/${encodeURIComponent(mediaId)}/delete`,
    new FormData()
  );
  if (!result.ok) return fail(result.error, issueId);
  revalidatePath(LIST_PATH);
  return {
    redirectTo: `${LIST_PATH}?success=media_deleted&edit=${encodeURIComponent(issueId)}#media`
  };
}
