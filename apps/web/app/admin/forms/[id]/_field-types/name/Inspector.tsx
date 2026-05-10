"use client";

import type { Field, NameField } from "@splash/forms-schema";
import LabeledInput from "../_shared/LabeledInput";
import LabeledCheckbox from "../_shared/LabeledCheckbox";
import KeyEditor from "../_shared/KeyEditor";
import type { InspectorProps } from "../index";

export default function NameInspector({ field, onUpdate }: InspectorProps) {
  const f = field as NameField;
  return (
    <div className="space-y-3">
      <LabeledInput label="Label" value={f.label} onChange={(v) => onUpdate({ label: v } as Partial<Field>)} />
      <KeyEditor value={f.key} onChange={(v) => onUpdate({ key: v } as Partial<Field>)} />
      <LabeledCheckbox label="Required" checked={f.required} onChange={(v) => onUpdate({ required: v } as Partial<Field>)} />
      <LabeledInput label="Help text" value={f.helpText ?? ""} onChange={(v) => onUpdate({ helpText: v || undefined } as Partial<Field>)} />
      <LabeledInput
        type="number"
        label="Max length"
        value={String(f.maxLength ?? "")}
        onChange={(v) => onUpdate({ maxLength: v ? Number(v) : undefined } as Partial<Field>)}
        hint="Default 120 if blank."
      />
    </div>
  );
}
