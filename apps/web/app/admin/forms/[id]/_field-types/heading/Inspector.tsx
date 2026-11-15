"use client";

import type { Field, HeadingField } from "@splash/forms-schema";
import LabeledInput from "../_shared/LabeledInput";
import LabeledSelect from "../_shared/LabeledSelect";
import LabeledTextarea from "../_shared/LabeledTextarea";
import KeyEditor from "../_shared/KeyEditor";
import type { InspectorProps } from "../index";

export default function HeadingInspector({ field, onUpdate }: InspectorProps) {
  const f = field as HeadingField;
  return (
    <div className="space-y-3">
      <KeyEditor
        value={f.key}
        onChange={(v) => onUpdate({ key: v } as Partial<Field>)}
        hint="Internal key — display-only fields never appear in submission payload."
      />
      <LabeledInput
        label="Heading text"
        value={f.text}
        onChange={(v) => onUpdate({ text: v } as Partial<Field>)}
      />
      <LabeledSelect
        label="Level"
        value={f.level}
        onChange={(v) =>
          onUpdate({ level: v as HeadingField["level"] } as Partial<Field>)
        }
        options={[
          { value: "h1", label: "H1 — page title size" },
          { value: "h2", label: "H2 — section title (default)" },
          { value: "h3", label: "H3 — sub-section" },
          { value: "h4", label: "H4 — minor heading" }
        ]}
      />
      <LabeledTextarea
        label="Text under the heading (optional)"
        value={f.helpText ?? ""}
        rows={4}
        onChange={(v) => onUpdate({ helpText: v || undefined } as Partial<Field>)}
        hint="A block of reading text, e.g. instructions or rights someone reads before signing. Leave a blank line between paragraphs."
      />
    </div>
  );
}
