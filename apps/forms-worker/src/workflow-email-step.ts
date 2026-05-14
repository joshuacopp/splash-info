// Brief 127 — email-step rendering + enqueue cascade.
//
// When a submission's `workflow_stage` lands on an email-kind stage,
// the worker:
//   1. Renders the email step's `subject_template` + `body_template`
//      against the submission's payload + a small `runtime_context`
//      map (form title, urls, submitter info, outcome label/timestamp
//      when applicable, payload.summary).
//   2. Resolves the stage's `recipients` list (array of
//      `ApproverSource`) via `resolveApproverEmails`, merging the
//      results (deduped, lowercased).
//   3. For each resolved recipient, enqueues an `outbound_emails` row
//      via the shared `enqueueOutboundEmail` helper.
//   4. Stamps a `workflow_history` entry with `actor_kind: "system"`
//      and the enqueued email_ids.
//   5. Advances `workflow_stage` to `stage.transitions[0].to`.
//   6. Recurses if the new stage is ALSO an email step (depth-capped
//      at 10 to defend against builder cycles the strict validator
//      should have rejected).
//
// The cascade is awaited inside the calling submit/transition handler
// (so workflow_history captures the email_ids) but fail-soft — if
// enqueue throws, the transition / submit still proceeds with the
// history entry minus the failed email_id reference, and we log
// `[forms.workflow.email-step] enqueue failed for stage {id}`.

import type {
  ApproverSource,
  FormMeta,
  FormSchema,
  FormVersion,
  FormWorkflow,
  SubmissionPayload,
  WorkflowHistoryEntry,
  WorkflowStage
} from "@splash/forms-schema";
import {
  enqueueOutboundEmail,
  type EnqueueOutboundEmailResult,
  type OutboundEmailAttachment,
  type OutboundEmailPayload
} from "@splash/db-supabase";

import type { Env } from "./index.js";
import { resolveApproverEmails } from "./workflow-resolution.js";
import { generateOrReuseCompletedPdf } from "./pdf/cascade-attach.js";

const MAX_CASCADE_DEPTH = 10;

export interface OutcomeContext {
  /** Outcome stage `label` to substitute into `{outcome.label}`. Null
   *  when the email step is not an "outcome-paired" step. */
  outcomeLabel: string | null;
  /** ISO 8601 timestamp at which the outcome was reached. */
  outcomeReachedAt: string | null;
}

export interface RuntimeContext {
  formTitle: string;
  formSlug: string;
  submitterEmail: string | null;
  submitterName: string | null;
  submissionId: string;
  formId: string;
  outcome: OutcomeContext;
}

export interface CascadeResult {
  /** Final workflow_stage after the cascade (the first non-email stage
   *  reached, or the original stage when no email step was on the
   *  path). */
  workflow_stage: string;
  /** History entries appended during the cascade (one per email step
   *  the cascade walked through). Caller concatenates with prior
   *  history before writing back to Supabase. */
  appended_history: WorkflowHistoryEntry[];
  /** Email_ids that were enqueued, accumulated across every step in
   *  the cascade. */
  enqueued_email_ids: string[];
  /** New `current_approver_emails` after the cascade lands — empty
   *  when the cascade terminates on an outcome / email step's next
   *  stage that has no approver. */
  current_approver_emails: string[];
}

/**
 * Walk forward through email steps from `startStageId`, enqueuing
 * emails + appending history at each one. Stops when:
 *   - the destination is not an email step (returns its id +
 *     resolved approver emails)
 *   - we hit MAX_CASCADE_DEPTH (logged + returns the latest stage)
 *   - the destination stage doesn't exist in the workflow (broken
 *     transition — strict validator should have caught this; return
 *     the latest stage and stop)
 *
 * The caller is responsible for:
 *   - building the initial RuntimeContext (everything but
 *     `outcome.label`/`outcome.reached_at` is invariant across the
 *     cascade; outcome fields are computed per-step inside this helper)
 *   - writing the result back to `form_submissions` in one PATCH.
 */
