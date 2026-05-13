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
  WorkflowStage,
  WorkflowTransition
} from "@splash/forms-schema";

import { defaultConfigFor } from "../_field-types";

const lowerNanoid = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 6);

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
  return {
    default_stage: workflow.default_stage,
    stages: workflow.stages.map(({ _uiKey: _ignored, ...rest }) => rest)
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
  | { type: "workflow_rename_stage"; oldId: string; newId: string };

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

// Brief 123 — auto-seed three stages on workflow enable so operators land
// in a working starter template instead of a confused single-stage state
// where the only transition destination is the stage itself. Operators
// can rename / delete any of these; the seed is just a starting point.
function makeWorkflowSeed(): FormWorkflow {
  const approval: WorkflowStage = {
    id: "approval",
    label: "Approval",
    approver_source: { type: "site_role", role: "rm_email" },
    transitions: [
      { to: "approved", label: "Approve" },
      { to: "denied", label: "Decline" }
    ],
    _uiKey: nanoid(8)
  };
  const approved: WorkflowStage = {
    id: "approved",
    label: "Approved",
    // Terminal — no approver_source, no transitions.
    transitions: [],
    _uiKey: nanoid(8)
  };
  const denied: WorkflowStage = {
    id: "denied",
    label: "Denied",
    transitions: [],
    _uiKey: nanoid(8)
  };
  return {
    default_stage: approval.id,
    stages: [approval, approved, denied]
  };
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
        workflow: makeWorkflowSeed(),
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
        workflow: { default_stage: nextDefault, stages: nextStages },
        dirty: true
      };
    }
  }
}
