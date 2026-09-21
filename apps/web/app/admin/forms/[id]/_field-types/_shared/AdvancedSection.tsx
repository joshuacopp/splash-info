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

/** Display-only types carry no payload, so there is nothing to show in a queue
 *  column. Offering the checkbox on them would be an option that silently does
 *  nothing. */
const DISPLAY_ONLY: ReadonlyArray<string> = ["heading", "image"];

export default function AdvancedSection({ field, onUpdate }: Props) {
  const exclude =
    Boolean((field as { exclude_from_pdf?: boolean }).exclude_from_pdf) ||
    false;
  const inQueue =
    Boolean((field as { show_in_queue?: boolean }).show_in_queue) || false;
  const canShowInQueue = !DISPLAY_ONLY.includes(field.type);

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
        {canShowInQueue ? (
          <LabeledCheckbox
            label="Show as a column on the approvals queue"
            checked={inQueue}
            onChange={(v) =>
              onUpdate({ show_in_queue: v || undefined } as Partial<Field>)
            }
            hint="Lets someone working the queue tell tickets apart without opening each one. Up to 5 fields per form; pick the ones that identify a ticket, not the ones needed to action it."
          />
        ) : null}
      </div>
    </details>
  );
}
