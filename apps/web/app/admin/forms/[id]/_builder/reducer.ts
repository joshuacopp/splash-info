// useReducer state for the form builder canvas + inspector.
//
// Per planning Decision 3, no auto-save: dirty flag drives Save Draft button
// state and the beforeunload warning. Per Decision 4, field IDs and key
// suffixes use nanoid(8 / 6) for stability across renames.
//
// IMPORTANT: keys MUST match /^[a-z][a-z0-9_]*$/ (validated by KeyEditor +
// the worker-side Zod schema). Default `nanoid()` uses a mixed-case alphabet
// (A-Za-z0-9_-) — using it directly produces keys like `name_qeZpLN` that
// FAIL the regex. We use `customAlphabet` with lowercase-alphanum only for
// the suffix. Field `id` can stay mixed-case (it's an internal handle, not
// a payload key — never validated against the snake_case rule).

import { customAlphabet, nanoid } from "nanoid";
import type {
  ApproverSource,
  Field,
  FieldType,
  FormWorkflow,
  WorkflowNotifications,
  WorkflowStage,
  WorkflowTransition
} from "@splash/forms-schema";

import { defaultConfigFor } from "../_field-types";

const lowerNanoid = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 6);

// Location-scoping field key. Must match the worker's SCOPE_FIELD_KEY
// (forms-worker/src/admin/forms.ts) exactly — publish-time auto-inject
// detects an operator-added field by this key and stamps it as the form's
// `scope_location_field_key` instead of appending a duplicate. Exported so
// the builder can offer a one-click "Site number" preset and warn when an
// internal / link-only form is missing it.
export const SCOPE_FIELD_KEY = "site_number";

/** Does this field set contain the location-scoping site-number field? */
export function hasScopeField(fields: Field[]): boolean {
  return fields.some((f) => f.key === SCOPE_FIELD_KEY);
}

// Brief 123 — _uiKey is a stable nanoid attached to each WorkflowStage in
// builder state so the React key for the stage row does NOT change when
// the semantic `stage.id` is renamed. Without this, the StageEditor row
// unmounts on every keystroke (key change) and the input loses focus.
// The Zod schemas in `@splash/forms-schema` don't declare `_uiKey`, so
// it's stripped on parse before the row hits the `form_versions.schema`
// JSONB.
function ensureUiKey(stage: WorkflowStage): WorkflowStage {
  return stage._uiKey ? stage : { ...stage, _uiKey: nanoid(8) };
}

function ensureWorkflowUiKeys(
  workflow: FormWorkflow | null
): FormWorkflow | null {
  if (!workflow) return null;
  return {
    ...workflow,
    stages: workflow.stages.map(ensureUiKey)
  };
}

// Strips builder-only artifacts (e.g. `_uiKey`) from the workflow before
// the schema is sent to the worker's PATCH /draft endpoint. Defense in
// depth: the worker's Zod parse also strips unknown keys.
export function stripBuilderArtifacts(
  workflow: FormWorkflow | null
): FormWorkflow | null {
  if (!workflow) return null;
  // Brief 127 — also drop the Brief 125 deprecated `notifications` block
  // when present (it's no-ops now; saving it back round-trips the same
  // legacy data, which is harmless but adds noise to schema JSONB).
  return {
    default_stage: workflow.default_stage,
    stages: workflow.stages.map(({ _uiKey: _ignored, ...rest }) => rest),
    ...(workflow.notifications ? { notifications: workflow.notifications } : {})
  };
}

const MOVE_TO_LABEL_RE = /^Move to /;

function isDefaultishTransitionLabel(label: string): boolean {
  if (!label) return true;
  if (MOVE_TO_LABEL_RE.test(label)) return true;
  // Tolerate legacy seed value from Brief 120.
  if (label === "Advance") return true;
  return false;
}

export interface FormMetaState {
  title: string;
  description: string | null;
  audience: "public" | "internal" | "link-only";
  notifyWebhook: boolean;
  successMessage: string | null;
  turnstileRequired: boolean;
  slug: string;
}

export interface BuilderState {
  fields: Field[];
  formMeta: FormMetaState;
  // Brief 120 — workflow is optional. null = "no workflow on this form".
  workflow: FormWorkflow | null;
  selectedFieldId: string | null;
  dirty: boolean;
}