export async function cascadeThroughEmailSteps(
  env: Env,
  ctx: {
    form: Pick<FormMeta, "id" | "slug" | "title">;
    version: Pick<FormVersion, "id" | "versionNumber">;
    schema: FormSchema;
    payload: SubmissionPayload;
    runtime: RuntimeContext;
    startStageId: string;
    /** When a transition INTO a (potentially-)email-step occurred,
     *  pass the prior stage id here for the `from` field of the
     *  cascade's first history entry. Pass null when the email step
     *  IS the default stage (submission-time path). */
    fromStageId: string | null;
    /** Brief 129 — Submission-row metadata threaded through to the
     *  completed-form PDF generator when an email step has
     *  `attach_pdf: true`. Optional — when omitted, attach_pdf flags are
     *  ignored (the cascade enqueues without attachments). At submit
     *  time the caller has every piece of this data; at transition
     *  time it's already on the SubmissionDetail row. */
    submissionMeta?: import("./pdf/generate.js").SubmissionRowMeta;
    /** Brief 129 — workflow_history that EXISTED on the row before this
     *  cascade ran. Used (combined with cascade-appended entries) for
     *  the PDF reuse timestamp check. Optional, defaults to []. */
    priorWorkflowHistory?: WorkflowHistoryEntry[];
  }
): Promise<CascadeResult> {
  const workflow = ctx.schema.workflow;
  if (!workflow) {
    return {
      workflow_stage: ctx.startStageId,
      appended_history: [],
      enqueued_email_ids: [],
      current_approver_emails: []
    };
  }

  let currentStageId = ctx.startStageId;
  let previousStageId = ctx.fromStageId;
  const appended: WorkflowHistoryEntry[] = [];
  const enqueuedEmailIds: string[] = [];

  for (let depth = 0; depth < MAX_CASCADE_DEPTH; depth++) {
    const stage = workflow.stages.find((s) => s.id === currentStageId);
    if (!stage) {
      console.warn(
        `[forms.workflow.email-step] cascade: stage "${currentStageId}" missing from workflow; halting`
      );
      break;
    }
    if (!isEmailStage(stage)) {
      // Reached the first non-email stage. Resolve its approvers (if
      // any) so the caller can stamp current_approver_emails.
      const approvers = stage.approver_source
        ? await resolveApproverEmails(env, stage.approver_source, {
            schema: ctx.schema,
            payload: ctx.payload
          }).catch(() => [])
        : [];
      return {
        workflow_stage: currentStageId,
        appended_history: appended,
        enqueued_email_ids: enqueuedEmailIds,
        current_approver_emails: approvers
      };
    }

    // It's an email step. Render subject + body, resolve recipients,
    // enqueue one row per recipient, append the history entry, then
    // advance.
    const nextStageId = stage.transitions[0]?.to ?? "";
    const nextStage = workflow.stages.find((s) => s.id === nextStageId);
    const outcomeForRender: OutcomeContext =
      nextStage && stageIsOutcomeKind(nextStage)
        ? {
            outcomeLabel: nextStage.label || nextStage.id,
            outcomeReachedAt: new Date().toISOString()
          }
        : { outcomeLabel: null, outcomeReachedAt: null };

    const localRuntime: RuntimeContext = {
      ...ctx.runtime,
      outcome: outcomeForRender
    };

    const recipients = await resolveEmailRecipients(env, ctx.schema, ctx.payload, stage);
    const stageEmailIds: string[] = [];
    const stageRecipients: string[] = [];

    // Brief 129 — when the step has `attach_pdf: true` AND the caller
    // passed submission metadata, generate or reuse the completed-form
    // PDF and attach it to every enqueue in this stage. Cached across
    // recipients in the same stage. Fail-soft: a null result means the
    // emails still enqueue without the attachment.
    let stageAttachments: OutboundEmailAttachment[] | undefined;
    if (stage.attach_pdf && ctx.submissionMeta) {
      try {
        const result = await generateOrReuseCompletedPdf(env, {
          formId: ctx.form.id,
          formSlug: ctx.form.slug,
          formTitle: ctx.form.title,
          formVersionNumber: ctx.version.versionNumber || null,
          submission: ctx.submissionMeta,
          payload: ctx.payload,
          schema: ctx.schema,
          // Reuse check uses prior + appended history (cumulative).
          workflowHistory: [
            ...(ctx.priorWorkflowHistory ?? []),
            ...appended
          ],
          outcomeLabel: outcomeForRender.outcomeLabel,
          outcomeReachedAt: outcomeForRender.outcomeReachedAt
        });
        if (result) stageAttachments = [result.attachment];
      } catch (err) {
        console.error(
          `[forms.pdf] generate failed for submission ${ctx.runtime.submissionId} stage ${stage.id}`,
          err
        );
      }
    }

    for (const recipient of recipients) {
      const subject = renderTemplate(
        stage.subject_template ?? "",
        ctx.schema,
        ctx.payload,
        localRuntime
      );
      const body = renderTemplate(
        stage.body_template ?? "",
        ctx.schema,
        ctx.payload,
        localRuntime
      );
      const payload: OutboundEmailPayload = {
        source_worker: "forms",
        source_kind: "workflow-email-step",
        source_id: `${ctx.runtime.submissionId}:${stage.id}`,
        recipient,
        subject,
        body_text: body,
        ...(stageAttachments ? { attachments: stageAttachments } : {})
      };
      try {
        const result: EnqueueOutboundEmailResult = await enqueueOutboundEmail(
          env,
          payload
        );
        stageEmailIds.push(result.id);
        stageRecipients.push(recipient);
      } catch (err) {
        console.error(
          `[forms.workflow.email-step] enqueue failed for stage ${stage.id}`,
          err
        );
        // Continue with remaining recipients + advance — the cascade is
        // fail-soft.
      }
    }
    enqueuedEmailIds.push(...stageEmailIds);

    const historyEntry: WorkflowHistoryEntry = {
      from: previousStageId ?? stage.id,
      to: stage.transitions[0]?.to ?? "",
      // The current type's `actor_email` is `string` (not `null`),
      // because Brief 120's transition path always has a real
      // operator. System-driven advances use a sentinel value so
      // downstream UIs can render "Email step — system advance" when
      // they want.
      actor_email: "system@forms",
      actor_session_role: null,
      note: stageRecipients.length > 0
        ? `Email step: enqueued ${stageRecipients.length} email(s) (recipients: ${stageRecipients.join(", ")})`
        : "Email step: no recipients resolved",
      signature_r2_key: null,
      typed_name: null,
      at: new Date().toISOString()
    };
    appended.push(historyEntry);

    // Advance.
    if (!nextStageId) {
      console.warn(
        `[forms.workflow.email-step] cascade: stage "${stage.id}" has empty transition.to; halting`
      );
      // Stay on the email step rather than picking a random stage —
      // the submission is effectively stuck and a human can intervene
      // via SQL or by republishing the form.
      return {
        workflow_stage: stage.id,
        appended_history: appended,
        enqueued_email_ids: enqueuedEmailIds,
        current_approver_emails: []
      };
    }
    previousStageId = stage.id;
    currentStageId = nextStageId;
  }

  // Depth cap hit — bail out, log, leave the submission on the latest
  // stage so a human can intervene.
  console.warn(
    `[forms.workflow.email-step] cascade depth cap (${MAX_CASCADE_DEPTH}) hit; halting on stage "${currentStageId}"`
  );
  return {
    workflow_stage: currentStageId,
    appended_history: appended,
    enqueued_email_ids: enqueuedEmailIds,
    current_approver_emails: []
  };
}

