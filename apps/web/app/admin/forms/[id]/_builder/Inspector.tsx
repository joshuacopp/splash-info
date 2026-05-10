"use client";

import type { Field, LookupSource } from "@splash/forms-schema";

import { getFieldModule } from "../_field-types";
import type { FormMetaState } from "./reducer";

interface Props {
  selectedField: Field | undefined;
  formMeta: FormMetaState;
  allFields: Field[];
  lookupSources: readonly LookupSource[];
  formId: string;
  onFieldUpdate: (patch: Partial<Field>) => void;
  onFormMetaUpdate: (patch: Partial<FormMetaState>) => void;
}

export default function Inspector({
  selectedField,
  formMeta,
  allFields,
  lookupSources,
  formId,
  onFieldUpdate,
  onFormMetaUpdate
}: Props) {
  return (
    <aside className="w-80 shrink-0 overflow-y-auto rounded-splash-md border border-gray-light bg-white px-4 py-3">
      {selectedField ? (
        <FieldInspector
          field={selectedField}
          allFields={allFields}
          lookupSources={lookupSources}
          formId={formId}
          onUpdate={onFieldUpdate}
        />
      ) : (
        <FormMetaInspector formMeta={formMeta} onUpdate={onFormMetaUpdate} />
      )}
    </aside>
  );
}

interface FieldInspectorProps {
  field: Field;
  allFields: Field[];
  lookupSources: readonly LookupSource[];
  formId: string;
  onUpdate: (patch: Partial<Field>) => void;
}

function FieldInspector({
  field,
  allFields,
  lookupSources,
  formId,
  onUpdate
}: FieldInspectorProps) {
  const mod = getFieldModule(field.type);
  const InspectorComponent = mod.Inspector;
  return (
    <div className="space-y-3">
      <header className="border-b border-gray-light pb-2">
        <p className="text-[0.65rem] font-semibold uppercase tracking-wide text-splash-navy/60">
          Field settings
        </p>
        <p className="text-sm font-bold text-splash-navy">{mod.label}</p>
      </header>
      <InspectorComponent
        field={field}
        allFields={allFields}
        lookupSources={lookupSources}
        formId={formId}
        onUpdate={onUpdate}
      />
    </div>
  );
}

interface FormMetaInspectorProps {
  formMeta: FormMetaState;
  onUpdate: (patch: Partial<FormMetaState>) => void;
}

function FormMetaInspector({ formMeta, onUpdate }: FormMetaInspectorProps) {
  return (
    <div className="space-y-3">
      <header className="border-b border-gray-light pb-2">
        <p className="text-[0.65rem] font-semibold uppercase tracking-wide text-splash-navy/60">
          Form settings
        </p>
        <p className="text-sm font-bold text-splash-navy">Click a field to edit it</p>
        <p className="mt-1 text-xs text-splash-navy/60">
          Form-level settings (audience, webhook, etc.) can be edited here, but
          form metadata persistence is not wired in this brief — Save Draft
          currently persists the field list only. See Brief 95 outcome notes.
        </p>
      </header>

      <label className="block text-xs font-semibold text-splash-navy/80">
        Title
        <input
          type="text"
          value={formMeta.title}
          onChange={(e) => onUpdate({ title: e.currentTarget.value })}
          className="mt-1 w-full rounded-splash-sm border border-gray-light bg-white px-2 py-1.5 text-sm font-normal text-splash-navy"
        />
      </label>

      <label className="block text-xs font-semibold text-splash-navy/80">
        Description
        <textarea
          rows={3}
          value={formMeta.description ?? ""}
          onChange={(e) =>
            onUpdate({ description: e.currentTarget.value || null })
          }
          className="mt-1 w-full rounded-splash-sm border border-gray-light bg-white px-2 py-1.5 text-sm font-normal text-splash-navy"
        />
      </label>

      <label className="block text-xs font-semibold text-splash-navy/80">
        Audience
        <select
          value={formMeta.audience}
          onChange={(e) =>
            onUpdate({
              audience: e.currentTarget.value as FormMetaState["audience"]
            })
          }
          className="mt-1 w-full rounded-splash-sm border border-gray-light bg-white px-2 py-1.5 text-sm font-normal text-splash-navy"
        >
          <option value="public">Public</option>
          <option value="internal">Internal</option>
          <option value="link-only">Link-only</option>
        </select>
      </label>

      <label className="flex items-start gap-2 text-sm text-splash-navy">
        <input
          type="checkbox"
          checked={formMeta.notifyWebhook}
          onChange={(e) => onUpdate({ notifyWebhook: e.currentTarget.checked })}
          className="mt-0.5 h-4 w-4 rounded border-gray-light text-splash-blue focus:ring-splash-blue"
        />
        <span className="flex-1 font-medium">
          Notify webhook on submit
          <span className="mt-0.5 block text-xs font-normal text-splash-navy/60">
            Fires the FORMS_SUBMISSION_WEBHOOK_URL when bound.
          </span>
        </span>
      </label>

      <label className="flex items-start gap-2 text-sm text-splash-navy">
        <input
          type="checkbox"
          checked={formMeta.turnstileRequired}
          onChange={(e) =>
            onUpdate({ turnstileRequired: e.currentTarget.checked })
          }
          className="mt-0.5 h-4 w-4 rounded border-gray-light text-splash-blue focus:ring-splash-blue"
        />
        <span className="flex-1 font-medium">
          Require Turnstile (public audience)
        </span>
      </label>

      <label className="block text-xs font-semibold text-splash-navy/80">
        Success message
        <textarea
          rows={2}
          value={formMeta.successMessage ?? ""}
          onChange={(e) =>
            onUpdate({ successMessage: e.currentTarget.value || null })
          }
          placeholder="Optional. Default: 'Submitted — thanks!'"
          className="mt-1 w-full rounded-splash-sm border border-gray-light bg-white px-2 py-1.5 text-sm font-normal text-splash-navy"
        />
      </label>
    </div>
  );
}
