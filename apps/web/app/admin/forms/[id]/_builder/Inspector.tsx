// Brief 125 — Inspector is now Fields-tab only.
//
// Form metadata moved to the Settings tab; workflow editor moved to the
// Workflow tab. The right-panel inspector renders the per-field config
// editor when a field is selected, otherwise a hint.

"use client";

import type { Field, LookupSource } from "@splash/forms-schema";

import { getFieldModule } from "../_field-types";
import AdvancedSection from "../_field-types/_shared/AdvancedSection";

interface Props {
  selectedField: Field | undefined;
  allFields: Field[];
  lookupSources: readonly LookupSource[];
  formId: string;
  onFieldUpdate: (patch: Partial<Field>) => void;
}

export default function Inspector({
  selectedField,
  allFields,
  lookupSources,
  formId,
  onFieldUpdate
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
        <div className="space-y-2">
          <p className="text-[0.65rem] font-semibold uppercase tracking-wide text-splash-navy/60">
            Field settings
          </p>
          <p className="text-sm font-bold text-splash-navy">
            Click a field to edit it
          </p>
          <p className="text-xs text-splash-navy/60">
            Form-level settings live on the Settings tab. Approval
            workflows live on the Workflow tab.
          </p>
        </div>
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
      <AdvancedSection field={field} onUpdate={onUpdate} />
    </div>
  );
}