/**
 * Predicate matching the reducer's `stageIsEmail` — used both at
 * cascade decision points AND to detect "outcome-paired" email steps.
 */
export function isEmailStage(stage: WorkflowStage): boolean {
  if (stage.kind === "email") return true;
  return false;
}

function stageIsOutcomeKind(stage: WorkflowStage): boolean {
  if (stage.kind === "outcome") return true;
  if (stage.kind === "email" || stage.kind === "approval" || stage.kind === "step") {
    return false;
  }
  return (
    stage.transitions.length === 0 &&
    !stage.approver_source &&
    (!stage.recipients || stage.recipients.length === 0)
  );
}

/**
 * Resolve every entry in an email stage's `recipients` array, union
 * the result (dedup + lowercase). Empty list returns []. Resolution
 * failures on individual entries log + skip — other entries still get
 * resolved.
 */
async function resolveEmailRecipients(
  env: Env,
  schema: FormSchema,
  payload: SubmissionPayload,
  stage: WorkflowStage
): Promise<string[]> {
  if (!stage.recipients || stage.recipients.length === 0) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const src of stage.recipients) {
    let resolved: string[];
    try {
      resolved = await resolveApproverEmails(
        env,
        normaliseSubmitterEmailSource(src, payload),
        { schema, payload }
      );
    } catch (err) {
      console.error(
        `[forms.workflow.email-step] recipient resolve threw for stage ${stage.id}`,
        err
      );
      continue;
    }
    for (const email of resolved) {
      if (!seen.has(email)) {
        seen.add(email);
        out.push(email);
      }
    }
  }
  return out;
}

