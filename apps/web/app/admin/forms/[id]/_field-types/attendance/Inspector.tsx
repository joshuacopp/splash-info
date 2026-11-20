"use client";

import type { AttendanceField, Field, LookupKeyColumn } from "@splash/forms-schema";
import LabeledInput from "../_shared/LabeledInput";
import LabeledCheckbox from "../_shared/LabeledCheckbox";
import LabeledSelect from "../_shared/LabeledSelect";
import KeyEditor from "../_shared/KeyEditor";
import type { InspectorProps } from "../index";

export default function AttendanceInspector({ field, allFields, onUpdate }: InspectorProps) {
  const f = field as AttendanceField;
  const siteFields = allFields.filter(
    (other) => other.id !== f.id && (other.type === "location" || other.type === "short_text")
  );
  const toInt = (v: string, lo: number, hi: number): number | undefined => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : undefined;
  };

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
          const picked = siteFields.find((s) => s.key === v);
          const keyColumn: LookupKeyColumn =
            picked?.type === "location" ? "pricing_simple.location_code" : "pricing_simple.site";
          onUpdate({ keyFieldKey: v, keyColumn } as Partial<Field>);
        }}
        options={[
          { value: "", label: "— Pick a field —" },
          ...siteFields.map((s) => ({ value: s.key, label: `${s.label || "(no label)"} · ${s.key}` }))
        ]}
        hint="Each row searches employees at this site."
      />
      <LabeledInput
        label="Rows shown to start"
        value={String(f.initialRows ?? 5)}
        onChange={(v) => onUpdate({ initialRows: toInt(v, 1, 40) } as Partial<Field>)}
      />
      <LabeledInput
        label="Minimum signed rows (blank = 1 when required)"
        value={f.minRows === undefined ? "" : String(f.minRows)}
        onChange={(v) =>
          onUpdate({ minRows: v.trim() === "" ? undefined : toInt(v, 0, 40) } as Partial<Field>)
        }
      />
      <LabeledCheckbox
        label="Allow typing a name when nobody matches"
        checked={f.allowTyped !== false}
        onChange={(v) => onUpdate({ allowTyped: v } as Partial<Field>)}
      />
      <p className="-mt-1 text-xs text-splash-navy/60">
        Each row is a name and a signature; &ldquo;+ Add employee&rdquo; adds more. Blank rows are
        ignored, and a name without a signature is refused. Not available on public forms.
      </p>
    </div>
  );
}
