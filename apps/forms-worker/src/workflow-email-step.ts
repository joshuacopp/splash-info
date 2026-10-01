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
  Field,
  FormMeta,
  FormSchema,
  FormVersion,
  FormWorkflow,
  SubmissionPayload,
  WorkflowHistoryEntry,
  WorkflowStage
} from "@splash/forms-schema";
import { flaggedFieldKeys } from "@splash/forms-schema";
import {
  enqueueOutboundEmail,
  type EnqueueOutboundEmailResult,
  type OutboundEmailAttachment,
  type OutboundEmailPayload
} from "@splash/db-supabase";

import type { Env } from "./index.js";
import { resolveApproverEmails } from "./workflow-resolution.js";
import {
  lookupPartsForFieldKeys,
  partsDirectoryUrl,
  type PartLink
} from "./parts-lookup.js";
import {
  lookupSafetyDocsForFieldKeys,
  type SafetyDocRow
} from "./sds/safety-docs.js";
import { generateOrReuseCompletedPdf } from "./pdf/cascade-attach.js";
import { wrapInEmailShell } from "@splash/email-shell";

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
  /** Parts answering the questions this submission flagged, keyed by field
   *  key. Backs `{parts.needed}`.
   *
   *  OPTIONAL and populated INSIDE the cascade, not by callers: it needs a
   *  database read, and only a workflow whose template actually contains the
   *  token pays for it. Absent (or empty) renders the token as nothing. */
  partsNeeded?: Map<string, PartLink[]>;
  /** Company programmes answering the same flagged questions. Resolved with
   *  the parts and rendered in the same block: a checklist flags a problem,
   *  and whether the answer is bought or adopted is not the reader's
   *  filing concern. */
  safetyDocs?: SafetyDocRow[];
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

  // Parts for `{parts.needed}`, resolved ONCE for the whole cascade and only
  // when some email step on this workflow actually asks for them — every other
  // form's cascade must not pay for a query it has no use for.
  //
  // Flagged keys come from `flaggedFieldKeys` in the schema package — ticked
  // action items PLUS anything answered with the second (bad) option of a
  // two-option question. Wider than `_action_items` on purpose: a tick is a
  // checkbox somebody has to remember, and a site that is out of gloves needs
  // gloves either way. That rule lives in the schema package precisely so this
  // and the PDF cannot end up disagreeing about what a bad answer is.
  const partsNeeded = (await resolvePartsNeeded(env, ctx.schema, ctx.payload)) ?? undefined;
  // Same trigger, same flagged keys. A question can carry both -- being out
  // of gloves and having no HazCom programme are different kinds of problem
  // and nothing here assumes a question has only one.
  const safetyDocs = (await resolveSafetyDocs(env, ctx.schema, ctx.payload)) ?? undefined;

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
      outcome: outcomeForRender,
      partsNeeded,
      safetyDocs
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
      // Brief 134 — auto-derive an HTML body from the same operator-
      // authored plain-text template. Wrap the rendered fragment in
      // the branded shell so PA can ship HTML when the queue row
      // carries body_html.
      const bodyHtmlFragment = renderTemplateHtml(
        stage.body_template ?? "",
        ctx.schema,
        ctx.payload,
        localRuntime
      );
      const bodyHtml = wrapInEmailShell(bodyHtmlFragment, {
        title: subject,
        preheader: body.slice(0, 100),
        // Heuristic — outcome-paired email steps populate
        // outcome.outcomeLabel (next stage is an outcome). Plain
        // assignment / midstream email steps leave it null.
        showApproverFooter: localRuntime.outcome.outcomeLabel == null,
        showSubmitterFooter: localRuntime.outcome.outcomeLabel != null
      });
      const payload: OutboundEmailPayload = {
        source_worker: "forms",
        source_kind: "workflow-email-step",
        source_id: `${ctx.runtime.submissionId}:${stage.id}`,
        recipient,
        subject,
        body_text: body,
        body_html: bodyHtml,
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
 *   {parts.needed}          — parts answering the questions this submission
 *                              flagged, from parts_directory.form_field_keys.
 *                              Emits its own heading, or nothing at all when
 *                              nothing was flagged / nothing is mapped.
 *   {approvals.url}         — Brief 134: pending-approvals dashboard URL
 *                              (HTML renders a labeled CTA button)
 *   {my_requests.url}       — Brief 134: "my requests" dashboard URL
 *                              (HTML renders a labeled CTA button)
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
  const fields = collectFields(schema);
  return template.replace(/\{([^}\n]+)\}/g, (match, raw: string) => {
    const token = raw.trim();
    switch (token) {
      case "form.title":
        return runtime.formTitle;
      case "form.url":
        return `https://splashcarwashes.info/forms/${encodeURIComponent(runtime.formSlug)}`;
      case "submission.url":
        return `https://splashcarwashes.info/admin/forms/${encodeURIComponent(runtime.formId)}/submissions/${encodeURIComponent(runtime.submissionId)}`;
      case "approvals.url":
        return "Pending Approvals: https://splashcarwashes.info/admin/approvals";
      case "my_requests.url":
        return "Your Submissions: https://splashcarwashes.info/admin/my-requests";
      case "submitter.email":
        return runtime.submitterEmail ?? "";
      case "submitter.name":
        return runtime.submitterName ?? "";
      case "outcome.label":
        return runtime.outcome.outcomeLabel ?? "";
      case "outcome.reached_at":
        return runtime.outcome.outcomeReachedAt ?? "";
      case "payload.summary":
        return renderPayloadSummary(payload, fields);
      case "parts.needed":
        return renderPartsNeeded(runtime.partsNeeded, fields, runtime.safetyDocs);
    }
    if (token.startsWith("field.")) {
      const key = token.slice("field.".length);
      return resolveDisplayValue(fields.get(key), payload[key]);
    }
    return match;
  });
}

