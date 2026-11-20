"use client";

import type { Field, RequiredTopicsField } from "@splash/forms-schema";
import LabeledInput from "../_shared/LabeledInput";
import LabeledSelect from "../_shared/LabeledSelect";
import KeyEditor from "../_shared/KeyEditor";
import type { InspectorProps } from "../index";

// Mirrors REQUIRED_TOPIC_LISTS in @splash/forms-schema/required-topics (the
// package root can only be imported as types from apps/web -- see CLAUDE.md).
const LISTS = [{ value: "safety_meeting", label: "Monthly safety meeting" }];

export default function RequiredTopicsInspector({ field, allFields, onUpdate }: InspectorProps) {
  const f = field as RequiredTopicsField;
  const dateFields = allFields.filter((o) => o.id !== f.id && o.type === "date");
  return (
    <div className="space-y-3">
      <LabeledInput label="Label" value={f.label} onChange={(v) => onUpdate({ label: v } as Partial<Field>)} />
      <KeyEditor value={f.key} onChange={(v) => onUpdate({ key: v } as Partial<Field>)} />
      <LabeledInput
        label="Help text"
        value={f.helpText ?? ""}
        onChange={(v) => onUpdate({ helpText: v || undefined } as Partial<Field>)}
      />
      <LabeledSelect
        label="Topic list"
        value={f.listKey}
        onChange={(v) => onUpdate({ listKey: v } as Partial<Field>)}
        options={LISTS}
      />
      <LabeledSelect
        label="Date field (its month picks the topics)"
        value={f.dateFieldKey}
        onChange={(v) => onUpdate({ dateFieldKey: v } as Partial<Field>)}
        options={[
          { value: "", label: "— Pick a field —" },
          ...dateFields.map((d) => ({ value: d.key, label: `${d.label || "(no label)"} · ${d.key}` }))
        ]}
      />
      <p className="-mt-1 text-xs text-splash-navy/60">
        Every topic set for that month must be ticked as covered. A month with no topics shows
        &ldquo;No required topics&rdquo;.
      </p>
    </div>
  );
}
