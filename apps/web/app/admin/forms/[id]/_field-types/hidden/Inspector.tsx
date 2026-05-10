"use client";

import type { Field, HiddenField } from "@splash/forms-schema";
import LabeledInput from "../_shared/LabeledInput";
import KeyEditor from "../_shared/KeyEditor";
import type { InspectorProps } from "../index";

export default function HiddenInspector({ field, onUpdate }: InspectorProps) {
  const f = field as HiddenField;
  return (
    <div className="space-y-3">
      <LabeledInput
        label="Internal label"
        value={f.label}
        onChange={(v) => onUpdate({ label: v } as Partial<Field>)}
        hint="Operator-only — never shown to respondents."
      />
      <KeyEditor value={f.key} onChange={(v) => onUpdate({ key: v } as Partial<Field>)} />
      <LabeledInput
        label="URL param to capture (optional)"
        value={f.defaultValueFromUrlParam ?? ""}
        onChange={(v) => onUpdate({ defaultValueFromUrlParam: v || undefined } as Partial<Field>)}
        hint="e.g. 'source' captures ?source=email_q2."
      />
      <LabeledInput
        label="Default value (fallback)"
        value={f.defaultValue ?? ""}
        onChange={(v) => onUpdate({ defaultValue: v || undefined } as Partial<Field>)}
        hint="Used when the URL param above is absent."
      />
    </div>
  );
}