/**
 * Ordered map of `key -> Field` for every answerable field (heading /
 * image fields carry no payload value and are skipped). Insertion order
 * follows the schema, so the payload summary renders fields in form order.
 */
function collectFields(schema: FormSchema): Map<string, Field> {
  const fields = new Map<string, Field>();
  for (const f of schema.fields) {
    if (f.type === "heading" || f.type === "image") continue;
    fields.set(f.key, f);
  }
  return fields;
}

// =============================================================================
// HTML template rendering (Brief 134)
// =============================================================================

/**
 * Brief 134 — produce an HTML fragment from the same template input
 * `renderTemplate` consumes. The fragment is intended to be wrapped in
 * `wrapInEmailShell` before being shipped as `body_html`.
 *
 * Operators keep authoring plain-text `body_template` — this function
 * derives the HTML body server-side. Recognized tokens render with
 * HTML-aware substitutions (escaped text, CTA buttons, payload table);
 * body text outside tokens is normalized via paragraph + linebreak
 * rules (`\n\n` → paragraph, single `\n` → `<br>`).
 *
 * Unknown tokens are left in place exactly like `renderTemplate` (the
 * operator sees the literal `{whatever}` in the rendered HTML —
 * non-fatal + debuggable).
 */
export function renderTemplateHtml(
  template: string,
  schema: FormSchema,
  payload: SubmissionPayload,
  runtime: RuntimeContext
): string {
  if (!template) return "";
  const fields = collectFields(schema);

  // Step 1: substitute tokens with sentinel-wrapped HTML so subsequent
  // paragraph normalization can't mangle the embedded markup. The
  // sentinels are bracketed by ASCII control-character pairs (\x01...
  // \x02) that should never appear in operator-authored templates.
  const TOKEN_OPEN = "\x01";
  const TOKEN_CLOSE = "\x02";
  const tokenReplaced = template.replace(/\{([^}\n]+)\}/g, (match, raw: string) => {
    const token = raw.trim();
    const html = renderTokenHtml(token, schema, payload, runtime, fields);
    if (html === null) return match;
    return `${TOKEN_OPEN}${html}${TOKEN_CLOSE}`;
  });

  // Step 2: paragraph + linebreak normalization. Split on `\n\n`
  // (double newline → new paragraph), single `\n` becomes `<br>`.
  // Each paragraph wraps in a styled `<p>`. Empty paragraphs drop.
  const paragraphs = tokenReplaced.split(/\n\n+/);
  const out: string[] = [];
  for (const p of paragraphs) {
    if (!p.trim()) continue;
    // Escape every character of the paragraph that isn't inside a
    // sentinel-wrapped token span. The token HTML is trusted (we
    // built it via the per-token helpers above); the rest is
    // operator-authored plain text and must be escaped to keep
    // user-supplied `<` / `>` / `&` from leaking into the DOM.
    const escaped = escapeOutsideSentinels(p, TOKEN_OPEN, TOKEN_CLOSE);
    // Single newlines inside the paragraph become `<br>`. Do this
    // after escaping so the literal "\n" sequences haven't been
    // touched.
    const withBreaks = escaped.replace(/\n/g, "<br>");
    out.push(`<p style="margin: 0 0 16px 0; font-size: 15px; line-height: 1.55; color: #1f2937;">${withBreaks}</p>`);
  }
  return out.join("\n");
}