/**
 * The Quick patterns popover writes a recipient of
 * `{ type: "payload_field", field_key: "submitter.email" }` for the
 * "Email submitter on outcome" pattern. That key isn't a form field —
 * it's a synthetic reference to `form_submissions.submitter_email`.
 * Translate it into the right source shape so the underlying resolver
 * can pull from the runtime context.
 *
 * Other synthetic keys (`payload.summary`, etc) aren't valid recipient
 * shapes — they pass through unchanged and the resolver returns []
 * (logged once at the resolver level).
 */
function normaliseSubmitterEmailSource(
  src: ApproverSource,
  payload: SubmissionPayload
): ApproverSource {
  if (src.type !== "payload_field") return src;
  if (src.field_key === "submitter.email") {
    // Inject the submitter email into a static_emails source so
    // resolveApproverEmails has something to consume. We don't carry
    // submitterEmail into `resolveApproverEmails` — its env-only
    // interface doesn't know about it. Easiest path is to read it
    // off the payload's synthetic key (which the caller seeds below).
    const raw = payload["__submitter_email__"];
    if (typeof raw === "string" && raw.includes("@")) {
      return { type: "static_emails", emails: [raw] };
    }
    return { type: "static_emails", emails: [] };
  }
  return src;
}

// =============================================================================
// Template rendering
// =============================================================================

/**
 * Substitute `{placeholder}` tokens in a template. Unknown tokens are
 * left in place (operator sees the literal `{whatever}` in the rendered
 * email — debuggable + non-fatal).
 *
 * Recognized tokens:
 *   {form.title}            — form's title
 *   {form.url}              — public form URL
 *   {submission.url}        — admin-facing submission URL
 *   {submitter.email}       — form_submissions.submitter_email (or "")
 *   {submitter.name}        — best-effort name; falls back to local part
 *   {outcome.label}         — outcome stage's label (when applicable)
 *   {outcome.reached_at}    — outcome timestamp (when applicable)
 *   {payload.summary}       — multi-line "key: value" rendering of every
 *                              non-empty payload field
 *   {field.<key>}           — value of the payload field with that key
 *
 * Brief 127 — template syntax is intentionally simple. No conditionals,
 * no markdown — just placeholder substitution. Operators can write raw
 * HTML in body_template if they need formatting; escape responsibility
 * is theirs.
 */
