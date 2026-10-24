"use client";

import type { Field, LookupKeyColumn, PackagePriceGridField } from "@splash/forms-schema";
import LabeledInput from "../_shared/LabeledInput";
import LabeledCheckbox from "../_shared/LabeledCheckbox";
import LabeledSelect from "../_shared/LabeledSelect";
import KeyEditor from "../_shared/KeyEditor";
import type { InspectorProps } from "../index";

export default function PackagePriceGridInspector({
  field,
  allFields,
  onUpdate
}: InspectorProps) {
  const f = field as PackagePriceGridField;

  // A site is named either by a Location dropdown or by a typed site number.
  const siteFields = allFields.filter(
    (other) =>
      other.id !== f.id && (other.type === "location" || other.type === "short_text")
  );

  return (
    <div className="space-y-3">
      <LabeledInput label="Label" value={f.label} onChange={(v) => onUpdate({ label: v } as Partial<Field>)} />
      <KeyEditor value={f.key} onChange={(v) => onUpdate({ key: v } as Partial<Field>)} />
      <LabeledCheckbox
        label="Required (at least one package)"
        checked={f.required}
        onChange={(v) => onUpdate({ required: v } as Partial<Field>)}
      />
      <LabeledInput label="Help text" value={f.helpText ?? ""} onChange={(v) => onUpdate({ helpText: v || undefined } as Partial<Field>)} />

      <LabeledCheckbox
        label="Multiple sites"
        checked={!!f.multiSite}
        onChange={(v) => onUpdate({ multiSite: v || undefined } as Partial<Field>)}
      />
      <p className="-mt-1 text-xs text-splash-navy/60">
        The submitter adds each site by number inside the grid, so one request
        (and one approval) covers a regional change. No separate site field is
        needed.
      </p>

      {!f.multiSite && (
      <>
      <LabeledSelect
        label="Site field"
        value={f.keyFieldKey}
        onChange={(v) => {
          // Picking the field also sets how to read it, which is the only
          // sensible pairing: a Location dropdown holds the slug, a text box
          // holds the 3-digit site number.
          const picked = siteFields.find((s) => s.key === v);
          const keyColumn: LookupKeyColumn =
            picked?.type === "location" ? "pricing_simple.location_code" : "pricing_simple.site";
          onUpdate({ keyFieldKey: v, keyColumn } as Partial<Field>);
        }}
        options={[
          { value: "", label: "— Pick a field —" },
          ...siteFields.map((s) => ({
            value: s.key,
            label: `${s.label || "(no label)"} · ${s.key}`
          }))
        ]}
        hint="The field naming the site. Its packages are listed from pricing_simple; prices are always typed in by the submitter."
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
      </>
      )}
    </div>
  );
}
