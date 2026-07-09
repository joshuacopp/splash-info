// Server actions for the forms list page: archive (unpublish) and restore
// (republish). The list table is server-rendered, but the Archive / Restore
// controls are client islands — these thin wrappers let a client button invoke
// the worker via a typed RPC, then revalidate the list so the row's status
// (and the submissions-index visibility) updates without a manual reload.
//
// Mirrors the [id]/actions.ts pattern. The underlying worker endpoints already
// enforce the super_admin / dc-admin gate (adminGate), so these actions carry
// no extra auth of their own — they inherit the worker's check.

"use server";

import { revalidatePath } from "next/cache";

import { unpublishFormAdmin, republishFormAdmin } from "./_lib/worker-fetch";

export type FormStatusResult =
  | { ok: true }
  | { ok: false; error: string };

export async function archiveFormAction(
  formId: string
): Promise<FormStatusResult> {
  try {
    await unpublishFormAdmin(formId);
    revalidatePath("/admin/forms");
    revalidatePath("/admin/forms/submissions");
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}

export async function restoreFormAction(
  formId: string
): Promise<FormStatusResult> {
  try {
    await republishFormAdmin(formId);
    revalidatePath("/admin/forms");
    revalidatePath("/admin/forms/submissions");
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}
