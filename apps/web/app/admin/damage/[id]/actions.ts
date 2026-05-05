// Server actions for /admin/damage/[id]. Briefs 5c + 5d + 18 + 19.
//
// Five write surfaces:
//   - transitionAction:     POST /manage/api/claim/{id}/transition         (5c)
//   - addNoteAction:        POST /manage/api/claim/{id}/note               (5c)
//   - uploadDocumentAction: POST /manage/api/claim/{id}/document           (5d)
//   - editDocumentAction:   POST /manage/api/claim/{id}/document/{docId}/edit   (5d)
//   - deleteDocumentAction: POST /manage/api/claim/{id}/document/{docId}/delete (5d)
//
// Brief 19 — pattern flip:
//   Each action's signature is now (prevState, formData) => Promise<ActionResult>
//   to match React 19's useActionState contract. The actions return a typed
//   result instead of calling redirect(). The <ActionForm> client wrapper at
//   apps/web/app/admin/_components/ActionForm.tsx dispatches via
//   useActionState, surfaces the result inline (success toast / error
//   banner), and calls router.refresh() on a fresh ok result so the page's
//   server-component data re-fetches. revalidatePath() inside each action
//   invalidates Next's route cache so the refresh sees the post-mutation
//   state.
//
//   Why we don't redirect: Next 15 server actions invoked through the
//   OpenNext-on-Cloudflare-Workers runtime don't reliably propagate
//   redirect() responses as a visible client navigation in staging — the
//   action runs to completion, the DB updates, but the browser sits on the
//   pre-action URL until manual reload. The useActionState +
//   router.refresh() pattern sidesteps the issue and matches the docs'
//   recommendation for inline post-action feedback.
//
// Brief 18 diagnostic logging is retained — every click writes one entry
// log + one outcome log to splash-web Worker logs (prefixed [damage-action])
// so the dcRole-population mystery is observable. Remove in a follow-up.

"use server";

import { revalidatePath } from "next/cache";
import { damagePostForm, damagePostMultipart, type DamagePostResult } from "../_lib/worker-fetch";
import type { ActionResult } from "../../_components/ActionForm";

function detailPath(claimId: string): string {
  return `/admin/damage/${encodeURIComponent(claimId)}`;
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

export async function transitionAction(
  _prevState: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const claimId = String(formData.get("claim_id") ?? "").trim();
  if (!claimId) {
    return { ok: false, error: "Missing claim id on transition submission." };
  }

  logActionEntry("transition", claimId, formData);
  const result = await damagePostForm(
    `/manage/api/claim/${encodeURIComponent(claimId)}/transition`,
    formData
  );
  logActionResult("transition", claimId, result);

  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath(detailPath(claimId));
  const toStatus = String(formData.get("to_status") ?? "").trim();
  return {
    ok: true,
    message: toStatus ? `Status updated to ${toStatus}` : "Status updated"
  };
}

export async function addNoteAction(
  _prevState: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const claimId = String(formData.get("claim_id") ?? "").trim();
  if (!claimId) {
    return { ok: false, error: "Missing claim id on note submission." };
  }

  logActionEntry("note", claimId, formData);
  const result = await damagePostForm(
    `/manage/api/claim/${encodeURIComponent(claimId)}/note`,
    formData
  );
  logActionResult("note", claimId, result);

  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath(detailPath(claimId));
  return { ok: true, message: "Note added" };
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
export async function uploadDocumentAction(
  _prevState: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const claimId = String(formData.get("claim_id") ?? "").trim();
  if (!claimId) {
    return { ok: false, error: "Missing claim id on document upload." };
  }

  logActionEntry("upload-document", claimId, formData);
  const result = await damagePostMultipart(
    `/manage/api/claim/${encodeURIComponent(claimId)}/document`,
    formData
  );
  logActionResult("upload-document", claimId, result);

  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath(detailPath(claimId));
  const docType = String(formData.get("doc_type") ?? "").trim();
  return {
    ok: true,
    message: docType ? `${docType} uploaded` : "Document uploaded"
  };
}

/**
 * POST /manage/api/claim/{id}/document/{docId}/edit — metadata-only.
 *
 * URL-encoded (no file). Forwards FormData verbatim — worker reads vendor,
 * amount, notes, pay_to_type, vendor_address. doc_id is read from the
 * hidden form field and folded into the URL path.
 */
export async function editDocumentAction(
  _prevState: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const claimId = String(formData.get("claim_id") ?? "").trim();
  const docId = String(formData.get("doc_id") ?? "").trim();
  if (!claimId) {
    return { ok: false, error: "Missing claim id on document edit." };
  }
  if (!docId) {
    return { ok: false, error: "Missing document id on edit submission." };
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
    return { ok: false, error: result.error };
  }

  revalidatePath(detailPath(claimId));
  return { ok: true, message: "Document updated" };
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
export async function deleteDocumentAction(
  _prevState: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const claimId = String(formData.get("claim_id") ?? "").trim();
  const docId = String(formData.get("doc_id") ?? "").trim();
  if (!claimId) {
    return { ok: false, error: "Missing claim id on document delete." };
  }
  if (!docId) {
    return { ok: false, error: "Missing document id on delete submission." };
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
    return { ok: false, error: result.error };
  }

  revalidatePath(detailPath(claimId));
  return { ok: true, message: "Document deleted" };
}
