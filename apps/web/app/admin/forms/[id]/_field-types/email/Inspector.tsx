"use client";

import type { EmailField, Field } from "@splash/forms-schema";
import LabeledInput from "../_shared/LabeledInput";
import LabeledCheckbox from "../_shared/LabeledCheckbox";
import KeyEditor from "../_shared/KeyEditor";
import type { InspectorProps } from "../index";

export default function EmailInspector({ field, onUpdate }: InspectorProps) {
  const f = field as EmailField;
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
        hint="Default 254 (RFC 5321) if blank."
      />
      <LabeledCheckbox
        label="Don't let the browser autofill this"
        checked={f.noAutofill ?? false}
        onChange={(v) => onUpdate({ noAutofill: v || undefined } as Partial<Field>)}
        hint="For an email that belongs to someone else (e.g. the employee's), so a shared tablet doesn't fill in the manager's own address."
      />
    </div>
  );
}