function renderTokenHtml(
  token: string,
  schema: FormSchema,
  payload: SubmissionPayload,
  runtime: RuntimeContext,
  fields: Map<string, Field>
): string | null {
  switch (token) {
    case "form.title":
      return escapeHtml(runtime.formTitle);
    case "form.url": {
      const url = `https://splashcarwashes.info/forms/${encodeURIComponent(runtime.formSlug)}`;
      return renderInlineLink(url, "View Form");
    }
    case "submission.url": {
      const url = `https://splashcarwashes.info/admin/forms/${encodeURIComponent(runtime.formId)}/submissions/${encodeURIComponent(runtime.submissionId)}`;
      return renderCtaButton(url, "View Submission", "primary");
    }
    case "approvals.url":
      return renderCtaButton(
        "https://splashcarwashes.info/admin/approvals",
        "View All Open Approvals",
        "secondary"
      );
    case "my_requests.url":
      return renderCtaButton(
        "https://splashcarwashes.info/admin/my-requests",
        "View My Requests",
        "secondary"
      );
    case "submitter.email":
      return runtime.submitterEmail
        ? `<span style="font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: #0E2745;">${escapeHtml(runtime.submitterEmail)}</span>`
        : "";
    case "submitter.name":
      return escapeHtml(runtime.submitterName ?? "");
    case "outcome.label": {
      const label = runtime.outcome.outcomeLabel ?? "";
      if (!label) return "";
      const tint = outcomeTintColor(label);
      return `<strong style="color: ${tint};">${escapeHtml(label)}</strong>`;
    }
    case "outcome.reached_at":
      return escapeHtml(runtime.outcome.outcomeReachedAt ?? "");
    case "payload.summary":
      return renderPayloadSummaryHtml(payload, fields);
    case "parts.needed":
      return renderPartsNeededHtml(runtime.partsNeeded, fields, runtime.safetyDocs);
  }
  if (token.startsWith("field.")) {
    const key = token.slice("field.".length);
    const formatted = resolveDisplayValue(fields.get(key), payload[key]);
    if (!formatted) return "";
    // Multi-line strings render with `<br>` between lines.
    return escapeHtml(formatted).replace(/\n/g, "<br>");
  }
  return null;
}

function renderInlineLink(url: string, label: string): string {
  return `<a href="${escapeAttr(url)}" style="color: #1FB6E0; text-decoration: underline;">${escapeHtml(label)}</a>`;
}

