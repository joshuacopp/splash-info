// Server actions for /admin/damage/[id]. Briefs 5c + 5d.
//
// Five write surfaces:
//   - transitionAction:     POST /manage/api/claim/{id}/transition         (5c)
//   - addNoteAction:        POST /manage/api/claim/{id}/note               (5c)
//   - uploadDocumentAction: POST /manage/api/claim/{id}/document           (5d)
//   - editDocumentAction:   POST /manage/api/claim/{id}/document/{docId}/edit   (5d)
//   - deleteDocumentAction: POST /manage/api/claim/{id}/document/{docId}/delete (5d)
//
// All five follow the same shape:
//   1. Pull `claim_id` (hidden field) from the FormData; bail to the list
//      page on a missing id (defensive — every <form> on the detail page
//      includes the hidden field).
//   2. Forward the FormData (filtered/verbatim per action) to damagePostForm
//      or damagePostMultipart depending on whether the body carries a file.
//      The worker reads named fields (to_status, note, doc_type, vendor,
//      amount, etc.) directly off the body, so we don't rename.
//   3. On worker error: redirect back to the detail page with
//      `?action_error=...` so the page renders an inline alert.
//   4. On success: revalidatePath the detail page (so the new status,
//      activity row, photos, and any new approval-detail fields show on
//      next render), then redirect to the bare detail URL — strips any
//      prior ?action_error from the browser URL.
//
// Server actions in Next 15 surface the redirect via a thrown
// NEXT_REDIRECT; the framework catches and returns a navigation response
// to the form submitter. All five branches end in redirect() so the
// browser URL is always under our control after the action runs.

"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { damagePostForm, damagePostMultipart, type DamagePostResult } from "../_lib/worker-fetch";

function detailPath(claimId: string): string {
  return `/admin/damage/${encodeURIComponent(claimId)}`;
}

function errorRedirect(claimId: string, message: string): never {
  redirect(`${detailPath(claimId)}?action_error=${encodeURIComponent(message)}`);
}

/**
 * Brief 18 diagnostic — log action entry (sanitized field names + a few
 * specific values; passwords/tokens are never read here so this is safe)
 * and worker response status + first 200 chars of any non-2xx body. The
 * goal is to make damage-action failures visible in the splash-web Worker
 * logs so the operator can see what's happening on each click without
 * hunting the damage-worker logs. Remove these in a follow-up brief once
 * the action chain is verified working.
 */
function logActionEntry(action: string, claimId: string, formData: FormData): void {
  const fields: Record<string, string> = {};
  for (const [k, v] of formData.entries()) {
    if (typeof v === "string") {
      fields[k] = v.length > 80 ? `${v.slice(0, 80)}…(${v.length})` : v;
    } else {
      fields[k] = `<File ${v.name ?? "?"} ${v.size ?? 0}B>`;
    }
  }
  console.log(
    `[damage-action] ${action} claim=${claimId} fields=${JSON.stringify(fields)}`
  );
}

function logActionResult(
  action: string,
  claimId: string,
  result: DamagePostResult
): void {
  if (result.ok) {
    const preview =
      typeof result.body === "string"
        ? result.body.slice(0, 200)
        : JSON.stringify(result.body).slice(0, 200);
    console.log(`[damage-action] ${action} claim=${claimId} OK body=${preview}`);
  } else {
    console.log(
      `[damage-action] ${action} claim=${claimId} FAIL status=${result.status} error=${result.error.slice(0, 200)}`
    );
  }
}

export async function transitionAction(formData: FormData): Promise<void> {
  const claimId = String(formData.get("claim_id") ?? "").trim();
  if (!claimId) {
    redirect(
      `/admin/damage?action_error=${encodeURIComponent(
        "Missing claim id on transition submission."
      )}`
    );
  }

  logActionEntry("transition", claimId, formData);
  const result = await damagePostForm(
    `/manage/api/claim/${encodeURIComponent(claimId)}/transition`,
    formData
  );
  logActionResult("transition", claimId, result);

  if (!result.ok) {
    errorRedirect(claimId, result.error);
  }

  revalidatePath(detailPath(claimId));
  redirect(detailPath(claimId));
}

