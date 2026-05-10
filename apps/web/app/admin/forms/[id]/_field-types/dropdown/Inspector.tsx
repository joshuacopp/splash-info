"use client";

import type { DropdownField, Field } from "@splash/forms-schema";
import LabeledInput from "../_shared/LabeledInput";
import LabeledCheckbox from "../_shared/LabeledCheckbox";
import KeyEditor from "../_shared/KeyEditor";
import OptionListEditor from "../_shared/OptionListEditor";
import type { InspectorProps } from "../index";

export default function DropdownInspector({ field, onUpdate }: InspectorProps) {
  const f = field as DropdownField;
  return (
    <div className="space-y-3">
      <LabeledInput label="Label" value={f.label} onChange={(v) => onUpdate({ label: v } as Partial<Field>)} />
      <KeyEditor value={f.key} onChange={(v) => onUpdate({ key: v } as Partial<Field>)} />
      <LabeledCheckbox label="Required" checked={f.required} onChange={(v) => onUpdate({ required: v } as Partial<Field>)} />
      <LabeledInput label="Help text" value={f.helpText ?? ""} onChange={(v) => onUpdate({ helpText: v || undefined } as Partial<Field>)} />
      <LabeledInput
        label="Placeholder"
        value={f.placeholder ?? ""}
        onChange={(v) => onUpdate({ placeholder: v || undefined } as Partial<Field>)}
        hint="Shown as the first (unselected) option."
      />
      <OptionListEditor
        options={f.options}
        onChange={(options) => onUpdate({ options } as Partial<Field>)}
      />
    </div>
  );
}
