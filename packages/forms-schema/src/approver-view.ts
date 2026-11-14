// What an approver is shown when deciding a stage.
//
// ONE rule for every place an approver decides: the emailed approval page
// (forms-worker approval-links/handlers.ts) and the dashboard detail page
// opened from Pending Approvals (apps/web). Two copies of "which answers does
// the decision rest on" would drift, and the drift would be that the RM sees a
// different request depending on which link they clicked.
//
// Kept free of runtime imports so apps/web can import it by subpath
// (`@splash/forms-schema/approver-view`); the package root uses `.js`
// specifiers that Next's webpack cannot resolve.

import type { Field, FormSchema, WorkflowStage } from "./types";

/**
 * Whether a field was shown to the person filling the form, given what they
 * answered. Single-level only, deliberately: a field gated on a field that is
 * itself gated resolves against whatever the controlling field's value
 * actually is, which for a hidden control is absent, so the dependent hides
 * too. (Re-exported from types.ts; the server's submit path uses it too.)
 */
export function isFieldVisible(
  field: Field,
  payload: Record<string, unknown>
): boolean {
  const vis = field.visible_if;
  if (!vis) return true;
  const raw = payload[vis.field_key];
  if (raw == null) return false;
  if (Array.isArray(raw)) {
    return raw.some((v) => typeof v === "string" && vis.equals.includes(v));
  }
  return typeof raw === "string" && vis.equals.includes(raw);
}

/**
 * The answers an approver at `stage` decides on, in form order. Left off:
 * display-only types, signatures, hidden lookups (routing data such as the
 * RM's address -- the filler never saw them either), questions that were
 * never shown, and fields marked hide_from_approvers -- unless the stage lists
 * exactly what to show via `show_fields`. Everything still appears in the
 * full submission and on the PDF.
 */
export function approverFields(
  schema: FormSchema,
  stage: WorkflowStage | null | undefined,
  payload: Record<string, unknown>
): Field[] {
  return schema.fields
    .filter((f) => f.type !== "heading" && f.type !== "image" && f.type !== "signature")
    .filter((f) =>
      stage?.show_fields ? stage.show_fields.includes(f.key) : !f.hide_from_approvers
    )
    .filter((f) => !(f.type === "lookup" && f.resolutionMode === "prefill_hidden"))
    .filter((f) => isFieldVisible(f, payload));
}
