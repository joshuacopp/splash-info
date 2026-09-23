// Field type discriminator. Order intentional — display-only types last.
import type { LookupKeyColumn } from "./lookup-sources.js";

export type FieldType =
  | "name"
  | "email"
  | "phone"
  | "short_text"
  | "long_text"
  | "dropdown"
  | "radio"
  | "multi"
  | "file"
  | "date"
  | "time"
  | "signature"
  | "lookup"
  | "location"
  | "hidden"
  | "heading"      // display-only, no payload
  | "image";       // display-only, no payload

// Common base every field type extends.
export interface FieldBase {
  id: string;          // UUID, stable for the field's lifetime within draft
  type: FieldType;
  key: string;         // stable slug, operator-editable, snake_case, unique within form
  label: string;
  required: boolean;   // ignored on display-only types (heading, image)
  helpText?: string;
  // Brief 129 — when true, the completed-form PDF generator skips this
  // field entirely (label + value omitted). Defaults to false / missing.
  // Operators can flip this on internal-only fields (e.g. private notes,
  // signature scratchpads) that shouldn't appear on emailed PDFs.
  exclude_from_pdf?: boolean;
  // Brief 173 — when true, this field's value is surfaced as a COLUMN on the
  // approvals queue, so an actor can tell tickets apart without opening each
  // one. Up to QUEUE_FIELD_LIMIT fields per form are honoured, in schema
  // order; the rest are dropped rather than erroring. Display-only types
  // (heading, image) carry no payload and are never flaggable.
  //
  // The queue answers "which ticket is this"; the ticket answers "what do I
  // do". Flagging everything collapses the distinction and makes the queue
  // unreadable, which is what the cap is for.
  show_in_queue?: boolean;
  // Brief 176 — when true, this question renders a "Create action item"
  // checkbox at fill time. Ticking it spawns a row in `action_items` for the
  // site to work off after the visit.
  //
  // The flag is builder-time (WHICH questions may spawn one); the checkbox is
  // fill-time (which ones DID). Without the flag every question gets a
  // checkbox, including the site lookup, the signature and the headings, and
  // the checkbox stops meaning anything. Display-only types carry no payload
  // and are never eligible, same rule as show_in_queue.
  action_item_eligible?: boolean;
}

/** Payload key holding the field keys the submitter ticked. ONE reserved key
 *  rather than a `${key}__ai` entry per field: N extra payload keys would
 *  surface as N junk columns in the CSV and the wide submissions table.
 *
 *  Keeping the ticks IN the payload is deliberate -- it makes `action_items` a
 *  materialization rather than the source of truth, so a failed or wrong
 *  creation is always regenerable from the submission. */
export const ACTION_ITEM_PAYLOAD_KEY = "_action_items";

/** Name of the per-field companion input the renderer emits, mirroring the
 *  `${key}_r2` convention the file field already uses. */
export function actionItemInputName(fieldKey: string): string {
  return `${fieldKey}__ai`;
}

// -----------------------------------------------------------------------------
// Display-only types (no payload)
// -----------------------------------------------------------------------------

export interface HeadingField extends FieldBase {
  type: "heading";
  level: "h1" | "h2" | "h3" | "h4";
  text: string;          // distinct from `label` — heading text is the body
}

export interface ImageField extends FieldBase {
  type: "image";
  assetId: string;       // FK to form_assets.id
  altText: string;
  caption?: string;
  maxWidth: "small" | "medium" | "full";   // 25% / 50% / 100% of form width
}

// -----------------------------------------------------------------------------
// Text inputs
// -----------------------------------------------------------------------------

export interface NameField extends FieldBase {
  type: "name";
  maxLength?: number;    // default 120
}

export interface EmailField extends FieldBase {
  type: "email";
  maxLength?: number;    // default 254
}

export interface PhoneField extends FieldBase {
  type: "phone";
  // Phone is always 10-digit US per CLAUDE.md (matches existing forms)
}

export interface ShortTextField extends FieldBase {
  type: "short_text";
  maxLength?: number;    // default 500
  placeholder?: string;
}

export interface LongTextField extends FieldBase {
  type: "long_text";
  maxLength?: number;    // default 10000
  placeholder?: string;
  rows?: number;         // default 4
}

