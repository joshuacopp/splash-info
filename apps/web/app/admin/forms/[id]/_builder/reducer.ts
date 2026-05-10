// useReducer state for the form builder canvas + inspector.
//
// Per planning Decision 3, no auto-save: dirty flag drives Save Draft button
// state and the beforeunload warning. Per Decision 4, field IDs and key
// suffixes use nanoid(8 / 6) for stability across renames.

import { nanoid } from "nanoid";
import type { Field, FieldType } from "@splash/forms-schema";

import { defaultConfigFor } from "../_field-types";

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
  | { type: "mark_clean" };

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
  draftSchema: { fields: Field[] };
}

export function initialState(initial: BuilderInitial): BuilderState {
  return {
    fields: initial.draftSchema.fields,
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
        key: `${action.fieldType}_${nanoid(6)}`
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
  }
}
