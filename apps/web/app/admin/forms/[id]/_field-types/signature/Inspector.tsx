"use client";

import type { Field, SignatureField } from "@splash/forms-schema";
import LabeledInput from "../_shared/LabeledInput";
import LabeledCheckbox from "../_shared/LabeledCheckbox";
import LabeledSelect from "../_shared/LabeledSelect";
import KeyEditor from "../_shared/KeyEditor";
import type { InspectorProps } from "../index";

export default function SignatureInspector({ field, onUpdate }: InspectorProps) {
  const f = field as SignatureField;
  return (
    <div className="space-y-3">
      <LabeledInput label="Label" value={f.label} onChange={(v) => onUpdate({ label: v } as Partial<Field>)} />
      <KeyEditor value={f.key} onChange={(v) => onUpdate({ key: v } as Partial<Field>)} />
      <LabeledCheckbox label="Required" checked={f.required} onChange={(v) => onUpdate({ required: v } as Partial<Field>)} />
      <LabeledInput label="Help text" value={f.helpText ?? ""} onChange={(v) => onUpdate({ helpText: v || undefined } as Partial<Field>)} />
      <LabeledSelect
        label="Format"
        value={f.format}
        onChange={(v) => onUpdate({ format: v as SignatureField["format"] } as Partial<Field>)}
        options={[
          { value: "png", label: "PNG (raster, default)" },
          { value: "svg", label: "SVG (vector)" }
        ]}
      />
      <LabeledInput
        label="Pen color"
        value={f.penColor ?? ""}
        onChange={(v) => onUpdate({ penColor: v || undefined } as Partial<Field>)}
        hint='Hex code, e.g. "#000000".'
      />
      <LabeledInput
        type="number"
        label="Minimum strokes"
        value={String(f.minStrokes ?? "")}
        onChange={(v) => onUpdate({ minStrokes: v ? Number(v) : undefined } as Partial<Field>)}
      />
    </div>
  );
}