function renderCtaButton(
  url: string,
  label: string,
  kind: "primary" | "secondary"
): string {
  const styles = kind === "primary"
    ? "display: inline-block; padding: 12px 24px; background-color: #1FB6E0; color: #ffffff; font-size: 15px; font-weight: 600; text-decoration: none; border-radius: 6px; border: 2px solid #1FB6E0; mso-padding-alt: 0;"
    : "display: inline-block; padding: 10px 20px; background-color: #ffffff; color: #0E2745; font-size: 14px; font-weight: 600; text-decoration: none; border-radius: 6px; border: 2px solid #0E2745; mso-padding-alt: 0;";
  // Wrap in a table for Outlook-safe vertical spacing — bare inline
  // `<a>` with padding can collapse in some Outlook versions.
  return [
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin: 16px 0;"><tr><td>`,
    `<a href="${escapeAttr(url)}" style="${styles}" target="_blank" rel="noopener">${escapeHtml(label)}</a>`,
    `</td></tr></table>`
  ].join("");
}

function renderPayloadSummaryHtml(
  payload: SubmissionPayload,
  fields: Map<string, Field>
): string {
  const rows: string[] = [];
  for (const [key, field] of fields.entries()) {
    const value = payload[key];
    if (value == null) continue;
    const formatted = resolveDisplayValue(field, value);
    if (!formatted) continue;
    const valueHtml = escapeHtml(formatted).replace(/\n/g, "<br>");
    rows.push(
      `<tr>` +
        `<td style="padding: 8px 12px 8px 0; vertical-align: top; font-size: 14px; font-weight: 600; color: #0E2745; border-bottom: 1px solid #E5E7EB; width: 35%;">${escapeHtml(field.label)}</td>` +
        `<td style="padding: 8px 0; vertical-align: top; font-size: 14px; color: #1f2937; border-bottom: 1px solid #E5E7EB;">${valueHtml}</td>` +
      `</tr>`
    );
  }
  if (rows.length === 0) return "";
  return [
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border-collapse: collapse; margin: 8px 0 20px 0; background-color: #F9FAFB; border-radius: 6px; padding: 4px 12px;">`,
    `<tbody>`,
    rows.join(""),
    `</tbody>`,
    `</table>`
  ].join("");
}

/**
 * Parts for every question this submission flagged, or null when no email step
 * on this workflow references `{parts.needed}`.
 *
 * Returning null rather than an empty map keeps "nobody asked" distinguishable
 * from "asked, found nothing" in a debugger; both render as nothing.
 */
/**
 * Programmes answering the questions this submission flagged.
 *
 * Gated on the SAME token as the parts, so no other form pays for the query,
 * and fed the SAME flagged keys so the two cannot disagree about what counts
 * as a bad answer. Returns only documents with a file: a row naming one
 * nobody has uploaded belongs on the admin page where somebody can fix it,
 * not in a site email as a link that goes nowhere.
 */
async function resolveSafetyDocs(
  env: Env,
  schema: FormSchema,
  payload: SubmissionPayload
): Promise<SafetyDocRow[] | null> {
  const workflow = schema.workflow;
  if (!workflow) return null;
  const wanted = workflow.stages.some(
    (s) =>
      isEmailStage(s) &&
      (`${s.subject_template ?? ""}${s.body_template ?? ""}`).includes("{parts.needed}")
  );
  if (!wanted) return null;
  const flagged = flaggedFieldKeys(schema, payload);
  if (flagged.length === 0) return null;
  try {
    return await lookupSafetyDocsForFieldKeys(env, flagged);
  } catch (err) {
    // Fail soft: a missing document block costs a link; throwing costs the
    // email, which carries the PDF and everything else.
    console.error("[forms.workflow.email-step] safety docs lookup failed", err);
    return null;
  }
}

async function resolvePartsNeeded(
  env: Env,
  schema: FormSchema,
  payload: SubmissionPayload
): Promise<Map<string, PartLink[]> | null> {
  const workflow = schema.workflow;
  if (!workflow) return null;
  const wanted = workflow.stages.some(
    (s) =>
      isEmailStage(s) &&
      (`${s.subject_template ?? ""}${s.body_template ?? ""}`).includes("{parts.needed}")
  );
  if (!wanted) return null;

  const flagged = flaggedFieldKeys(schema, payload);
  if (flagged.length === 0) return new Map();
  return lookupPartsForFieldKeys(env, flagged);
}

