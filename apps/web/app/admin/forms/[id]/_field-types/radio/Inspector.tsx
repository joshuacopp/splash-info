"use client";

import type { RadioField, Field } from "@splash/forms-schema";
import LabeledInput from "../_shared/LabeledInput";
import LabeledCheckbox from "../_shared/LabeledCheckbox";
import KeyEditor from "../_shared/KeyEditor";
import OptionListEditor from "../_shared/OptionListEditor";
import type { InspectorProps } from "../index";

export default function RadioInspector({ field, onUpdate }: InspectorProps) {
  const f = field as RadioField;
  return (
    <div className="space-y-3">
      <LabeledInput label="Label" value={f.label} onChange={(v) => onUpdate({ label: v } as Partial<Field>)} />
      <KeyEditor value={f.key} onChange={(v) => onUpdate({ key: v } as Partial<Field>)} />
      <LabeledCheckbox label="Required" checked={f.required} onChange={(v) => onUpdate({ required: v } as Partial<Field>)} />
      <LabeledInput label="Help text" value={f.helpText ?? ""} onChange={(v) => onUpdate({ helpText: v || undefined } as Partial<Field>)} />
      <LabeledCheckbox
        label="Show options on one line"
        checked={f.layout === "inline"}
        onChange={(v) => onUpdate({ layout: v ? "inline" : "vertical" } as Partial<Field>)}
      />
      <p className="-mt-1 text-xs text-splash-navy/60">
        Inline suits short option sets like Pass / Fail / NA. Long labels wrap
        badly &mdash; leave it off for anything wordy.
      </p>
      <OptionListEditor
        options={f.options}
        onChange={(options) => onUpdate({ options } as Partial<Field>)}
      />
    </div>
  );
}
