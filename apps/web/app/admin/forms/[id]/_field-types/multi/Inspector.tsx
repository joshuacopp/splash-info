"use client";

import type { Field, MultiField } from "@splash/forms-schema";
import LabeledInput from "../_shared/LabeledInput";
import LabeledCheckbox from "../_shared/LabeledCheckbox";
import KeyEditor from "../_shared/KeyEditor";
import OptionListEditor from "../_shared/OptionListEditor";
import type { InspectorProps } from "../index";

export default function MultiInspector({ field, onUpdate }: InspectorProps) {
  const f = field as MultiField;
  return (
    <div className="space-y-3">
      <LabeledInput label="Label" value={f.label} onChange={(v) => onUpdate({ label: v } as Partial<Field>)} />
      <KeyEditor value={f.key} onChange={(v) => onUpdate({ key: v } as Partial<Field>)} />
      <LabeledCheckbox label="Required" checked={f.required} onChange={(v) => onUpdate({ required: v } as Partial<Field>)} />
      <LabeledInput label="Help text" value={f.helpText ?? ""} onChange={(v) => onUpdate({ helpText: v || undefined } as Partial<Field>)} />
      <LabeledInput
        type="number"
        label="Minimum selected"
        value={String(f.minSelected ?? "")}
        onChange={(v) => onUpdate({ minSelected: v ? Number(v) : undefined } as Partial<Field>)}
      />
      <LabeledInput
        type="number"
        label="Maximum selected"
        value={String(f.maxSelected ?? "")}
        onChange={(v) => onUpdate({ maxSelected: v ? Number(v) : undefined } as Partial<Field>)}
        hint="Blank = no upper bound."
      />
      <OptionListEditor
        options={f.options}
        onChange={(options) => onUpdate({ options } as Partial<Field>)}
      />
    </div>
  );
}
