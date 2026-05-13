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
  updateDraftAdmin,
  type PublishResponse
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
