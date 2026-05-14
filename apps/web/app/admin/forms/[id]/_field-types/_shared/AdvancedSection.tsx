// Brief 129 — Advanced section beneath every per-field-type Inspector.
//
// Renders a `<details>` collapsed by default with the per-field
// `exclude_from_pdf` checkbox inside. Wired through the shared `Field`
// type so every Inspector picks it up via the parent `FieldInspector`
// wrapper without each per-type module needing to import it directly
// (keeps the brief's 16 per-type Inspectors lean — implementation tweak
// from the brief's "every Inspector imports it" wording; same operator-
// facing behavior).
//
// The exclude flag is harmless on display-only `image` fields (PDF
// generator never renders images anyway) and on `hidden` fields (hidden
// fields with values still ride the PDF unless excluded). Both are
// retained at v1 for forward-compat per the brief.

"use client";

import type { Field } from "@splash/forms-schema";

import LabeledCheckbox from "./LabeledCheckbox";

interface Props {
  field: Field;
  onUpdate: (patch: Partial<Field>) => void;
}

export default function AdvancedSection({ field, onUpdate }: Props) {
  const exclude =
    Boolean((field as { exclude_from_pdf?: boolean }).exclude_from_pdf) ||
    false;
  return (
    <details className="rounded-splash-sm border border-gray-light bg-gray-50 px-3 py-2 text-sm text-splash-navy">
      <summary className="cursor-pointer font-semibold">Advanced</summary>
      <div className="mt-2 space-y-2">
        <LabeledCheckbox
          label="Don't include in PDF exports"
          checked={exclude}
          onChange={(v) =>
            onUpdate({ exclude_from_pdf: v || undefined } as Partial<Field>)
          }
          hint="Useful for internal-only fields that shouldn't appear on emailed PDFs."
        />
      </div>
    </details>
  );
}