export async function addNoteAction(formData: FormData): Promise<void> {
  const claimId = String(formData.get("claim_id") ?? "").trim();
  if (!claimId) {
    redirect(
      `/admin/damage?action_error=${encodeURIComponent(
        "Missing claim id on note submission."
      )}`
    );
  }

  logActionEntry("note", claimId, formData);
  const result = await damagePostForm(
    `/manage/api/claim/${encodeURIComponent(claimId)}/note`,
    formData
  );
  logActionResult("note", claimId, result);

  if (!result.ok) {
    errorRedirect(claimId, result.error);
  }

  revalidatePath(detailPath(claimId));
  redirect(detailPath(claimId));
}

/* ============================================================
 * Brief 5d — document actions
 * ============================================================ */

/**
 * POST /manage/api/claim/{id}/document — multipart upload.
 *
 * Forwards the entire FormData (including the File field) verbatim via
 * damagePostMultipart. The worker reads the body with request.formData()
 * directly (not via @splash/http readForm) so the file passes through.
 *
 * Field name on the file input MUST be "file"; doc selector MUST be named
 * "doc_type" (not "document_type"). The damage-worker reads exactly those
 * names — see apps/damage-worker/src/index.ts:773.
 */
export async function uploadDocumentAction(formData: FormData): Promise<void> {
  const claimId = String(formData.get("claim_id") ?? "").trim();
  if (!claimId) {
    redirect(
      `/admin/damage?action_error=${encodeURIComponent(
        "Missing claim id on document upload."
      )}`
    );
  }

  logActionEntry("upload-document", claimId, formData);
  const result = await damagePostMultipart(
    `/manage/api/claim/${encodeURIComponent(claimId)}/document`,
    formData
  );
  logActionResult("upload-document", claimId, result);

  if (!result.ok) {
    errorRedirect(claimId, result.error);
  }

  revalidatePath(detailPath(claimId));
  redirect(detailPath(claimId));
}

/**
 * POST /manage/api/claim/{id}/document/{docId}/edit — metadata-only.
 *
 * URL-encoded (no file). Forwards FormData verbatim — worker reads vendor,
 * amount, notes, pay_to_type, vendor_address. doc_id is read from the
 * hidden form field and folded into the URL path.
 */
export async function editDocumentAction(formData: FormData): Promise<void> {
  const claimId = String(formData.get("claim_id") ?? "").trim();
  const docId = String(formData.get("doc_id") ?? "").trim();
  if (!claimId) {
    redirect(
      `/admin/damage?action_error=${encodeURIComponent(
        "Missing claim id on document edit."
      )}`
    );
  }
  if (!docId) {
    errorRedirect(claimId, "Missing document id on edit submission.");
  }

  logActionEntry("edit-document", claimId, formData);
  const result = await damagePostForm(
    `/manage/api/claim/${encodeURIComponent(claimId)}/document/${encodeURIComponent(
      docId
    )}/edit`,
    formData
  );
  logActionResult("edit-document", claimId, result);

  if (!result.ok) {
    errorRedirect(claimId, result.error);
  }

  revalidatePath(detailPath(claimId));
  redirect(detailPath(claimId));
}

/**
 * POST /manage/api/claim/{id}/document/{docId}/delete — soft-delete.
 *
 * No body fields read by the worker beyond what's in the URL path; we
 * still forward the FormData (which the worker harmlessly ignores).
 *
 * v1 confirmation pattern (per Brief 5d §scope.5): the Delete button on
 * the tile is a Link to ?confirm_delete_id=N. The detail page renders a
 * confirmation banner with a "Yes, delete" form whose action is this
 * function. No anti-replay token — reloading the confirm URL re-triggers
 * the delete only if "Yes" is clicked again, which is still user-initiated.
 * Stricter (one-shot token) version is a follow-up if needed.
 */
export async function deleteDocumentAction(formData: FormData): Promise<void> {
  const claimId = String(formData.get("claim_id") ?? "").trim();
  const docId = String(formData.get("doc_id") ?? "").trim();
  if (!claimId) {
    redirect(
      `/admin/damage?action_error=${encodeURIComponent(
        "Missing claim id on document delete."
      )}`
    );
  }
  if (!docId) {
    errorRedirect(claimId, "Missing document id on delete submission.");
  }

  logActionEntry("delete-document", claimId, formData);
  const result = await damagePostForm(
    `/manage/api/claim/${encodeURIComponent(claimId)}/document/${encodeURIComponent(
      docId
    )}/delete`,
    formData
  );
  logActionResult("delete-document", claimId, result);

  if (!result.ok) {
    errorRedirect(claimId, result.error);
  }

  revalidatePath(detailPath(claimId));
  redirect(detailPath(claimId));
}
