// Server actions for Save Draft and Publish. The BuilderClient is a client
// component, so it can't import the SSR worker-fetch helper directly
// (worker-fetch uses next/headers / Cloudflare bindings). These thin
// wrappers let the client invoke the worker via a typed RPC.
//
// Per planning Decision 3 + Brief 19: Save Draft / Publish are server-action
// style writes. We don't use <ActionForm> here because the payload (full
// fields array) is a structured JS object — easier to invoke the action
// directly as `await saveDraftAction(...)` from the client island.

"use server";

import type { Field, FormSchema, FormWorkflow } from "@splash/forms-schema";

import {
  publishFormAdmin,
  reResolveApproversAdmin,
  setFormAccessTagAdmin,
  updateDraftAdmin,
  type PublishResponse,
  type ReResolveApproversResult
} from "../_lib/worker-fetch";

export type SaveDraftResult =
  | { ok: true }
  | { ok: false; error: string };

export type PublishResult =
  | { ok: true; published_version_number: number; new_draft_id: string }
  | { ok: false; error: string };

export async function saveDraftAction(
  formId: string,
  fields: Field[],
  workflow: FormWorkflow | null
): Promise<SaveDraftResult> {
  try {
    // Brief 120 — omit `workflow` from the schema entirely when null
    // (rather than sending `workflow: null`) so the optional field on
    // formSchemaSchema's draft variant stays absent. The worker's Zod
    // schema treats missing-vs-null as different shapes.
    const schema: FormSchema = workflow
      ? { fields, workflow }
      : { fields };
    await updateDraftAdmin(formId, schema);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}

export async function publishFormAction(
  formId: string
): Promise<PublishResult> {
  try {
    const res: PublishResponse = await publishFormAdmin(formId);
    return {
      ok: true,
      published_version_number: res.published_version_number,
      new_draft_id: res.new_draft_id
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}

export type ReResolveResult =
  | { ok: true; result: ReResolveApproversResult }
  | { ok: false; error: string };

/** Re-stamp `current_approver_emails` on every in-flight submission of this
 *  form from its CURRENT published version.
 *
 *  Deliberately NOT folded into publishFormAction. Publishing is how you
 *  change the form; moving 200 live tickets onto a different person's desk is
 *  a separate decision, and one an operator should be able to make without
 *  republishing (and decline while republishing). */
export async function reResolveApproversAction(
  formId: string
): Promise<ReResolveResult> {
  try {
    return { ok: true, result: await reResolveApproversAdmin(formId) };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}

export type SetAccessTagResult =
  | { ok: true; access_tag: string | null }
  | { ok: false; error: string };

/** Set or clear the form's access tag. Separate from saveDraftAction because
 *  it writes to the `forms` row, not the draft schema, and takes effect the
 *  moment it returns rather than on publish -- an access control should not
 *  wait behind an unrelated publish step. */
export async function setAccessTagAction(
  formId: string,
  accessTag: string | null
): Promise<SetAccessTagResult> {
  try {
    const res = await setFormAccessTagAdmin(formId, accessTag);
    return { ok: true, access_tag: res.access_tag };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}