export type BuilderAction =
  | { type: "add_field"; fieldType: FieldType }
  // Insert the preconfigured location-scoping site-number field (key
  // SCOPE_FIELD_KEY). Idempotent: selects the existing one if already present.
  | { type: "add_scope_field" }
  | { type: "remove_field"; fieldId: string }
  | { type: "duplicate_field"; fieldId: string }
  | { type: "reorder_field"; fields: Field[] }
  | { type: "update_field_config"; fieldId: string; patch: Partial<Field> }
  | { type: "update_form_meta"; patch: Partial<FormMetaState> }
  | { type: "select_field"; fieldId: string }
  | { type: "clear_selection" }
  | { type: "mark_clean" }
  // Brief 120 — workflow edit actions.
  | { type: "workflow_enable" }
  | { type: "workflow_disable" }
  | { type: "workflow_set_default_stage"; stageId: string }
  | { type: "workflow_add_stage" }
  | { type: "workflow_remove_stage"; stageId: string }
  | { type: "workflow_move_stage"; stageId: string; direction: -1 | 1 }
  | {
      type: "workflow_update_stage";
      stageId: string;
      patch: Partial<WorkflowStage>;
    }
  | {
      type: "workflow_set_approver_source";
      stageId: string;
      source: ApproverSource;
    }
  // Brief 123 — terminal stages omit approver_source entirely; this
  // clears it.
  | { type: "workflow_clear_approver_source"; stageId: string }
  | { type: "workflow_add_transition"; stageId: string }
  | {
      type: "workflow_update_transition";
      stageId: string;
      index: number;
      patch: Partial<WorkflowTransition>;
    }
  | { type: "workflow_remove_transition"; stageId: string; index: number }
  // Brief 123 — rename a stage and cascade-update default_stage + every
  // transition.to that referenced the old id, in one dispatch so the
  // editor renders one consistent state, not three intermediate ones.
  | { type: "workflow_rename_stage"; oldId: string; newId: string }
  // Brief 125 — user-language workflow editor dispatches.
  | { type: "workflow_add_step" }
  | { type: "workflow_duplicate_step"; stepId: string }
  | { type: "workflow_remove_step"; stepId: string }
  | { type: "workflow_reorder_steps"; fromIndex: number; toIndex: number }
  | { type: "workflow_update_step_label"; stepId: string; label: string }
  | {
      type: "workflow_set_step_approver";
      stepId: string;
      source: ApproverSource | undefined;
    }
  | { type: "workflow_add_outcome" }
  | { type: "workflow_remove_outcome"; outcomeId: string }
  | {
      type: "workflow_update_outcome";
      outcomeId: string;
      patch: Partial<Pick<WorkflowStage, "label" | "tint">>;
    }
  | { type: "workflow_set_notifications"; patch: Partial<WorkflowNotifications> }
  // Brief 127 — email-step actions.
  | { type: "workflow_add_email_step" }
  | {
      type: "workflow_update_email_step";
      stepId: string;
      patch: Partial<
        Pick<
          WorkflowStage,
          "label" | "subject_template" | "body_template" | "attach_pdf"
        >
      >;
    }
  | {
      type: "workflow_set_email_recipients";
      stepId: string;
      recipients: ApproverSource[];
    }
  // Brief 131 — inline "+ Create new email step here" in an approval
  // action's Then-go-to dropdown. Creates a new email step, wires the
  // approval action's `to` at it, and routes the new email step's
  // single auto-advance transition at the first available outcome
  // (with a keyword heuristic against the originating action's label
  // to pick approved-tinted vs denied-tinted when both exist).
  | {
      type: "workflow_add_email_step_from_action";
      stepId: string;
      transitionIndex: number;
    }
  // Brief 127 — Quick patterns popover dispatches a single bulk
  // workflow replacement (rather than a chain of individual reducer
  // events) so the result is atomic in the dirty-flag + undo sense.
  | { type: "workflow_apply_pattern"; pattern: QuickPattern };

export interface BuilderInitial {
  form: {
    slug: string;
    title: string;
    description: string | null;
    audience: "public" | "internal" | "link-only";
    notifyWebhook: boolean;
    successMessage: string | null;
    turnstileRequired: boolean;
  };
  draftSchema: { fields: Field[]; workflow?: FormWorkflow };
}

export function initialState(initial: BuilderInitial): BuilderState {
  return {
    fields: initial.draftSchema.fields,
    workflow: ensureWorkflowUiKeys(initial.draftSchema.workflow ?? null),
    formMeta: {
      title: initial.form.title,
      description: initial.form.description,
      audience: initial.form.audience,
      notifyWebhook: initial.form.notifyWebhook,
      successMessage: initial.form.successMessage,
      turnstileRequired: initial.form.turnstileRequired,
      slug: initial.form.slug
    },
    selectedFieldId: null,
    dirty: false
  };
}

function makeBlankStage(): WorkflowStage {
  const id = `stage_${lowerNanoid()}`;
  return {
    id,
    label: id,
    approver_source: { type: "static_emails", emails: [] },
    transitions: [],
    _uiKey: nanoid(8)
  };
}

// Brief 132 — picks an `approver_source` for the seeded approval step
// based on the form's current fields, so workflow_enable on a
// lookup-keyed form (no Location field) doesn't write a `site_role`
// shape the worker resolver can't handle. Mirrors `ApproverPicker`'s
// `detectFromFields` priority order: lookup `rm_email` → any lookup
// `*_email` → email field → site_role when a Location field exists →
// empty static_emails (operator must pick before publishing; the strict
// publish-time validator would reject it).
function pickSeedApproverSource(fields: Field[]): ApproverSource {
  for (const f of fields) {
    if (f.type === "lookup" && f.sourceColumn === "rm_email") {
      return { type: "payload_field", field_key: f.key };
    }
  }
  for (const f of fields) {
    if (
      f.type === "lookup" &&
      (f.sourceColumn === "am_email" ||
        f.sourceColumn === "site_email" ||
        (typeof f.sourceColumn === "string" &&
          f.sourceColumn.endsWith("_email")))
    ) {
      return { type: "payload_field", field_key: f.key };
    }
  }
  for (const f of fields) {
    if (f.type === "email") {
      return { type: "payload_field", field_key: f.key };
    }
  }
  if (fields.some((f) => f.type === "location")) {
    return { type: "site_role", role: "rm_email" };
  }
  return { type: "static_emails", emails: [] };
}

