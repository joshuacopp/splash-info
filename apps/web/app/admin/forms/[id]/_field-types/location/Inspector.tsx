"use client";

import type { Field, LocationField } from "@splash/forms-schema";
import LabeledInput from "../_shared/LabeledInput";
import LabeledCheckbox from "../_shared/LabeledCheckbox";
import LabeledSelect from "../_shared/LabeledSelect";
import KeyEditor from "../_shared/KeyEditor";
import type { InspectorProps } from "../index";

export default function LocationInspector({ field, onUpdate }: InspectorProps) {
  const f = field as LocationField;
  return (
    <div className="space-y-3">
      <LabeledInput label="Label" value={f.label} onChange={(v) => onUpdate({ label: v } as Partial<Field>)} />
      <KeyEditor value={f.key} onChange={(v) => onUpdate({ key: v } as Partial<Field>)} />
      <LabeledCheckbox label="Required" checked={f.required} onChange={(v) => onUpdate({ required: v } as Partial<Field>)} />
      <LabeledInput label="Help text" value={f.helpText ?? ""} onChange={(v) => onUpdate({ helpText: v || undefined } as Partial<Field>)} />
      <LabeledSelect
        label="Display format"
        value={f.displayFormat}
        onChange={(v) =>
          onUpdate({
            displayFormat: v as LocationField["displayFormat"]
          } as Partial<Field>)
        }
        options={[
          { value: "name", label: "Name only — e.g. Oswego" },
          { value: "name_and_address", label: "Name and address" },
          { value: "site_number", label: "Site # and name" }
        ]}
        hint="Stored payload is always the location_code slug regardless."
      />
    </div>
  );
}
