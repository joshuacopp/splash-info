// Server actions for /admin/damage/[id]. Briefs 5c + 5d + 19 + 20 + 21 + 37.
//
// Four write surfaces (post-Brief-37):
//   - transitionAction:     POST /manage/api/claim/{id}/transition         (5c)
//   - addNoteAction:        POST /manage/api/claim/{id}/note               (5c)
//   - editDocumentAction:   POST /manage/api/claim/{id}/document/{docId}/edit   (5d)
//   - deleteDocumentAction: POST /manage/api/claim/{id}/document/{docId}/delete (5d)
//
// Brief 37 retired the prior `uploadDocumentAction` — the document
// upload form now POSTs multipart directly to the damage-worker
// (UploadDocumentCard sets `action="/manage/api/claim/{id}/document"`)
// and the worker 303-redirects back to the detail page on completion.
// Bypassing Next 15 server actions for the multipart path was the fix
// for the iPhone-Safari upload digest 924441341@e394 (Brief 36 Part B);
// the legacy info-signup-worker upload path used the same shape.
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

"use server";

import { revalidatePath } from "next/cache";
import {
  damageGetJsonOrStatus,
  damagePostForm
} from "../_lib/worker-fetch";
import type { ActionResult } from "../../_components/ActionForm";

function detailPath(claimId: string): string {
  return `/admin/damage/${encodeURIComponent(claimId)}`;
}

export async function transitionAction(
  _prevState: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const claimId = String(formData.get("claim_id") ?? "").trim();
  if (!claimId) {
    return { ok: false, error: "Missing claim id on transition submission." };
  }

  const result = await damagePostForm(
    `/manage/api/claim/${encodeURIComponent(claimId)}/transition`,
    formData
  );

  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath(detailPath(claimId));
  const toStatus = String(formData.get("to_status") ?? "").trim();

  // Brief 43 — when the override flow fires the MaintainX hook, the worker
  // returns { ok, status, lifecycle, maintainx_attempted: true,
  // maintainx_ok: boolean } so apps/web can distinguish the create-failed
  // path. Failure is fail-soft on the worker — the status transition
  // committed even though the WO couldn't be created. We surface a
  // success-toned message that names the failure so the operator can
  // check the activity log without thinking the transition itself broke.
  const body = result.body;
  if (
    body &&
    typeof body === "object" &&
    (body as { maintainx_attempted?: unknown }).maintainx_attempted === true &&
    (body as { maintainx_ok?: unknown }).maintainx_ok === false
  ) {
    return {
      ok: true,
      message: toStatus
        ? `Status updated to ${toStatus}, but the MaintainX work order couldn't be created — see activity log.`
        : "Status updated, but the MaintainX work order couldn't be created — see activity log."
    };
  }

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

  const result = await damagePostForm(
    `/manage/api/claim/${encodeURIComponent(claimId)}/note`,
    formData
  );

  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath(detailPath(claimId));
  return { ok: true, message: "Note added" };
}