export function renderTemplate(
  template: string,
  schema: FormSchema,
  payload: SubmissionPayload,
  runtime: RuntimeContext
): string {
  if (!template) return "";
  const fieldLabels = new Map<string, string>();
  for (const f of schema.fields) {
    if (f.type === "heading" || f.type === "image") continue;
    fieldLabels.set(f.key, f.label);
  }
  return template.replace(/\{([^}\n]+)\}/g, (match, raw: string) => {
    const token = raw.trim();
    switch (token) {
      case "form.title":
        return runtime.formTitle;
      case "form.url":
        return `https://splashcarwashes.info/forms/${encodeURIComponent(runtime.formSlug)}`;
      case "submission.url":
        return `https://splashcarwashes.info/admin/forms/${encodeURIComponent(runtime.formId)}/submissions/${encodeURIComponent(runtime.submissionId)}`;
      case "submitter.email":
        return runtime.submitterEmail ?? "";
      case "submitter.name":
        return runtime.submitterName ?? "";
      case "outcome.label":
        return runtime.outcome.outcomeLabel ?? "";
      case "outcome.reached_at":
        return runtime.outcome.outcomeReachedAt ?? "";
      case "payload.summary":
        return renderPayloadSummary(payload, fieldLabels);
    }
    if (token.startsWith("field.")) {
      const key = token.slice("field.".length);
      const v = payload[key];
      return formatScalar(v);
    }
    return match;
  });
}

function renderPayloadSummary(
  payload: SubmissionPayload,
  fieldLabels: Map<string, string>
): string {
  const lines: string[] = [];
  for (const [key, label] of fieldLabels.entries()) {
    const value = payload[key];
    if (value == null) continue;
    const formatted = formatScalar(value);
    if (!formatted) continue;
    lines.push(`${label}: ${formatted}`);
  }
  return lines.join("\n");
}

function formatScalar(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map((x) => formatScalar(x)).join(", ");
  if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    if (typeof obj.r2_key === "string") {
      // file / signature — render the original filename when available,
      // else just the r2_key. Keeps email body legible without leaking
      // R2 internals into a customer-facing message.
      if (typeof obj.original_filename === "string") return obj.original_filename;
      return String(obj.r2_key);
    }
    try {
      return JSON.stringify(v);
    } catch {
      return "";
    }
  }
  return String(v);
}

/**
 * Helper for the calling sites in submit/index.ts + admin/submissions.ts
 * to construct the `RuntimeContext` once before invoking the cascade.
 * `submitter.name` is a best-effort derivation from the submitter
 * email's local-part — better than empty but not name-quality.
 */
export function buildRuntimeContext(args: {
  form: { id: string; slug: string; title: string };
  submissionId: string;
  submitterEmail: string | null;
}): RuntimeContext {
  const name = args.submitterEmail
    ? args.submitterEmail.split("@")[0] ?? ""
    : null;
  return {
    formTitle: args.form.title,
    formSlug: args.form.slug,
    submissionId: args.submissionId,
    formId: args.form.id,
    submitterEmail: args.submitterEmail,
    submitterName: name,
    outcome: { outcomeLabel: null, outcomeReachedAt: null }
  };
}

/**
 * The `normaliseSubmitterEmailSource` helper above reads
 * `payload["__submitter_email__"]` to back-translate a
 * `payload_field: "submitter.email"` recipient into a real email. We
 * seed that synthetic key on the payload before invoking the cascade.
 * Returns a NEW payload object — caller's original payload is
 * untouched.
 */
export function payloadWithSubmitterSynthetic(
  payload: SubmissionPayload,
  submitterEmail: string | null
): SubmissionPayload {
  if (!submitterEmail) return payload;
  return { ...payload, __submitter_email__: submitterEmail };
}

/**
 * Re-export used by callers that want to use these helpers as a single
 * pseudo-module. Kept tight — callers should import what they need.
 */
export type { FormWorkflow };