/** "MacNeil, part #ABC123" — whichever of the two the operator has filled in,
 *  and nothing at all when neither is set yet (the seeded rows ship name-only). */
function partDetailLine(part: PartLink): string {
  const bits: string[] = [];
  if (part.vendor) bits.push(part.vendor);
  if (part.part_number) bits.push(`part #${part.part_number}`);
  return bits.join(", ");
}

/** The question a part was matched against, for the sub-heading. Falls back to
 *  the key so a part mapped to a question that has since been renamed still
 *  prints something traceable. */
function questionLabelFor(key: string, fields: Map<string, Field>): string {
  return fields.get(key)?.label ?? key;
}

/**
 * The token emits its OWN heading and emits NOTHING when there is nothing to
 * order — so a clean checklist does not leave a dangling "Items to order:"
 * above an empty space, and the template author does not have to write the
 * heading conditionally (which templates cannot express).
 */
/**
 * How to actually order the things listed above.
 *
 * WITHOUT THIS THE LINKS ARE A DEAD END. A vendor link does not put anything in
 * a cart by itself -- ordering goes through ProcureDesk, and the vendor is
 * chosen INSIDE the order rather than by following the link. Somebody who
 * clicks through and finds no way to check out concludes the feature is broken,
 * when what they are missing is a step nobody told them about.
 *
 * One array, shared by the plain-text and HTML renderings, because two copies
 * of a procedure is how one of them ends up a version behind.
 */
// OPERATOR'S WORDING, VERBATIM. Do not tidy it: this is the procedure as the
// person who runs it describes it, and a paraphrase that reads better can still
// be a paraphrase that is wrong about a step.
//
// The one change is "above" -> "below" in step 4. The steps now print FIRST and
// the items follow, so "above" points at nothing.
const ORDERING_STEPS: readonly string[] = [
  "Log in to ProcureDesk.",
  "Create an order.",
  'Choose "Add line items".',
  "Select the vendor for the first group below (Amazon or Grainger).",
  "Click 'Order' on an item from this email to open the link for the vendor where it can be added to cart.",
  "Once all needed items from that vendor are added to cart, checkout with the standard ProcureDesk process."
];

/**
 * The items, grouped by VENDOR rather than by question.
 *
 * WHY IT MATTERS, and it is not cosmetic. Ordering runs one vendor at a time:
 * you pick a vendor inside ProcureDesk, then the "Order" links add to THAT
 * session's cart. Hit a Grainger link while the Amazon order is open and the
 * page opens logged out, the add goes nowhere, and nothing says so. Sorted by
 * question, the list interleaved vendors and invited exactly that.
 *
 * There is no link that can reach a logged-in cart directly without API access,
 * so the ordering of the page IS the mechanism.
 *
 * Vendors are ordered by how many items they carry, most first -- the longest
 * run of uninterrupted clicking comes first -- then by name so the output is
 * stable. Parts with no vendor recorded sort last under their own heading:
 * they cannot be ordered through ProcureDesk at all yet, and burying them in
 * the middle of a vendor run is how they get missed.
 */
/** Where a safety programme is downloaded from. Mirrors partsDirectoryUrl:
 *  one place that knows the shape of this link. */
function safetyDocUrl(slug: string): string {
  return `https://splashcarwashes.info/forms/api/sds/safety-documents/${encodeURIComponent(slug)}/file`;
}

