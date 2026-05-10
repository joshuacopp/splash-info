"use client";

import type { Field, LongTextField } from "@splash/forms-schema";
import LabeledInput from "../_shared/LabeledInput";
import LabeledCheckbox from "../_shared/LabeledCheckbox";
import KeyEditor from "../_shared/KeyEditor";
import type { InspectorProps } from "../index";

export default function LongTextInspector({ field, onUpdate }: InspectorProps) {
  const f = field as LongTextField;
  return (
    <div className="space-y-3">
      <LabeledInput label="Label" value={f.label} onChange={(v) => onUpdate({ label: v } as Partial<Field>)} />
      <KeyEditor value={f.key} onChange={(v) => onUpdate({ key: v } as Partial<Field>)} />
      <LabeledCheckbox label="Required" checked={f.required} onChange={(v) => onUpdate({ required: v } as Partial<Field>)} />
      <LabeledInput label="Help text" value={f.helpText ?? ""} onChange={(v) => onUpdate({ helpText: v || undefined } as Partial<Field>)} />
      <LabeledInput label="Placeholder" value={f.placeholder ?? ""} onChange={(v) => onUpdate({ placeholder: v || undefined } as Partial<Field>)} />
      <LabeledInput
        type="number"
        label="Rows"
        value={String(f.rows ?? "")}
        onChange={(v) => onUpdate({ rows: v ? Number(v) : undefined } as Partial<Field>)}
        hint="Visual height in rows. Default 4."
      />
      <LabeledInput
        type="number"
        label="Max length"
        value={String(f.maxLength ?? "")}
        onChange={(v) => onUpdate({ maxLength: v ? Number(v) : undefined } as Partial<Field>)}
        hint="Default 10000."
      />
    </div>
  );
}
