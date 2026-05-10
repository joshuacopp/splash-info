"use client";

import type { DateField, Field } from "@splash/forms-schema";
import LabeledInput from "../_shared/LabeledInput";
import LabeledCheckbox from "../_shared/LabeledCheckbox";
import KeyEditor from "../_shared/KeyEditor";
import type { InspectorProps } from "../index";

export default function DateInspector({ field, onUpdate }: InspectorProps) {
  const f = field as DateField;
  return (
    <div className="space-y-3">
      <LabeledInput label="Label" value={f.label} onChange={(v) => onUpdate({ label: v } as Partial<Field>)} />
      <KeyEditor value={f.key} onChange={(v) => onUpdate({ key: v } as Partial<Field>)} />
      <LabeledCheckbox label="Required" checked={f.required} onChange={(v) => onUpdate({ required: v } as Partial<Field>)} />
      <LabeledInput label="Help text" value={f.helpText ?? ""} onChange={(v) => onUpdate({ helpText: v || undefined } as Partial<Field>)} />
      <LabeledInput
        type="date"
        label="Min date (YYYY-MM-DD)"
        value={f.minDate ?? ""}
        onChange={(v) => onUpdate({ minDate: v || undefined } as Partial<Field>)}
      />
      <LabeledInput
        type="date"
        label="Max date (YYYY-MM-DD)"
        value={f.maxDate ?? ""}
        onChange={(v) => onUpdate({ maxDate: v || undefined } as Partial<Field>)}
      />
      <LabeledCheckbox
        label="Default to today's date"
        checked={f.defaultToToday ?? false}
        onChange={(v) => onUpdate({ defaultToToday: v } as Partial<Field>)}
      />
    </div>
  );
}