// Brief 123 / 125 — auto-seed three stages on workflow enable so operators
// land in a working starter template. Brief 125 stamps `kind` for the
// outcomes ("approved" / "denied" are terminal outcomes, not stages with
// "no approver and no transitions") so the new Workflow tab can bucket
// stages into steps vs outcomes cleanly even when the user is mid-edit.
// Brief 132 — accepts `fields` so the seeded approval step's
// `approver_source` matches the form's actual shape (lookup-keyed forms
// get `payload_field`; Location-bearing forms get `site_role`; bare forms
// get an empty `static_emails` the operator must pick before publishing).
function makeWorkflowSeed(fields: Field[]): FormWorkflow {
  const approval: WorkflowStage = {
    id: "approval",
    label: "Approval",
    approver_source: pickSeedApproverSource(fields),
    transitions: [
      { to: "approved", label: "Approve" },
      { to: "denied", label: "Deny" }
    ],
    kind: "step",
    _uiKey: nanoid(8)
  };
  const approved: WorkflowStage = {
    id: "approved",
    label: "Approved",
    transitions: [],
    kind: "outcome",
    tint: "success",
    _uiKey: nanoid(8)
  };
  const denied: WorkflowStage = {
    id: "denied",
    label: "Denied",
    transitions: [],
    kind: "outcome",
    tint: "danger",
    _uiKey: nanoid(8)
  };
  return {
    default_stage: approval.id,
    stages: [approval, approved, denied],
    notifications: {
      notify_approver_on_assignment: true,
      notify_submitter_on_outcome: true,
      notify_approvers_on_outcome: false
    }
  };
}

