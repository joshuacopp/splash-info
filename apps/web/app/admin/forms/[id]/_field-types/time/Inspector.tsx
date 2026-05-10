"use client";

import type { Field, TimeField } from "@splash/forms-schema";
import LabeledInput from "../_shared/LabeledInput";
import LabeledCheckbox from "../_shared/LabeledCheckbox";
import KeyEditor from "../_shared/KeyEditor";
import type { InspectorProps } from "../index";

export default function TimeInspector({ field, onUpdate }: InspectorProps) {
  const f = field as TimeField;
  return (
    <div className="space-y-3">
      <LabeledInput label="Label" value={f.label} onChange={(v) => onUpdate({ label: v } as Partial<Field>)} />
      <KeyEditor value={f.key} onChange={(v) => onUpdate({ key: v } as Partial<Field>)} />
      <LabeledCheckbox label="Required" checked={f.required} onChange={(v) => onUpdate({ required: v } as Partial<Field>)} />
      <LabeledInput label="Help text" value={f.helpText ?? ""} onChange={(v) => onUpdate({ helpText: v || undefined } as Partial<Field>)} />
      <LabeledInput
        type="time"
        label="Min time (HH:MM)"
        value={f.minTime ?? ""}
        onChange={(v) => onUpdate({ minTime: v || undefined } as Partial<Field>)}
      />
      <LabeledInput
        type="time"
        label="Max time (HH:MM)"
        value={f.maxTime ?? ""}
        onChange={(v) => onUpdate({ maxTime: v || undefined } as Partial<Field>)}
      />
    </div>
  );
}