export interface HiddenField extends FieldBase {
  type: "hidden";
  defaultValueFromUrlParam?: string;   // e.g. "source" → captures ?source=email_q2
  defaultValue?: string;               // fallback when URL param absent
}

// -----------------------------------------------------------------------------
// Choice
// -----------------------------------------------------------------------------

export interface DropdownOption {
  value: string;          // canonical, written to payload
  label: string;          // display
}

export interface DropdownField extends FieldBase {
  type: "dropdown";
  options: DropdownOption[];
  placeholder?: string;
}

/**
 * Single choice from a small option set, rendered as a real radio group rather
 * than a select.
 *
 * Payload shape is IDENTICAL to `dropdown` -- one option `value` -- so every
 * consumer (payload validator, PDF, report aggregation, wide table, CSV)
 * treats the two the same. The difference is purely how it is answered: a
 * radio row is one tap where a select is two taps and a scroll, which stops
 * mattering at 3 fields and matters enormously at 47.
 */
export interface RadioField extends FieldBase {
  type: "radio";
  options: DropdownOption[];
  /** "inline" puts the options on one line (Pass / Fail / NA); "vertical"
   *  stacks them. Defaults to vertical -- inline only reads well for short
   *  labels and few options. */
  layout?: "vertical" | "inline";
}

export interface MultiField extends FieldBase {
  type: "multi";
  options: DropdownOption[];
  minSelected?: number;   // default 0
  maxSelected?: number;   // optional cap
}

// -----------------------------------------------------------------------------
// Date / Time — native HTML inputs
// -----------------------------------------------------------------------------

export interface DateField extends FieldBase {
  type: "date";
  minDate?: string;       // YYYY-MM-DD
  maxDate?: string;       // YYYY-MM-DD
  defaultToToday?: boolean;
}

export interface TimeField extends FieldBase {
  type: "time";
  minTime?: string;       // HH:MM
  maxTime?: string;       // HH:MM
}

// -----------------------------------------------------------------------------
// File upload — Brief 92 wires the upload behavior
// -----------------------------------------------------------------------------

export interface FileField extends FieldBase {
  type: "file";
  maxSizeMb?: number;             // default 10, hard ceiling 25 enforced server-side
  allowedMimeTypes?: string[];    // default ["image/*", "application/pdf"]
  allowMultiple?: boolean;        // default false
}

// -----------------------------------------------------------------------------
// Signature — Brief 92 wires the canvas
// -----------------------------------------------------------------------------

export interface SignatureField extends FieldBase {
  type: "signature";
  format: "png" | "svg";   // default "png"
  penColor?: string;       // default "#000000"
  minStrokes?: number;     // default 1
}

// -----------------------------------------------------------------------------
// Location picker — special-case dropdown sourced from pricing_simple
// -----------------------------------------------------------------------------

export interface LocationField extends FieldBase {
  type: "location";
  displayFormat: "name" | "name_and_address" | "site_number";
  // Payload value is always the location_code slug regardless of displayFormat.
}

// -----------------------------------------------------------------------------
// Lookup — Brief 93 wires the resolver
// -----------------------------------------------------------------------------

export type LookupResolutionMode = "prefill_hidden" | "prefill_visible" | "display_only";
export type LookupNullBehavior = "allow_empty" | "block_submit";

export interface LookupField extends FieldBase {
  type: "lookup";
  keyFieldId: string;                      // FK to another field's `id` in this form
  keyColumn: LookupKeyColumn;              // imported from lookup-sources
  sourceTable: "pricing_simple" | "locations";
  sourceColumn: string;                    // must appear in LOOKUP_SOURCES
  resolutionMode: LookupResolutionMode;
  nullBehavior: LookupNullBehavior;
}

// -----------------------------------------------------------------------------
// The full discriminated union.
// -----------------------------------------------------------------------------

export type Field =
  | HeadingField
  | ImageField
  | NameField
  | EmailField
  | PhoneField
  | ShortTextField
  | LongTextField
  | HiddenField
  | DropdownField
  | RadioField
  | MultiField
  | DateField
  | TimeField
  | FileField
  | SignatureField
  | LocationField
  | LookupField;