function groupPartsByVendor(
  parts: Map<string, PartLink[]>,
  fields: Map<string, Field>
): { vendor: string | null; items: { part: PartLink; question: string }[] }[] {
  const byVendor = new Map<string, { part: PartLink; question: string }[]>();
  const seen = new Set<string>();
  for (const [key, list] of parts.entries()) {
    for (const part of list) {
      // One row per part, not per question: a part answering two questions is
      // still one thing to buy, and two rows is two chances to order it twice.
      if (seen.has(part.id)) continue;
      seen.add(part.id);
      const k = part.vendor ?? "";
      const bucket = byVendor.get(k) ?? [];
      bucket.push({ part, question: questionLabelFor(key, fields) });
      byVendor.set(k, bucket);
    }
  }
  return [...byVendor.entries()]
    .map(([vendor, items]) => ({
      vendor: vendor === "" ? null : vendor,
      items: items.sort((a, b) => a.part.part_name.localeCompare(b.part.part_name))
    }))
    .sort((a, b) => {
      if ((a.vendor === null) !== (b.vendor === null)) return a.vendor === null ? 1 : -1;
      if (a.items.length !== b.items.length) return b.items.length - a.items.length;
      return (a.vendor ?? "").localeCompare(b.vendor ?? "");
    });
}

/** "Amazon - ProcureDesk" reads as a vendor name in a table and as noise in a
 *  sentence. Strips only that exact suffix, so an unrecognised vendor string is
 *  left exactly as the operator typed it. */
function vendorShortName(vendor: string | null): string {
  if (!vendor) return "this vendor";
  return vendor.replace(/\s*-\s*ProcureDesk\s*$/i, "").trim() || vendor;
}

/** What to do between one vendor's items and the next. The whole reason the
 *  grouping exists, so it is stated rather than left to be inferred. */
function vendorHandoverLine(current: string | null, next: string | null): string {
  return (
    `Once every ${vendorShortName(current)} item above is in your cart, check out. ` +
    `Back in ProcureDesk choose "Add line items" again, select ` +
    `${vendorShortName(next)}, and repeat for the items below.`
  );
}

function renderPartsNeeded(
  parts: Map<string, PartLink[]> | undefined,
  fields: Map<string, Field>,
  docs?: SafetyDocRow[]
): string {
  const hasParts = Boolean(parts && parts.size > 0);
  const hasDocs = Boolean(docs && docs.length > 0);
  // Either half is reason enough to print. A site with its supplies in order
  // but no written HazCom programme has nothing to buy and something to do.
  if (!hasParts && !hasDocs) return "";
  const lines: string[] = [];

  // Ordering steps only when there is something to order. A site whose only gap
  // is a missing written programme has no cart to fill, and six ProcureDesk
  // steps above a single document link is noise.
  //
  // Steps BEFORE the items: the list is only actionable once somebody knows an
  // order has to exist in ProcureDesk first, and instructions underneath a list
  // of links are read after the links have already been clicked.
  if (hasParts) {
    lines.push("How to order:");
    ORDERING_STEPS.forEach((step, i) => lines.push(`  ${i + 1}. ${step}`));

    const groups = groupPartsByVendor(parts!, fields);
    lines.push("", "Items to order:");
    groups.forEach((group, gi) => {
      lines.push("", group.vendor ?? "No vendor recorded yet");
      for (const { part, question } of group.items) {
        // The question is only worth printing when it says something the part
        // name does not. "Spill Kit Fully Stocked -> Spill Kit Refill" earns
        // its line; "Wheel Chocks -> Wheel Chocks" is the same words twice.
        const asked =
          question.trim().toLowerCase() === part.part_name.trim().toLowerCase()
            ? ""
            : ` (for: ${question})`;
        const num = part.part_number ? ` part #${part.part_number}` : "";
        lines.push(`  - ${part.part_name}${num}${asked}`);
        if (part.vendor_url) lines.push(`    Order: ${part.vendor_url}`);
        lines.push(`    Details: ${partsDirectoryUrl(part.part_name)}`);
      }
      const next = groups[gi + 1];
      if (next) lines.push("", `  ${vendorHandoverLine(group.vendor, next.vendor)}`);
    });
  }

  // Programmes are adopted, not bought, so they get their own heading rather
  // than a row in a table whose other columns are a vendor and a cart.
  if (hasDocs) {
    if (lines.length > 0) lines.push("");
    lines.push("Documents to put in place:");
    for (const d of docs!) {
      lines.push(`  - ${d.title}`);
      lines.push(`    Download: ${safetyDocUrl(d.slug)}`);
    }
  }
  return lines.join("\n");
}

