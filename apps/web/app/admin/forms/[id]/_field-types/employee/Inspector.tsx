"use client";

import type { EmployeeField, Field, LookupKeyColumn } from "@splash/forms-schema";
import LabeledInput from "../_shared/LabeledInput";
import LabeledCheckbox from "../_shared/LabeledCheckbox";
import LabeledSelect from "../_shared/LabeledSelect";
import KeyEditor from "../_shared/KeyEditor";
import type { InspectorProps } from "../index";

export default function EmployeeInspector({ field, allFields, onUpdate }: InspectorProps) {
  const f = field as EmployeeField;

  // A site is named either by a Location dropdown or by a typed site number.
  const siteFields = allFields.filter(
    (other) => other.id !== f.id && (other.type === "location" || other.type === "short_text")
  );

  return (
    <div className="space-y-3">
      <LabeledInput label="Label" value={f.label} onChange={(v) => onUpdate({ label: v } as Partial<Field>)} />
      <KeyEditor value={f.key} onChange={(v) => onUpdate({ key: v } as Partial<Field>)} />
      <LabeledCheckbox
        label="Required"
        checked={f.required}
        onChange={(v) => onUpdate({ required: v } as Partial<Field>)}
      />
      <LabeledInput
        label="Help text"
        value={f.helpText ?? ""}
        onChange={(v) => onUpdate({ helpText: v || undefined } as Partial<Field>)}
      />

      <LabeledSelect
        label="Site field"
        value={f.keyFieldKey}
        onChange={(v) => {
          // A Location dropdown holds the slug; a text box holds the site
          // number (011 / 101 for the office groups).
          const picked = siteFields.find((s) => s.key === v);
          const keyColumn: LookupKeyColumn =
            picked?.type === "location" ? "pricing_simple.location_code" : "pricing_simple.site";
          onUpdate({ keyFieldKey: v, keyColumn } as Partial<Field>);
        }}
        options={[
          { value: "", label: "— Pick a field —" },
          ...siteFields.map((s) => ({ value: s.key, label: `${s.label || "(no label)"} · ${s.key}` }))
        ]}
        hint="Search shows employees at this site. Site 011 or 101 searches the office groups."
      />

      <LabeledSelect
        label="That field holds"
        value={f.keyColumn}
        onChange={(v) => onUpdate({ keyColumn: v as LookupKeyColumn } as Partial<Field>)}
        options={[
          { value: "pricing_simple.site", label: "A 3-digit site number" },
          { value: "pricing_simple.location_code", label: "A location (dropdown slug)" }
        ]}
      />

      <LabeledCheckbox
        label="Allow typing a name when nobody matches"
        checked={f.allowTyped !== false}
        onChange={(v) => onUpdate({ allowTyped: v } as Partial<Field>)}
      />
      <p className="-mt-1 text-xs text-splash-navy/60">
        For new hires not in Beekeeper yet. A typed name is marked unverified, and one that closely
        matches a real employee is refused with a prompt to pick them instead. Not available on
        public forms.
      </p>
    </div>
  );
}