// Form schema = ordered list of fields. Order is implicit (array index).
// Brief 120 adds an optional `workflow` block — forms without a workflow
// behave as today (submit → no stages, terminal). Workflows are versioned
// alongside the schema: a submission against v2 follows v2's workflow
// forever, even if v3 changes the stages.
export interface FormSchema {
  fields: Field[];
  workflow?: FormWorkflow;
}

// -----------------------------------------------------------------------------
// Workflow (Brief 120) — per-stage approval flows on a form.
// -----------------------------------------------------------------------------

/**
 * Where the worker resolves the email list of operators allowed to advance
 * a stage. Brief 120 ships three sources; a `department` source is flagged
 * for v2 (Brief 120.5) once the `departments` table design lands.
 *
 * - `site_role` reads `am_email` / `rm_email` / `site_email` from
 *   `pricing_simple` via `getLocationContactInfo` (Brief 101 helper).
 *   Requires the submission's payload to carry a `location` field
 *   (or any lookup field resolving to a `pricing_simple.location_code`).
 * - `static_emails` is a form-builder-configured allow-list. Single
 *   approver is the common case; multi-element supports committees.
 * - `payload_field` reads the approver email from a field on the form
 *   (operator picks an approver at submission time).
 */
export type ApproverSource =
  | { type: "site_role"; role: "am_email" | "rm_email" | "site_email" }
  | { type: "static_emails"; emails: string[] }
  | { type: "payload_field"; field_key: string };

/**
 * Per-transition requirements gating the action button. Combinations
 * supported: requires={signature:true, note:true} means the modal renders
 * both inputs and the worker rejects 400 when either is missing.
 *
 * v2 candidates flagged inline below; this brief ships only the three
 * boolean knobs.
 */
export interface WorkflowTransitionRequirements {
  signature?: boolean;
  typed_name?: boolean;
  note?: boolean;
  // v2: amount_field?: string, custom_field?: { key, label, type }
}

/**
 * A single outgoing edge from a stage. The button label is what the
 * operator sees; the `to` references another stage's `id`.
 */
export interface WorkflowTransition {
  to: string;
  label: string;
  requires?: WorkflowTransitionRequirements;
}

/**
 * A stage in the workflow. Terminal stages (e.g. "approved", "denied")
 * carry an empty `transitions` array.
 *
 * `_uiKey` is a Brief 123 builder-side artifact: a stable nanoid used as the
 * React key for the stage row so the editor input does NOT remount when
 * the semantic `stage.id` is renamed. The worker's Zod schemas don't
 * declare this field, so it's stripped on parse before the row hits the
 * `form_versions.schema` JSONB. Defense in depth: `apps/web` strips it in
 * `saveDraftAction` before sending. Initial load regenerates it.
 */
export interface WorkflowStage {
  id: string;
  label: string;
  // Brief 123 — terminal stages omit `approver_source` entirely. The
  // strict publish-time validator pairs a missing `approver_source` with
  // an empty `transitions` array (terminal) or flags it as broken
  // (transitions exist but nobody can advance).
  approver_source?: ApproverSource;
  transitions: WorkflowTransition[];
  // Brief 125 — kind hint disambiguates the Workflow tab's UI buckets
  // (steps vs outcomes) for stages mid-build where the predicate-based
  // detection (no approver + no transitions = outcome) is ambiguous.
  // Brief 127 added the `"email"` kind for email-step stages. Legacy
  // values `"step"` (Brief 125 seed) and `"approval"` are both treated
  // as approval-kind by the predicate fallback. When omitted, the
  // predicate is the source of truth: approver_source present + at
  // least one transition → approval; no approver + no transitions →
  // outcome; recipients present → email.
  kind?: "step" | "approval" | "email" | "outcome";
  // Brief 125 — UI tint for outcomes (success / danger / warning / info /
  // neutral). Optional; defaults to "neutral" at render time. Steps
  // ignore this field.
  tint?: "success" | "danger" | "warning" | "info" | "neutral";
  // Brief 127 — email-step-only fields. The strict publish-time
  // validator refuses to publish an email stage with empty `recipients`
  // OR with `transitions.length !== 1` (email stages auto-advance and
  // need exactly one outgoing edge — no Approve/Deny branching).
  // Recipients accept the same `ApproverSource` shape as the approval-
  // step `approver_source` — operators can pick a payload field, a
  // site_role, or a static email list as the To: address. Multiple
  // recipients are expressed as multiple entries; the worker calls
  // `resolveApproverEmails` once per entry and unions the result.
  recipients?: ApproverSource[];
  subject_template?: string;
  body_template?: string;
  // Brief 129 — email-step-only flag. When true, the email step's enqueue
  // path generates / reuses a PDF of the completed form (built from the
  // submission's payload + workflow history; respecting per-field
  // `exclude_from_pdf`) and attaches it to every enqueued outbound_email
  // row. Reused across multiple email steps in the same cascade — second
  // pass reads the just-written R2 object instead of regenerating. Defaults
  // to false / missing.
  attach_pdf?: boolean;
  _uiKey?: string;
}

