// Brief 125 — workflow notification webhook fires.
//
// Single PA flow handles both per-step assignment and per-outcome
// notifications; discriminated by a top-level `type` field in the
// payload. Both fires are fail-soft + 15s AbortSignal timeout (Brief 65
// / 101 posture). When `FORMS_OUTCOME_NOTIFICATION_WEBHOOK_URL` is
// unbound, both fires no-op silently with a log line.
//
// Callers wrap these fires in `ctx.waitUntil` so the transition
// response isn't blocked.

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

const FIRE_TIMEOUT_MS = 15_000;

export async function fireAssignmentNotification(
  env: Env,
  payload: AssignmentPayload
): Promise<void> {
  const url = env.FORMS_OUTCOME_NOTIFICATION_WEBHOOK_URL;
  if (!url) {
    console.log(
      `[forms.notify.assignment] webhook unbound — skipping recipient=${payload.recipient_email}`
    );
    return;
  }
  await firePost(url, payload, "assignment");
}

export async function fireOutcomeNotification(
  env: Env,
  payload: OutcomePayload
): Promise<void> {
  const url = env.FORMS_OUTCOME_NOTIFICATION_WEBHOOK_URL;
  if (!url) {
    console.log(
      `[forms.notify.outcome] webhook unbound — skipping recipient=${payload.recipient_email}`
    );
    return;
  }
  await firePost(url, payload, "outcome");
}

async function firePost(
  url: string,
  body: unknown,
  label: "assignment" | "outcome"
): Promise<void> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FIRE_TIMEOUT_MS)
    });
    if (!res.ok) {
      console.error(
        `[forms.notify.${label}] non-2xx response: status ${res.status}`
      );
    }
  } catch (err) {
    console.error(`[forms.notify.${label}] fire failed (fail-soft)`, err);
  }
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Brief 125 — defaults for the workflow.notifications block. Defaults
 * apply at READ time (the saved schema may omit the block entirely); we
 * never persist these into the schema so future executors can evolve
 * defaults without re-publishing every form.
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
 * A stage is an outcome iff:
 *   - `kind === "outcome"` (explicit hint), OR
 *   - no approver_source AND no transitions out (predicate-detected
 *     terminal).
 */
export function workflowStageIsOutcome(
  stage: FormWorkflow["stages"][number]
): boolean {
  if (stage.kind === "outcome") return true;
  if (stage.kind === "step") return false;
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
 * Brief 125 — convert the submission's `workflow_history` array into the
 * `OutcomePayload.actor_history` shape. Each entry rendered with the
 * step label resolved off the WORKFLOW (so PA can write "RM Approval"
 * instead of the snake_case `stage.id` slug); the transition's label
 * is the "action" the actor took ("Approve" / "Deny" / etc).
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
