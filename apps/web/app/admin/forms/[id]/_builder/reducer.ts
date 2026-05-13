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
  | { type: "workflow_add_transition"; stageId: string }
  | {
      type: "workflow_update_transition";
      stageId: string;
      index: number;
      patch: Partial<WorkflowTransition>;
    }
  | { type: "workflow_remove_transition"; stageId: string; index: number };

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
    workflow: initial.draftSchema.workflow ?? null,
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
    transitions: []
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
      const stage = makeBlankStage();
      return {
        ...state,
        workflow: { default_stage: stage.id, stages: [stage] },
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
    case "workflow_add_transition": {
      if (!state.workflow) return state;
      const blank: WorkflowTransition = { to: "", label: "Advance" };
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
      return {
        ...state,
        workflow: {
          ...state.workflow,
          stages: state.workflow.stages.map((s) =>
            s.id === action.stageId
              ? {
                  ...s,
                  transitions: s.transitions.map((t, i) =>
                    i === action.index ? { ...t, ...action.patch } : t
                  )
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
  }
}
