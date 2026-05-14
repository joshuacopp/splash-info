// Brief 125 — workflow notification webhook fires.
// Brief 127 — DEPRECATED. The per-step assignment + per-outcome
// webhook fires migrated to the `outbound_emails` queue table +
// explicit "email step" workflow stages. The functions in this module
// are documented no-ops kept for one cycle so any operator config that
// still references `FORMS_OUTCOME_NOTIFICATION_WEBHOOK_URL` doesn't
// error at the call site. Future executors should delete this module
// once it's confirmed no code path imports it.
//
// `getWorkflowNotifications` is the only helper that retains semantic
// meaning — the `notifications` block on the workflow schema is
// preserved for back-compat (read-only) so existing form_versions rows
// continue to validate. The booleans no longer drive any side effect.

import type { FormWorkflow, WorkflowHistoryEntry } from "@splash/forms-schema";

import type { Env } from "./index.js";

export interface AssignmentPayload {
  type: "assignment";
  submission_id: string;
  form_id: string;
  form_title: string;
  step_label: string;
  recipient_email: string;
  submitter_email: string | null;
  submitted_at: string;
  review_url: string;
}

export interface OutcomeActorEntry {
  step_label: string;
  email: string;
  action: string;
  at: string;
  note: string | null;
  typed_name: string | null;
  signature_r2_key: string | null;
}

export interface OutcomePayload {
  type: "outcome";
  submission_id: string;
  form_id: string;
  form_title: string;
  outcome_label: string;
  outcome_kind: "success" | "danger" | "warning" | "info" | "neutral";
  recipient_email: string;
  recipient_role: "submitter" | "actor";
  submitter_email: string | null;
  submitted_at: string;
  outcome_reached_at: string;
  actor_history: OutcomeActorEntry[];
  review_url: string;
}

/** @deprecated Brief 127 — no-op. Use explicit `kind: "email"` workflow
 *  stages + `outbound_emails` queue instead. */
export async function fireAssignmentNotification(
  _env: Env,
  payload: AssignmentPayload
): Promise<void> {
  console.log(
    `[forms.notify.assignment] deprecated webhook path; use workflow email steps (recipient=${payload.recipient_email})`
  );
}

/** @deprecated Brief 127 — no-op. Use explicit `kind: "email"` workflow
 *  stages + `outbound_emails` queue instead. */
export async function fireOutcomeNotification(
  _env: Env,
  payload: OutcomePayload
): Promise<void> {
  console.log(
    `[forms.notify.outcome] deprecated webhook path; use workflow email steps (recipient=${payload.recipient_email})`
  );
}

// =============================================================================
// Helpers (still in use post-Brief 127)
// =============================================================================

/**
 * Brief 125 — defaults for the workflow.notifications block.
 *
 * @deprecated Brief 127 — the booleans on the returned shape no longer
 * drive any side effect. The helper is preserved so any downstream
 * consumer reading the workflow object's defaults doesn't break;
 * future readers should treat the result as informational only.
 */
export function getWorkflowNotifications(workflow: FormWorkflow): {
  notify_approver_on_assignment: boolean;
  notify_submitter_on_outcome: boolean;
  notify_approvers_on_outcome: boolean;
} {
  const n = workflow.notifications ?? {};
  return {
    notify_approver_on_assignment:
      n.notify_approver_on_assignment ?? true,
    notify_submitter_on_outcome: n.notify_submitter_on_outcome ?? true,
    notify_approvers_on_outcome: n.notify_approvers_on_outcome ?? false
  };
}

/**
 * Brief 125 — predicate matching the apps/web `stageIsOutcome` helper.
 * Predicate fallback: a stage is an outcome iff:
 *   - `kind === "outcome"` (explicit hint), OR
 *   - no approver_source AND no transitions out (predicate-detected
 *     terminal).
 *
 * Still used by the cascade helper to detect outcome-paired email
 * steps for `{outcome.label}` template substitution.
 */
export function workflowStageIsOutcome(
  stage: FormWorkflow["stages"][number]
): boolean {
  if (stage.kind === "outcome") return true;
  if (stage.kind === "step" || stage.kind === "approval" || stage.kind === "email") {
    return false;
  }
  return stage.transitions.length === 0 && !stage.approver_source;
}

/**
 * Build the production review URL for a submission. The forms-worker
 * doesn't know its own hostname at runtime; this hardcodes the
 * splashcarwashes.info origin (matches Brief 121's `dashboard_url`
 * pattern). Operators click these from email; staging URLs would 404
 * for recipients.
 */
export function buildReviewUrl(formId: string, submissionId: string): string {
  return `https://splashcarwashes.info/admin/forms/${encodeURIComponent(
    formId
  )}/submissions/${encodeURIComponent(submissionId)}`;
}

/**
 * Brief 125 — convert the submission's `workflow_history` array into
 * the `OutcomePayload.actor_history` shape. Retained for any future
 * consumer that wants the same shape.
 */
export function buildActorHistory(
  workflow: FormWorkflow,
  history: WorkflowHistoryEntry[]
): OutcomeActorEntry[] {
  return history.map((entry) => {
    const fromStage = workflow.stages.find((s) => s.id === entry.from);
    const stepLabel = fromStage?.label ?? entry.from;
    const transition = fromStage?.transitions.find(
      (t) => t.to === entry.to
    );
    const actionLabel = transition?.label ?? "Move";
    return {
      step_label: stepLabel,
      email: entry.actor_email,
      action: actionLabel,
      at: entry.at,
      note: entry.note,
      typed_name: entry.typed_name,
      signature_r2_key: entry.signature_r2_key
    };
  });
}
