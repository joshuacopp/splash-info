"use client";

import type { Field, ShortTextField } from "@splash/forms-schema";
import LabeledInput from "../_shared/LabeledInput";
import LabeledCheckbox from "../_shared/LabeledCheckbox";
import KeyEditor from "../_shared/KeyEditor";
import type { InspectorProps } from "../index";

export default function ShortTextInspector({ field, onUpdate }: InspectorProps) {
  const f = field as ShortTextField;
  return (
    <div className="space-y-3">
      <LabeledInput label="Label" value={f.label} onChange={(v) => onUpdate({ label: v } as Partial<Field>)} />
      <KeyEditor value={f.key} onChange={(v) => onUpdate({ key: v } as Partial<Field>)} />
      <LabeledCheckbox label="Required" checked={f.required} onChange={(v) => onUpdate({ required: v } as Partial<Field>)} />
      <LabeledInput label="Help text" value={f.helpText ?? ""} onChange={(v) => onUpdate({ helpText: v || undefined } as Partial<Field>)} />
      <LabeledInput label="Placeholder" value={f.placeholder ?? ""} onChange={(v) => onUpdate({ placeholder: v || undefined } as Partial<Field>)} />
      <LabeledInput
        type="number"
        label="Max length"
        value={String(f.maxLength ?? "")}
        onChange={(v) => onUpdate({ maxLength: v ? Number(v) : undefined } as Partial<Field>)}
        hint="Default 500."
      />
      <LabeledCheckbox
        label="Numbers only"
        checked={!!f.numeric}
        onChange={(v) => onUpdate({ numeric: v ? { integer: true } : undefined } as Partial<Field>)}
        hint="Shows a number keypad and refuses anything that isn't a number. Needed for totals and averages in digests."
      />
      {f.numeric ? (
        <div className="space-y-2 rounded-splash-sm border border-gray-light p-2">
          <LabeledCheckbox
            label="Whole numbers only"
            checked={f.numeric.integer ?? false}
            onChange={(v) => onUpdate({ numeric: { ...f.numeric, integer: v || undefined } } as Partial<Field>)}
          />
          <div className="grid grid-cols-2 gap-2">
            <LabeledInput
              type="number"
              label="Lowest allowed"
              value={f.numeric.min == null ? "" : String(f.numeric.min)}
              onChange={(v) => onUpdate({ numeric: { ...f.numeric, min: v === "" ? undefined : Number(v) } } as Partial<Field>)}
            />
            <LabeledInput
              type="number"
              label="Highest allowed"
              value={f.numeric.max == null ? "" : String(f.numeric.max)}
              onChange={(v) => onUpdate({ numeric: { ...f.numeric, max: v === "" ? undefined : Number(v) } } as Partial<Field>)}
              hint="Catches typos like an extra zero."
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