/* ============================================================
 * Brief 5d — document edit/delete actions
 * (uploadDocumentAction retired in Brief 37 — the upload form now
 *  POSTs directly to the damage-worker; see UploadDocumentCard.)
 * ============================================================ */

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

  // Brief 20 Bug 7 — defensive try/catch ensures the action always returns
  // a plain serializable ActionResult. An uncaught exception inside a Next
  // server action surfaces as a generic E394 client error ("An unexpected
  // response was received from the server"); wrapping the worker call lets
  // the operator see the actual cause inline via <ActionForm>'s error
  // banner. damagePostForm is meant not to throw, but the catch covers
  // future regressions in the helper.
  try {
    const result = await damagePostForm(
      `/manage/api/claim/${encodeURIComponent(claimId)}/document/${encodeURIComponent(
        docId
      )}/edit`,
      formData
    );

    if (!result.ok) {
      return { ok: false, error: result.error };
    }

    revalidatePath(detailPath(claimId));
    return { ok: true, message: "Document updated" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[damage-action] edit-document claim=${claimId} threw: ${msg}`);
    return { ok: false, error: `Document edit failed: ${msg}` };
  }
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

  const result = await damagePostForm(
    `/manage/api/claim/${encodeURIComponent(claimId)}/document/${encodeURIComponent(
      docId
    )}/delete`,
    formData
  );

  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath(detailPath(claimId));
  return { ok: true, message: "Document deleted" };
}

/* ============================================================
 * Brief 172 — set / clear the cause/fault-attribution field on a
 * claim. Empty `fault_category` clears (NULL). UI gates dcRole !==
 * null; the worker re-validates as defense in depth and tolerates
 * the D1 column being absent during the post-deploy migration window
 * (soft success with a `migration_pending: true` body in that case).
 * ============================================================ */
export async function setFaultCategoryAction(
  _prevState: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const claimId = String(formData.get("claim_id") ?? "").trim();
  if (!claimId) {
    return { ok: false, error: "Missing claim id on cause submission." };
  }

  const result = await damagePostForm(
    `/manage/api/claim/${encodeURIComponent(claimId)}/fault-category`,
    formData
  );

  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath(detailPath(claimId));

  // Worker returns `{ ok, fault_category, migration_pending? }` — surface
  // the migration-pending state so the operator knows their pick was
  // accepted but won't persist until the ALTER TABLE lands.
  const body = result.body;
  if (
    body &&
    typeof body === "object" &&
    (body as { migration_pending?: unknown }).migration_pending === true
  ) {
    return {
      ok: true,
      message:
        "Cause saved (pending D1 migration — the operator must run the ALTER TABLE for the change to persist)."
    };
  }

  const next =
    body && typeof body === "object"
      ? (body as { fault_category?: unknown }).fault_category
      : undefined;
  const label =
    typeof next === "string" && next.length > 0 ? next : "Undetermined";
  return { ok: true, message: `Cause set to ${label}` };
}

/* ============================================================
 * Super-admin hard delete ("purge")
 *
 * Two actions consumed by the client DangerZoneCard island (not the shared
 * <ActionForm> useActionState flow — the card drives its own two-step
 * type-to-confirm UX and does a client router.push on success):
 *
 *   purgePreviewAction — GET  /manage/api/claim/{id}/purge-preview
 *                        Returns the blast-radius counts for the confirm panel.
 *   purgeClaimAction   — POST /manage/api/claim/{id}/purge
 *                        Irreversible. Worker re-gates on super_admin and
 *                        re-checks the confirm text server-side.
 *
 * Both take a plain claimId string (serializable) rather than FormData
 * because the client island calls them directly as RPCs.
 * ============================================================ */

export type PurgeCounts = {
  claims: number;
  claim_photos: number;
  claim_activity: number;
  r2_objects: number;
};

export type PurgePreviewResult =
  | { ok: true; counts: PurgeCounts }
  | { ok: false; error: string };

interface PurgePreviewResponse {
  ok: boolean;
  d1?: { claims?: number; claim_photos?: number; claim_activity?: number };
  r2?: { objects?: number };
}

export async function purgePreviewAction(
  claimId: string
): Promise<PurgePreviewResult> {
  const id = claimId.trim();
  if (!id) return { ok: false, error: "Missing claim id." };

  try {
    const result = await damageGetJsonOrStatus<PurgePreviewResponse>(
      `/manage/api/claim/${encodeURIComponent(id)}/purge-preview`
    );
    if ("status" in result) {
      if (result.status === 403) {
        return { ok: false, error: "Only a super admin can delete a claim." };
      }
      if (result.status === 404) {
        return { ok: false, error: "Claim not found." };
      }
      return { ok: false, error: `Preview failed (status ${result.status}).` };
    }
    const d = result.data;
    return {
      ok: true,
      counts: {
        claims: d.d1?.claims ?? 1,
        claim_photos: d.d1?.claim_photos ?? 0,
        claim_activity: d.d1?.claim_activity ?? 0,
        r2_objects: d.r2?.objects ?? 0
      }
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Preview failed: ${msg}` };
  }
}

export type PurgeResult =
  | { ok: true }
  | { ok: false; error: string };

export async function purgeClaimAction(
  claimId: string,
  confirmClaimId: string
): Promise<PurgeResult> {
  const id = claimId.trim();
  if (!id) return { ok: false, error: "Missing claim id." };
  if (confirmClaimId.trim() !== id) {
    return {
      ok: false,
      error: "Confirmation text does not match the claim id."
    };
  }

  const formData = new FormData();
  formData.set("confirm_claim_id", confirmClaimId.trim());

  try {
    const result = await damagePostForm(
      `/manage/api/claim/${encodeURIComponent(id)}/purge`,
      formData
    );
    if (!result.ok) {
      return { ok: false, error: result.error };
    }
    // Claim no longer exists — invalidate the list + detail caches so a
    // subsequent navigation reflects the removal.
    revalidatePath("/admin/damage");
    revalidatePath(detailPath(id));
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Delete failed: ${msg}` };
  }
}
