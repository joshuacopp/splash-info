// Lookup inspector — most complex of the 16. Surfaces:
//   - Key field (in this form): the field whose value the lookup uses.
//   - Key column (in DB): pricing_simple.location_code or .site (= site_number).
//   - Source table + column: must be in LOOKUP_SOURCES (Brief 89).
//   - Resolution mode: prefill_visible | prefill_hidden | display_only.
//   - Null behavior: allow_empty | block_submit.

"use client";

import type {
  Field,
  LookupField,
  LookupKeyColumn,
  LookupNullBehavior,
  LookupResolutionMode
} from "@splash/forms-schema";
import LabeledInput from "../_shared/LabeledInput";
import LabeledCheckbox from "../_shared/LabeledCheckbox";
import LabeledSelect from "../_shared/LabeledSelect";
import KeyEditor from "../_shared/KeyEditor";
import type { InspectorProps } from "../index";

export default function LookupInspector({
  field,
  allFields,
  lookupSources,
  onUpdate
}: InspectorProps) {
  const f = field as LookupField;

  // Eligible "key fields" in this form: short_text, dropdown, location.
  const eligibleKeyFields = allFields.filter(
    (other) =>
      other.id !== f.id &&
      (other.type === "short_text" ||
        other.type === "location" ||
        other.type === "dropdown")
  );
  const sourcesForTable = lookupSources.filter((s) => s.table === f.sourceTable);

  return (
    <div className="space-y-3">
      <LabeledInput label="Label" value={f.label} onChange={(v) => onUpdate({ label: v } as Partial<Field>)} />
      <KeyEditor value={f.key} onChange={(v) => onUpdate({ key: v } as Partial<Field>)} />
      <LabeledCheckbox label="Required" checked={f.required} onChange={(v) => onUpdate({ required: v } as Partial<Field>)} />
      <LabeledInput label="Help text" value={f.helpText ?? ""} onChange={(v) => onUpdate({ helpText: v || undefined } as Partial<Field>)} />

      <LabeledSelect
        label="Key field (in this form)"
        value={f.keyFieldId}
        onChange={(v) => onUpdate({ keyFieldId: v } as Partial<Field>)}
        options={[
          { value: "", label: "— Pick a field —" },
          ...eligibleKeyFields.map((k) => ({
            value: k.id,
            label: `${k.label || "(no label)"} · ${k.key}`
          }))
        ]}
        hint="The field whose value drives the lookup. Add a Location, Short Text, or Dropdown field first."
      />

      <LabeledSelect
        label="Key column (in DB)"
        value={f.keyColumn}
        onChange={(v) =>
          onUpdate({ keyColumn: v as LookupKeyColumn } as Partial<Field>)
        }
        options={[
          {
            value: "pricing_simple.location_code",
            label: "pricing_simple.location_code (slug)"
          },
          {
            value: "pricing_simple.site",
            label: "pricing_simple.site (3-digit number = locations.site_number)"
          }
        ]}
      />

      <LabeledSelect
        label="Source table"
        value={f.sourceTable}
        onChange={(v) =>
          onUpdate({
            sourceTable: v as "pricing_simple" | "locations",
            sourceColumn: ""
          } as Partial<Field>)
        }
        options={[
          { value: "pricing_simple", label: "pricing_simple" },
          { value: "locations", label: "locations" }
        ]}
      />

      <LabeledSelect
        label="Source column"
        value={f.sourceColumn}
        onChange={(v) => onUpdate({ sourceColumn: v } as Partial<Field>)}
        options={[
          { value: "", label: "— Pick a column —" },
          ...sourcesForTable.map((s) => ({
            value: s.column,
            label: s.label
          }))
        ]}
      />

      <LabeledSelect
        label="Resolution mode"
        value={f.resolutionMode}
        onChange={(v) =>
          onUpdate({
            resolutionMode: v as LookupResolutionMode
          } as Partial<Field>)
        }
        options={[
          { value: "prefill_visible", label: "Visible — user sees the resolved value" },
          { value: "prefill_hidden", label: "Hidden — resolved silently, no UI" },
          { value: "display_only", label: "Display only — shown but not stored" }
        ]}
      />

      <LabeledSelect
        label="If resolution returns nothing"
        value={f.nullBehavior}
        onChange={(v) =>
          onUpdate({ nullBehavior: v as LookupNullBehavior } as Partial<Field>)
        }
        options={[
          { value: "allow_empty", label: "Allow empty (submit OK)" },
          { value: "block_submit", label: "Block submit" }
        ]}
      />
    </div>
  );
}