function renderPartsNeededHtml(
  parts: Map<string, PartLink[]> | undefined,
  fields: Map<string, Field>,
  docs?: SafetyDocRow[]
): string {
  const groups = parts ? groupPartsByVendor(parts, fields) : [];
  const docList = docs ?? [];
  if (groups.length === 0 && docList.length === 0) return "";

  const link = (href: string, label: string) =>
    `<a href="${escapeAttrValue(href)}" style="color: #0B6BCB; text-decoration: underline;">${label}</a>`;

  const blocks: string[] = [];
  groups.forEach((group, gi) => {
    const rows = group.items.map(({ part, question }) => {
      const links: string[] = [];
      if (part.vendor_url) links.push(link(part.vendor_url, "Order"));
      links.push(link(partsDirectoryUrl(part.part_name), "Details"));
      // Printed only when it adds something: "Spill Kit Fully Stocked ->
      // Spill Kit Refill" is worth a line, "Wheel Chocks -> Wheel Chocks" is
      // the same words twice and was appearing in every row.
      const asked =
        question.trim().toLowerCase() === part.part_name.trim().toLowerCase()
          ? ""
          : `<br><span style="color: #6b7280;">for: ${escapeHtml(question)}</span>`;
      const num = part.part_number
        ? `<br><span style="color: #6b7280;">part #${escapeHtml(part.part_number)}</span>`
        : "";
      return (
        `<tr>` +
          `<td style="padding: 8px 0; vertical-align: top; font-size: 14px; color: #1f2937; border-bottom: 1px solid #E5E7EB;">` +
            `<span style="font-weight: 600; color: #0E2745;">${escapeHtml(part.part_name)}</span>` +
            num +
            asked +
            `<br>${links.join(" &middot; ")}` +
          `</td>` +
        `</tr>`
      );
    });

    blocks.push(
      `<p style="margin: 14px 0 2px 0; font-size: 13px; font-weight: 700; color: #0E2745; text-transform: uppercase; letter-spacing: 0.04em;">${escapeHtml(group.vendor ?? "No vendor recorded yet")}</p>`,
      `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border-collapse: collapse; margin: 2px 0 8px 0; background-color: #F9FAFB; border-radius: 6px; padding: 4px 12px;">`,
      `<tbody>`,
      rows.join(""),
      `</tbody>`,
      `</table>`
    );

    const next = groups[gi + 1];
    if (next) {
      // Tinted, because it is an instruction rather than a row -- and because
      // clicking straight past it into the next vendor is the exact mistake
      // the grouping exists to prevent.
      blocks.push(
        `<p style="margin: 0 0 16px 0; padding: 10px 12px; background-color: #FEF3C7; border-radius: 6px; font-size: 13px; color: #78350F; line-height: 1.5;">${escapeHtml(vendorHandoverLine(group.vendor, next.vendor))}</p>`
      );
    }
  });

  const out: string[] = [];

  // STEPS FIRST, then the items they refer to. Instructions printed under a
  // table of links get read after the links have already been clicked. Omitted
  // entirely when there is nothing to order: six ProcureDesk steps above a
  // single document link is noise.
  if (groups.length > 0) {
    out.push(
      `<p style="margin: 20px 0 4px 0; font-size: 14px; font-weight: 600; color: #0E2745;">How to order</p>`,
      `<ol style="margin: 4px 0 16px 0; padding-left: 20px; font-size: 13px; color: #4b5563; line-height: 1.6;">`,
      ORDERING_STEPS.map((step) => `<li>${escapeHtml(step)}</li>`).join(""),
      `</ol>`,
      `<p style="margin: 0 0 4px 0; font-size: 14px; font-weight: 600; color: #0E2745;">Items to order</p>`,
      blocks.join(""),
      `<div style="margin: 0 0 12px 0;"></div>`
    );
  }

  // Programmes are adopted, not bought. Own heading, no vendor column, and the
  // verb is Download rather than Order.
  if (docList.length > 0) {
    out.push(
      `<p style="margin: 14px 0 4px 0; font-size: 14px; font-weight: 600; color: #0E2745;">Documents to put in place</p>`,
      `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border-collapse: collapse; margin: 4px 0 20px 0; background-color: #F9FAFB; border-radius: 6px; padding: 4px 12px;">`,
      `<tbody>`,
      docList
        .map(
          (d) =>
            `<tr><td style="padding: 8px 0; vertical-align: top; font-size: 14px; color: #1f2937; border-bottom: 1px solid #E5E7EB;">` +
            `<span style="font-weight: 600; color: #0E2745;">${escapeHtml(d.title)}</span>` +
            (d.description
              ? `<br><span style="color: #6b7280;">${escapeHtml(d.description)}</span>`
              : "") +
            `<br>${link(safetyDocUrl(d.slug), "Download")}` +
            `</td></tr>`
        )
        .join(""),
      `</tbody>`,
      `</table>`
    );
  }
  return out.join("");
}