// Brief 125 / 127 — predicate-based detection of a stage's UI bucket.
// `kind` hint wins when present; otherwise: recipients present →
// email; approver_source present → approval; no approver + no
// transitions → outcome; everything else (orphan stages) falls into
// approval so the operator can fix them in place.
export function stageIsOutcome(stage: WorkflowStage): boolean {
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

export function stageIsEmail(stage: WorkflowStage): boolean {
  if (stage.kind === "email") return true;
  if (stage.kind === "outcome") return false;
  // Predicate fallback for un-kinded legacy stages: never email
  // (Brief 125 + earlier never produced email stages).
  return false;
}

export function stageIsApproval(stage: WorkflowStage): boolean {
  return !stageIsOutcome(stage) && !stageIsEmail(stage);
}

function makeStepSeed(stepCount: number): WorkflowStage {
  const id = `step_${lowerNanoid()}`;
  return {
    id,
    label: stepCount === 0 ? "Approval" : `Step ${stepCount + 1}`,
    approver_source: { type: "static_emails", emails: [] },
    transitions: [],
    kind: "step",
    _uiKey: nanoid(8)
  };
}

function makeOutcomeSeed(label: string, tint: WorkflowStage["tint"] = "neutral"): WorkflowStage {
  return {
    id: `outcome_${lowerNanoid()}`,
    label,
    transitions: [],
    kind: "outcome",
    tint,
    _uiKey: nanoid(8)
  };
}

// Brief 127 — default body template auto-populated for new email steps.
// Operator can replace with explicit `{field.label}` placeholders for
// selective fields, or rewrite entirely.
const DEFAULT_EMAIL_BODY_TEMPLATE = `Hi,

A new {form.title} submission was received.

{payload.summary}

Open in Splash: {submission.url}

— Splash team`;

const DEFAULT_EMAIL_SUBJECT_TEMPLATE = "New {form.title} submission";

function makeEmailStepSeed(stepCount: number): WorkflowStage {
  const id = `email_${lowerNanoid()}`;
  return {
    id,
    label: stepCount === 0 ? "Email" : `Email step ${stepCount + 1}`,
    transitions: [{ to: "", label: "" }],
    kind: "email",
    recipients: [],
    subject_template: DEFAULT_EMAIL_SUBJECT_TEMPLATE,
    body_template: DEFAULT_EMAIL_BODY_TEMPLATE,
    _uiKey: nanoid(8)
  };
}

// Brief 127 — Quick patterns produce normal email-step entries. The
// pure-UI sugar inserts them at the appropriate position; everything
// downstream treats them as ordinary email stages.
export type QuickPattern =
  | "email_submitter_on_outcome"
  | "email_approver_when_assigned"
  | "email_rm_on_submission"
  | "email_specific_person_on_submission"
  // Brief 131 — composite pattern: for each approval step, finds the
  // Approve and Deny actions, builds two new email steps (approval +
  // denial, both to submitter), and rewires the actions through the
  // email steps before reaching the matching outcome.
  | "email_submitter_on_approve_and_deny";

function findFirstRmLikeLookupField(fields: Field[]): Field | undefined {
  for (const f of fields) {
    if (f.type === "lookup" && f.sourceColumn === "rm_email") return f;
  }
  return undefined;
}

function applyQuickPattern(
  workflow: FormWorkflow,
  fields: Field[],
  pattern: QuickPattern
): FormWorkflow {
  switch (pattern) {
    case "email_submitter_on_outcome": {
      // For each outcome, insert an email step right before it. The
      // outcome's existing inbound transitions get rewritten to point
      // at the new email step; the email step's single transition
      // points at the original outcome.
      const outcomes = workflow.stages.filter((s) => stageIsOutcome(s));
      if (outcomes.length === 0) return workflow;
      let stages = [...workflow.stages];
      for (const outcome of outcomes) {
        const emailStep: WorkflowStage = {
          id: `email_${lowerNanoid()}`,
          label: `Email submitter (${outcome.label})`,
          transitions: [{ to: outcome.id, label: `Continue to ${outcome.label}` }],
          kind: "email",
          recipients: [{ type: "payload_field", field_key: "submitter.email" }],
          subject_template: `Your {form.title} submission was ${outcome.label}`,
          body_template: `Hi,

Your {form.title} submission was ${outcome.label} on {outcome.reached_at}.

{payload.summary}

— Splash team`,
          // Brief 129 — submitters typically want the PDF.
          attach_pdf: true,
          _uiKey: nanoid(8)
        };
        // Rewrite every transition that targeted the outcome to target
        // the new email step.
        stages = stages.map((s) => ({
          ...s,
          transitions: s.transitions.map((t) =>
            t.to === outcome.id ? { ...t, to: emailStep.id } : t
          )
        }));
        // Insert the email step just before the outcome in the stages
        // array (visual order).
        const outcomeIdx = stages.findIndex((s) => s.id === outcome.id);
        if (outcomeIdx >= 0) {
          stages.splice(outcomeIdx, 0, emailStep);
        } else {
          stages.push(emailStep);
        }
      }
      return { ...workflow, stages };
    }
    case "email_approver_when_assigned": {
      // For each approval step, insert an email step right before it.
      const approvals = workflow.stages.filter((s) => stageIsApproval(s));
      if (approvals.length === 0) return workflow;
      let stages = [...workflow.stages];
      const newDefault = (() => {
        // If the workflow's default_stage is an approval, we want the
        // pattern's freshly-inserted email step to become the new
        // entry point so the assignment notification fires before the
        // approver lands on their step.
        return workflow.default_stage;
      })();
      let defaultStage = newDefault;
      for (const approval of approvals) {
        const emailStep: WorkflowStage = {
          id: `email_${lowerNanoid()}`,
          label: `Email approver (${approval.label})`,
          transitions: [{ to: approval.id, label: `Continue to ${approval.label}` }],
          kind: "email",
          recipients: approval.approver_source ? [approval.approver_source] : [],
          subject_template: `You have a new {form.title} item to review`,
          body_template: `Hi,

You have a new {form.title} item waiting for your review at the "${approval.label}" step.

{payload.summary}

Review here: {submission.url}

— Splash team`,
          // Brief 129 — approvers click through to the review page; the
          // assignment email shouldn't ship a PDF before they act.
          attach_pdf: false,
          _uiKey: nanoid(8)
        };
        // Rewrite every transition that targeted this approval step
        // (rare in practice — most workflows have a single entry into
        // each approval).
        stages = stages.map((s) => ({
          ...s,
          transitions: s.transitions.map((t) =>
            t.to === approval.id ? { ...t, to: emailStep.id } : t
          )
        }));
        if (defaultStage === approval.id) defaultStage = emailStep.id;
        const approvalIdx = stages.findIndex((s) => s.id === approval.id);
        if (approvalIdx >= 0) {
          stages.splice(approvalIdx, 0, emailStep);
        } else {
          stages.push(emailStep);
        }
      }
      return { ...workflow, default_stage: defaultStage, stages };
    }
    case "email_rm_on_submission": {
      // Single email step inserted right after Form Submitted, before
      // the existing default stage. Brief 132 — when a matching RM
      // lookup field exists, save `payload_field` (the lookup has
      // already resolved the email at submit time, so its payload
      // value IS the email). Fall back to a location-shape `site_role`
      // when a Location field is present; else empty (operator must
      // pick before publishing).
      const rmLookup = findFirstRmLikeLookupField(fields);
      const recipients: ApproverSource[] = rmLookup
        ? [{ type: "payload_field", field_key: rmLookup.key }]
        : fields.some((f) => f.type === "location")
          ? [{ type: "site_role", role: "rm_email" }]
          : [];
      const prevDefault = workflow.default_stage;
      const emailStep: WorkflowStage = {
        id: `email_${lowerNanoid()}`,
        label: "Email RM",
        transitions: [{ to: prevDefault, label: "Continue" }],
        kind: "email",
        recipients,
        subject_template: "New {form.title} submission for review",
        body_template: DEFAULT_EMAIL_BODY_TEMPLATE,
        _uiKey: nanoid(8)
      };
      return {
        ...workflow,
        default_stage: emailStep.id,
        stages: [emailStep, ...workflow.stages]
      };
    }
    case "email_specific_person_on_submission": {
      const prevDefault = workflow.default_stage;
      const emailStep: WorkflowStage = {
        id: `email_${lowerNanoid()}`,
        label: "Email specific person",
        transitions: [{ to: prevDefault, label: "Continue" }],
        kind: "email",
        recipients: [],
        subject_template: "New {form.title} submission",
        body_template: DEFAULT_EMAIL_BODY_TEMPLATE,
        _uiKey: nanoid(8)
      };
      return {
        ...workflow,
        default_stage: emailStep.id,
        stages: [emailStep, ...workflow.stages]
      };
    }
    case "email_submitter_on_approve_and_deny": {
      // Find each approval step that has an Approve-shaped action AND
      // a Deny-shaped action, then rewire both through email steps.
      const approvals = workflow.stages.filter((s) => stageIsApproval(s));
      if (approvals.length === 0) return workflow;
      const outcomes = workflow.stages.filter((s) => stageIsOutcome(s));
      let stages = [...workflow.stages];

      for (const approval of approvals) {
        // Locate the approve / deny transitions on this approval step.
        const approveTxIdx = approval.transitions.findIndex((t) =>
          /\bapprov|\baccept|\bok\b|\byes\b|\bconfirm/.test(t.label.toLowerCase())
        );
        const denyTxIdx = approval.transitions.findIndex((t) =>
          /\bden|\breject|\bdecline/.test(t.label.toLowerCase())
        );
        if (approveTxIdx < 0 && denyTxIdx < 0) continue;

        const approveTx =
          approveTxIdx >= 0 ? approval.transitions[approveTxIdx] : undefined;
        const denyTx = denyTxIdx >= 0 ? approval.transitions[denyTxIdx] : undefined;

        const approvedOutcome =
          outcomes.find(
            (o) => o.tint === "success" || /\bapprov/.test(o.label.toLowerCase())
          ) ?? outcomes[0];
        const deniedOutcome =
          outcomes.find(
            (o) =>
              o.tint === "danger" ||
              /\bden|\breject|\bdecline/.test(o.label.toLowerCase())
          ) ?? outcomes[outcomes.length - 1];

        let approvalEmailStep: WorkflowStage | null = null;
        let denialEmailStep: WorkflowStage | null = null;

        if (approveTx && approvedOutcome) {
          approvalEmailStep = {
            id: `email_${lowerNanoid()}`,
            label: `${approvedOutcome.label} email`,
            transitions: [
              {
                to: approvedOutcome.id,
                label: `Continue to ${approvedOutcome.label}`
              }
            ],
            kind: "email",
            recipients: [
              { type: "payload_field", field_key: "submitter.email" }
            ],
            subject_template: `Your {form.title} submission was ${approvedOutcome.label}`,
            body_template: `Hi {submitter.name},

Your {form.title} submission was ${approvedOutcome.label} on {outcome.reached_at}.

{payload.summary}

— Splash team`,
            attach_pdf: true,
            _uiKey: nanoid(8)
          };
        }

        if (denyTx && deniedOutcome) {
          denialEmailStep = {
            id: `email_${lowerNanoid()}`,
            label: `${deniedOutcome.label} email`,
            transitions: [
              {
                to: deniedOutcome.id,
                label: `Continue to ${deniedOutcome.label}`
              }
            ],
            kind: "email",
            recipients: [
              { type: "payload_field", field_key: "submitter.email" }
            ],
            subject_template: `Your {form.title} submission was ${deniedOutcome.label}`,
            body_template: `Hi {submitter.name},

Your {form.title} submission was ${deniedOutcome.label} on {outcome.reached_at}.

{payload.summary}

— Splash team`,
            // Brief 131 — denial doesn't attach the PDF by default
            // (matches the operator-discussed convention).
            attach_pdf: false,
            _uiKey: nanoid(8)
          };
        }

        // Rewire the origin approval's transitions and splice the new
        // email steps right after the approval step in document order.
        stages = stages.map((s) => {
          if (s.id !== approval.id) return s;
          return {
            ...s,
            transitions: s.transitions.map((t, i) => {
              if (i === approveTxIdx && approvalEmailStep) {
                return { ...t, to: approvalEmailStep.id };
              }
              if (i === denyTxIdx && denialEmailStep) {
                return { ...t, to: denialEmailStep.id };
              }
              return t;
            })
          };
        });
        const approvalIdx = stages.findIndex((s) => s.id === approval.id);
        const toInsert = [approvalEmailStep, denialEmailStep].filter(
          (x): x is WorkflowStage => x !== null
        );
        if (approvalIdx >= 0 && toInsert.length > 0) {
          stages.splice(approvalIdx + 1, 0, ...toInsert);
        }
      }

      return { ...workflow, stages };
    }
  }
}

export function reducer(
  state: BuilderState,
  action: BuilderAction
): BuilderState {
  switch (action.type) {
    case "add_field": {
      const config = defaultConfigFor(action.fieldType);
      const newField = {
        ...config,
        id: nanoid(8),
        key: `${action.fieldType}_${lowerNanoid()}`
      } as Field;
      return {
        ...state,
        fields: [...state.fields, newField],
        selectedFieldId: newField.id,
        dirty: true
      };
    }
    case "add_scope_field": {
      // Don't duplicate — if the site-number field already exists, just
      // select it. This mirrors the worker's publish-time guard.
      const existing = state.fields.find((f) => f.key === SCOPE_FIELD_KEY);
      if (existing) {
        return { ...state, selectedFieldId: existing.id };
      }
      const scopeField = {
        type: "short_text",
        label: "Site Number",
        required: true,
        maxLength: 3,
        placeholder: "ie 156",
        helpText: "Staff: enter your 3-digit site number.",
        id: nanoid(8),
        key: SCOPE_FIELD_KEY
      } as Field;
      return {
        ...state,
        fields: [...state.fields, scopeField],
        selectedFieldId: scopeField.id,
        dirty: true
      };
    }
    case "remove_field":
      return {
        ...state,
        fields: state.fields.filter((f) => f.id !== action.fieldId),
        selectedFieldId:
          state.selectedFieldId === action.fieldId ? null : state.selectedFieldId,
        dirty: true
      };
    case "duplicate_field": {
      const idx = state.fields.findIndex((f) => f.id === action.fieldId);
      if (idx < 0) return state;
      const orig = state.fields[idx];
      if (!orig) return state;
      const dup = {
        ...orig,
        id: nanoid(8),
        key: `${orig.key}_copy`
      } as Field;
      const copy = [...state.fields];
      copy.splice(idx + 1, 0, dup);
      return {
        ...state,
        fields: copy,
        selectedFieldId: dup.id,
        dirty: true
      };
    }
    case "reorder_field":
      return { ...state, fields: action.fields, dirty: true };
    case "update_field_config":
      return {
        ...state,
        fields: state.fields.map((f) =>
          f.id === action.fieldId
            ? ({ ...f, ...action.patch } as Field)
            : f
        ),
        dirty: true
      };
    case "update_form_meta":
      return {
        ...state,
        formMeta: { ...state.formMeta, ...action.patch },
        dirty: true
      };
    case "select_field":
      return { ...state, selectedFieldId: action.fieldId };
    case "clear_selection":
      return { ...state, selectedFieldId: null };
    case "mark_clean":
      return { ...state, dirty: false };
    case "workflow_enable": {
      if (state.workflow) return state;
      return {
        ...state,
        workflow: makeWorkflowSeed(state.fields),
        dirty: true
      };
    }
    case "workflow_disable":
      return { ...state, workflow: null, dirty: true };
    case "workflow_set_default_stage": {
      if (!state.workflow) return state;
      return {
        ...state,
        workflow: { ...state.workflow, default_stage: action.stageId },
        dirty: true
      };
    }
    case "workflow_add_stage": {
      const stage = makeBlankStage();
      const workflow = state.workflow ?? {
        default_stage: stage.id,
        stages: [] as WorkflowStage[]
      };
      const nextStages = [...workflow.stages, stage];
      const nextDefault =
        workflow.stages.length === 0 ? stage.id : workflow.default_stage;
      return {
        ...state,
        workflow: { default_stage: nextDefault, stages: nextStages },
        dirty: true
      };
    }
    case "workflow_remove_stage": {
      if (!state.workflow) return state;
      const remaining = state.workflow.stages.filter(
        (s) => s.id !== action.stageId
      );
      // Strip transitions targeting the removed stage so the schema stays
      // self-consistent — the strict publish-time validator would 422 on a
      // dangling transition.to otherwise.
      const cleaned = remaining.map((s) => ({
        ...s,
        transitions: s.transitions.filter((t) => t.to !== action.stageId)
      }));
      const firstId = cleaned[0]?.id;
      const nextDefault =
        state.workflow.default_stage === action.stageId
          ? firstId ?? ""
          : state.workflow.default_stage;
      return {
        ...state,
        workflow: { default_stage: nextDefault, stages: cleaned },
        dirty: true
      };
    }
    case "workflow_move_stage": {
      if (!state.workflow) return state;
      const idx = state.workflow.stages.findIndex(
        (s) => s.id === action.stageId
      );
      if (idx < 0) return state;
      const newIdx = idx + action.direction;
      if (newIdx < 0 || newIdx >= state.workflow.stages.length) return state;
      const stages = [...state.workflow.stages];
      const [moved] = stages.splice(idx, 1);
      if (!moved) return state;
      stages.splice(newIdx, 0, moved);
      return {
        ...state,
        workflow: { ...state.workflow, stages },
        dirty: true
      };
    }
    case "workflow_update_stage": {
      if (!state.workflow) return state;
      return {
        ...state,
        workflow: {
          ...state.workflow,
          stages: state.workflow.stages.map((s) =>
            s.id === action.stageId ? { ...s, ...action.patch } : s
          )
        },
        dirty: true
      };
    }
    case "workflow_set_approver_source": {
      if (!state.workflow) return state;
      return {
        ...state,
        workflow: {
          ...state.workflow,
          stages: state.workflow.stages.map((s) =>
            s.id === action.stageId
              ? { ...s, approver_source: action.source }
              : s
          )
        },
        dirty: true
      };
    }
    case "workflow_clear_approver_source": {
      if (!state.workflow) return state;
      return {
        ...state,
        workflow: {
          ...state.workflow,
          stages: state.workflow.stages.map((s) => {
            if (s.id !== action.stageId) return s;
            const { approver_source: _drop, ...rest } = s;
            return rest;
          })
        },
        dirty: true
      };
    }
    case "workflow_add_transition": {
      if (!state.workflow) return state;
      // Brief 123 — default label is empty; once the operator picks a
      // destination, the workflow_update_transition handler computes
      // "Move to {dest.label}" automatically. Drops the Brief 120
      // "Advance" literal that told approvers nothing about what the
      // button does.
      const blank: WorkflowTransition = { to: "", label: "" };
      return {
        ...state,
        workflow: {
          ...state.workflow,
          stages: state.workflow.stages.map((s) =>
            s.id === action.stageId
              ? { ...s, transitions: [...s.transitions, blank] }
              : s
          )
        },
        dirty: true
      };
    }
    case "workflow_update_transition": {
      if (!state.workflow) return state;
      const workflow = state.workflow;
      return {
        ...state,
        workflow: {
          ...workflow,
          stages: workflow.stages.map((s) =>
            s.id === action.stageId
              ? {
                  ...s,
                  transitions: s.transitions.map((t, i) => {
                    if (i !== action.index) return t;
                    const next: WorkflowTransition = { ...t, ...action.patch };
                    // Brief 123 — when the destination changes and the
                    // current label is empty or matches the default
                    // pattern, recompute label to "Move to {dest label}".
                    // Custom operator labels are left alone.
                    if (
                      action.patch.to !== undefined &&
                      action.patch.to !== t.to &&
                      isDefaultishTransitionLabel(t.label)
                    ) {
                      const dest = workflow.stages.find(
                        (st) => st.id === action.patch.to
                      );
                      next.label = dest
                        ? `Move to ${dest.label || dest.id}`
                        : "";
                    }
                    return next;
                  })
                }
              : s
          )
        },
        dirty: true
      };
    }
    case "workflow_remove_transition": {
      if (!state.workflow) return state;
      return {
        ...state,
        workflow: {
          ...state.workflow,
          stages: state.workflow.stages.map((s) =>
            s.id === action.stageId
              ? {
                  ...s,
                  transitions: s.transitions.filter(
                    (_, i) => i !== action.index
                  )
                }
              : s
          )
        },
        dirty: true
      };
    }
    case "workflow_rename_stage": {
      if (!state.workflow) return state;
      const { oldId, newId } = action;
      if (oldId === newId) return state;
      const workflow = state.workflow;
      // Caller should have already checked uniqueness; this is a
      // belt-and-suspenders guard so we never collapse two stages.
      if (workflow.stages.some((s) => s.id === newId)) return state;
      const nextStages = workflow.stages.map((s) => ({
        ...s,
        id: s.id === oldId ? newId : s.id,
        transitions: s.transitions.map((t) =>
          t.to === oldId ? { ...t, to: newId } : t
        )
      }));
      const nextDefault =
        workflow.default_stage === oldId ? newId : workflow.default_stage;
      return {
        ...state,
        workflow: { ...workflow, default_stage: nextDefault, stages: nextStages },
        dirty: true
      };
    }
    case "workflow_add_step": {
      const workflow = state.workflow ?? {
        default_stage: "",
        stages: [] as WorkflowStage[]
      };
      const stepCount = workflow.stages.filter((s) => !stageIsOutcome(s)).length;
      const step = makeStepSeed(stepCount);
      const nextStages = [...workflow.stages, step];
      // If no default_stage set (mid-build), this step becomes default.
      const nextDefault =
        workflow.default_stage && workflow.stages.some((s) => s.id === workflow.default_stage)
          ? workflow.default_stage
          : step.id;
      return {
        ...state,
        workflow: { ...workflow, default_stage: nextDefault, stages: nextStages },
        dirty: true
      };
    }
    case "workflow_duplicate_step": {
      if (!state.workflow) return state;
      const idx = state.workflow.stages.findIndex((s) => s.id === action.stepId);
      if (idx < 0) return state;
      const orig = state.workflow.stages[idx];
      if (!orig) return state;
      const dup: WorkflowStage = {
        ...orig,
        id: `step_${lowerNanoid()}`,
        _uiKey: nanoid(8),
        transitions: orig.transitions.map((t) => ({ ...t }))
      };
      const next = [...state.workflow.stages];
      next.splice(idx + 1, 0, dup);
      return {
        ...state,
        workflow: { ...state.workflow, stages: next },
        dirty: true
      };
    }
    case "workflow_remove_step": {
      if (!state.workflow) return state;
      const remaining = state.workflow.stages.filter(
        (s) => s.id !== action.stepId
      );
      // Reset transitions in the remaining stages that pointed at the
      // removed step.
      const cleaned = remaining.map((s) => ({
        ...s,
        transitions: s.transitions.filter((t) => t.to !== action.stepId)
      }));
      // Recompute default_stage if it pointed at the removed step.
      const firstStep = cleaned.find((s) => !stageIsOutcome(s));
      const nextDefault =
        state.workflow.default_stage === action.stepId
          ? firstStep?.id ?? ""
          : state.workflow.default_stage;
      return {
        ...state,
        workflow: { ...state.workflow, default_stage: nextDefault, stages: cleaned },
        dirty: true
      };
    }
    case "workflow_reorder_steps": {
      if (!state.workflow) return state;
      const { fromIndex, toIndex } = action;
      const steps = state.workflow.stages.filter((s) => !stageIsOutcome(s));
      const outcomes = state.workflow.stages.filter((s) => stageIsOutcome(s));
      if (
        fromIndex < 0 ||
        fromIndex >= steps.length ||
        toIndex < 0 ||
        toIndex >= steps.length
      ) {
        return state;
      }
      const reordered = [...steps];
      const [moved] = reordered.splice(fromIndex, 1);
      if (!moved) return state;
      reordered.splice(toIndex, 0, moved);
      const newStages = [...reordered, ...outcomes];
      const newDefault = reordered[0]?.id ?? state.workflow.default_stage;
      return {
        ...state,
        workflow: { ...state.workflow, default_stage: newDefault, stages: newStages },
        dirty: true
      };
    }
    case "workflow_update_step_label": {
      if (!state.workflow) return state;
      return {
        ...state,
        workflow: {
          ...state.workflow,
          stages: state.workflow.stages.map((s) =>
            s.id === action.stepId ? { ...s, label: action.label } : s
          )
        },
        dirty: true
      };
    }
    case "workflow_set_step_approver": {
      if (!state.workflow) return state;
      return {
        ...state,
        workflow: {
          ...state.workflow,
          stages: state.workflow.stages.map((s) => {
            if (s.id !== action.stepId) return s;
            if (action.source === undefined) {
              const { approver_source: _drop, ...rest } = s;
              return { ...rest, kind: "step" };
            }
            return { ...s, approver_source: action.source, kind: "step" };
          })
        },
        dirty: true
      };
    }
    case "workflow_add_outcome": {
      const workflow = state.workflow ?? {
        default_stage: "",
        stages: [] as WorkflowStage[]
      };
      const outcome = makeOutcomeSeed("New outcome", "neutral");
      return {
        ...state,
        workflow: { ...workflow, stages: [...workflow.stages, outcome] },
        dirty: true
      };
    }
    case "workflow_remove_outcome": {
      if (!state.workflow) return state;
      const cleaned = state.workflow.stages
        .filter((s) => s.id !== action.outcomeId)
        .map((s) => ({
          ...s,
          transitions: s.transitions.filter((t) => t.to !== action.outcomeId)
        }));
      return {
        ...state,
        workflow: { ...state.workflow, stages: cleaned },
        dirty: true
      };
    }
    case "workflow_update_outcome": {
      if (!state.workflow) return state;
      return {
        ...state,
        workflow: {
          ...state.workflow,
          stages: state.workflow.stages.map((s) =>
            s.id === action.outcomeId
              ? { ...s, ...action.patch, kind: "outcome" }
              : s
          )
        },
        dirty: true
      };
    }
    case "workflow_set_notifications": {
      if (!state.workflow) return state;
      const current = state.workflow.notifications ?? {};
      return {
        ...state,
        workflow: {
          ...state.workflow,
          notifications: { ...current, ...action.patch }
        },
        dirty: true
      };
    }
    case "workflow_add_email_step": {
      const workflow = state.workflow ?? {
        default_stage: "",
        stages: [] as WorkflowStage[]
      };
      const emailCount = workflow.stages.filter((s) => stageIsEmail(s)).length;
      const step = makeEmailStepSeed(emailCount);
      const nextStages = [...workflow.stages, step];
      const nextDefault =
        workflow.default_stage && workflow.stages.some((s) => s.id === workflow.default_stage)
          ? workflow.default_stage
          : step.id;
      return {
        ...state,
        workflow: { ...workflow, default_stage: nextDefault, stages: nextStages },
        dirty: true
      };
    }
    case "workflow_add_email_step_from_action": {
      if (!state.workflow) return state;
      const originStage = state.workflow.stages.find(
        (s) => s.id === action.stepId
      );
      if (!originStage) return state;
      const originAction = originStage.transitions[action.transitionIndex];
      if (!originAction) return state;
      const actionLabel = originAction.label;
      const lowerActionLabel = actionLabel.toLowerCase();
      // Pick an outcome to land on. Keyword heuristic: "approve"-ish
      // labels → first success/approved outcome; "deny"-ish → first
      // danger/denied outcome; else first outcome in document order.
      const outcomes = state.workflow.stages.filter((s) => stageIsOutcome(s));
      let destOutcome: WorkflowStage | undefined;
      if (/\bapprov|\baccept|\bok\b|\byes\b/.test(lowerActionLabel)) {
        destOutcome = outcomes.find(
          (o) => o.tint === "success" || /\bapprov/.test(o.label.toLowerCase())
        );
      } else if (/\bden|\breject|\bdecline/.test(lowerActionLabel)) {
        destOutcome = outcomes.find(
          (o) => o.tint === "danger" || /\bden|\breject|\bdecline/.test(o.label.toLowerCase())
        );
      }
      if (!destOutcome) destOutcome = outcomes[0];

      // Build a label derived from the destination outcome (Brief 131
      // Phase 10's "smart default labels"). Falls back to a generic
      // counter when no outcome exists yet.
      const emailCount = state.workflow.stages.filter((s) =>
        stageIsEmail(s)
      ).length;
      const seedLabel = destOutcome
        ? `${destOutcome.label} email`
        : emailCount === 0
          ? "Email"
          : `Email step ${emailCount + 1}`;

      const newEmailStep: WorkflowStage = {
        id: `email_${lowerNanoid()}`,
        label: seedLabel,
        transitions: [
          {
            to: destOutcome?.id ?? "",
            label: destOutcome ? `Continue to ${destOutcome.label}` : "Continue"
          }
        ],
        kind: "email",
        recipients: [],
        subject_template: DEFAULT_EMAIL_SUBJECT_TEMPLATE,
        body_template: DEFAULT_EMAIL_BODY_TEMPLATE,
        // PDF default mirrors the "Email submitter on outcome" quick
        // pattern (Brief 129): an outbound notification AFTER the
        // operator has acted on the form is the typical reason to wire
        // a routed email step.
        attach_pdf: true,
        _uiKey: nanoid(8)
      };
      // Insert the new email step just after its origin step.
      const stages = [...state.workflow.stages];
      const originIdx = stages.findIndex((s) => s.id === originStage.id);
      if (originIdx >= 0) {
        stages.splice(originIdx + 1, 0, newEmailStep);
      } else {
        stages.push(newEmailStep);
      }
      // Rewire the origin action to point at the new email step.
      const updatedStages = stages.map((s) => {
        if (s.id !== originStage.id) return s;
        return {
          ...s,
          transitions: s.transitions.map((t, i) =>
            i === action.transitionIndex ? { ...t, to: newEmailStep.id } : t
          )
        };
      });
      return {
        ...state,
        workflow: { ...state.workflow, stages: updatedStages },
        dirty: true
      };
    }
    case "workflow_update_email_step": {
      if (!state.workflow) return state;
      return {
        ...state,
        workflow: {
          ...state.workflow,
          stages: state.workflow.stages.map((s) =>
            s.id === action.stepId ? { ...s, ...action.patch } : s
          )
        },
        dirty: true
      };
    }
    case "workflow_set_email_recipients": {
      if (!state.workflow) return state;
      return {
        ...state,
        workflow: {
          ...state.workflow,
          stages: state.workflow.stages.map((s) =>
            s.id === action.stepId
              ? { ...s, recipients: action.recipients, kind: "email" as const }
              : s
          )
        },
        dirty: true
      };
    }
    case "workflow_apply_pattern": {
      if (!state.workflow) return state;
      return {
        ...state,
        workflow: applyQuickPattern(state.workflow, state.fields, action.pattern),
        dirty: true
      };
    }
  }
}
