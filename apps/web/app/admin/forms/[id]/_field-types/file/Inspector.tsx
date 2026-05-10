"use client";

import type { Field, FileField } from "@splash/forms-schema";
import LabeledInput from "../_shared/LabeledInput";
import LabeledCheckbox from "../_shared/LabeledCheckbox";
import KeyEditor from "../_shared/KeyEditor";
import type { InspectorProps } from "../index";

export default function FileInspector({ field, onUpdate }: InspectorProps) {
  const f = field as FileField;
  const mimeAsString = f.allowedMimeTypes?.join(", ") ?? "";
  return (
    <div className="space-y-3">
      <LabeledInput label="Label" value={f.label} onChange={(v) => onUpdate({ label: v } as Partial<Field>)} />
      <KeyEditor value={f.key} onChange={(v) => onUpdate({ key: v } as Partial<Field>)} />
      <LabeledCheckbox label="Required" checked={f.required} onChange={(v) => onUpdate({ required: v } as Partial<Field>)} />
      <LabeledInput label="Help text" value={f.helpText ?? ""} onChange={(v) => onUpdate({ helpText: v || undefined } as Partial<Field>)} />
      <LabeledInput
        type="number"
        label="Max size (MB)"
        value={String(f.maxSizeMb ?? "")}
        onChange={(v) => onUpdate({ maxSizeMb: v ? Number(v) : undefined } as Partial<Field>)}
        hint="Default 10. Hard ceiling 25 MB enforced server-side."
      />
      <LabeledInput
        label="Allowed MIME types (comma-separated)"
        value={mimeAsString}
        onChange={(v) => {
          const list = v
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
          onUpdate({
            allowedMimeTypes: list.length ? list : undefined
          } as Partial<Field>);
        }}
        hint='e.g. "image/*, application/pdf". Default: image/*, application/pdf.'
      />
      <LabeledCheckbox
        label="Allow multiple files"
        checked={f.allowMultiple ?? false}
        onChange={(v) => onUpdate({ allowMultiple: v } as Partial<Field>)}
      />
    </div>
  );
}