/** Attribute-position escaping for a URL we are about to drop into `href="..."`.
 *  `escapeHtml` already covers the quote, but going through a named helper
 *  keeps the intent obvious at the call site. */
function escapeAttrValue(s: string): string {
  return escapeHtml(s);
}

function outcomeTintColor(label: string): string {
  const lower = label.toLowerCase();
  if (/approv/.test(lower)) return "#047857"; // success green
  if (/(den|reject)/.test(lower)) return "#B91C1C"; // danger red
  return "#0E2745"; // splash navy default
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function escapeOutsideSentinels(
  s: string,
  open: string,
  close: string
): string {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    const openIdx = s.indexOf(open, i);
    if (openIdx === -1) {
      out.push(escapeHtml(s.slice(i)));
      break;
    }
    out.push(escapeHtml(s.slice(i, openIdx)));
    const closeIdx = s.indexOf(close, openIdx + open.length);
    if (closeIdx === -1) {
      // Malformed — drop the unmatched sentinel and the rest as text.
      out.push(escapeHtml(s.slice(openIdx + open.length)));
      break;
    }
    out.push(s.slice(openIdx + open.length, closeIdx));
    i = closeIdx + close.length;
  }
  return out.join("");
}

function renderPayloadSummary(
  payload: SubmissionPayload,
  fields: Map<string, Field>
): string {
  const lines: string[] = [];
  for (const [key, field] of fields.entries()) {
    const value = payload[key];
    if (value == null) continue;
    const formatted = resolveDisplayValue(field, value);
    if (!formatted) continue;
    lines.push(`${field.label}: ${formatted}`);
  }
  return lines.join("\n");
}

/**
 * Resolve a payload value to the human-readable text shown to recipients —
 * dropdown / multi option *codes* (`option_3`) become their operator-set
 * *labels* ("Neutral"). Mirrors the CSV export + PDF + wide-table label
 * resolution so the email body matches every other surface. Falls back to
 * `formatScalar` for text / number / file / signature fields (and for any
 * option code that no longer exists on the field).
 */
function resolveDisplayValue(field: Field | undefined, value: unknown): string {
  if (value == null || value === "") return "";
  if (field && field.type === "dropdown") {
    const opt = field.options.find((o) => o.value === String(value));
    return opt?.label ?? formatScalar(value);
  }
  if (field && field.type === "multi") {
    if (Array.isArray(value)) {
      return value
        .map((v) => {
          const opt = field.options.find((o) => o.value === String(v));
          return opt?.label ?? String(v);
        })
        .join(", ");
    }
    const opt = field.options.find((o) => o.value === String(value));
    return opt?.label ?? formatScalar(value);
  }
  return formatScalar(value);
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