/**
 * Brief 125 — per-workflow notification opt-ins.
 *
 * @deprecated Brief 127 — the booleans on this block no longer drive
 * any webhook fire. The block stays in the schema for back-compat so
 * existing form_versions rows still validate; new forms should express
 * the same use cases as explicit `kind: "email"` workflow stages,
 * inserted via the Workflow tab's Quick patterns popover.
 *
 * The cron-driven daily approval digest (Brief 121,
 * `FORMS_APPROVAL_DIGEST_WEBHOOK_URL`) is independent of this block
 * and continues to fire as before.
 */
export interface WorkflowNotifications {
  notify_approver_on_assignment?: boolean;
  notify_submitter_on_outcome?: boolean;
  notify_approvers_on_outcome?: boolean;
  // v2: attach_pdf_on_outcome?: boolean;
}

/**
 * Full workflow block. `default_stage` must reference one of `stages[].id`
 * — validated by Zod at draft-save AND publish time.
 *
 * Brief 125 — optional `notifications` block controls the per-step
 * assignment + per-outcome notification emails the worker fires via
 * `FORMS_OUTCOME_NOTIFICATION_WEBHOOK_URL`.
 */
export interface FormWorkflow {
  default_stage: string;
  stages: WorkflowStage[];
  notifications?: WorkflowNotifications;
}

/**
 * History entry appended to `form_submissions.workflow_history` on every
 * successful transition. Schema lives here so apps/web and the worker
 * share the row shape.
 */
export interface WorkflowHistoryEntry {
  from: string;
  to: string;
  actor_email: string;
  actor_session_role: string | null;
  note: string | null;
  signature_r2_key: string | null;
  typed_name: string | null;
  at: string;
}

export interface FormVersion {
  id: string;
  formId: string;
  versionNumber: number;
  schema: FormSchema;
  isDraft: boolean;
  publishedAt: string | null;
  publishedBy: string | null;
}

export interface FormMeta {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  audience: "public" | "internal" | "link-only";
  status: "draft" | "published" | "archived";
  currentVersionId: string | null;
  draftVersionId: string | null;
  notifyWebhook: boolean;
  successMessage: string | null;
  turnstileRequired: boolean;
}

// Submission payload is keyed by field.key. Per-field value shape varies
// by field type (string for text fields, string[] for multi, object for
// file/signature, etc. — Brief 91 narrows these via Zod).
export type SubmissionPayload = Record<string, unknown>;

export interface FormSubmission {
  id: string;
  formId: string;
  formVersionId: string;
  payload: SubmissionPayload;
  submitterKind: "authenticated" | "anonymous";
  submitterUserId: string | null;
  submitterEmail: string | null;
  submitterIp: string | null;
  submittedAt: string;
  status: "new" | "in_progress" | "closed";
  splashNotes: string | null;
  // Brief 120 — present only when the submission's version has a workflow.
  workflowStage: string | null;
  workflowHistory: WorkflowHistoryEntry[];
  currentApproverEmails: string[];
}

// Location options pre-baked into the Location field's <select> at render time.
// Sourced from pricing_simple via the worker's `getLocationOptionsFromPricingSimple`
// helper. Brief 90 inlines these into the rendered HTML — no client-side fetch.
export interface LocationOption {
  code: string;     // pricing_simple.location_code (slug)
  pretty: string;   // pricing_simple.location_pretty
  address: string;  // pricing_simple.address
  site: string;     // pricing_simple.site (3-digit text)
}
