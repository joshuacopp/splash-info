// Brief 90 (initial render) + Brief 93 (mode-aware variants + dynamic
// resolve). Three render shapes per planning Decision 5a:
//   - prefill_hidden  → <input type="hidden">; client-side JS sets value
//                       silently after the key field changes; submit
//                       handler re-resolves the canonical value anyway.
//   - prefill_visible → disabled <input type="text"> with placeholder;
//                       client populates visibly when the key field
//                       changes; submit handler re-resolves canonical.
//   - display_only    → styled <div> callout instead of an input;
//                       client populates visibly; submit handler drops
//                       the key (no payload entry).
//
// `data-lookup-field-id` carries the field.id so the client JS can route
// resolves back to the right element via /forms/api/lookup/{slug}.

import type { LookupField } from "@splash/forms-schema";
import type { RenderBodyArgs } from "../index.js";
import { fieldLabel, fieldHelp, escapeHtml } from "../util.js";

export function renderLookup(field: LookupField, ctx: RenderBodyArgs): string {
  const keyField = ctx.version.schema.fields.find((f) => f.id === field.keyFieldId);
  const keyFieldLabel = keyField ? keyField.label : "the key field";

  const dataAttrs =
    `data-field-key="${escapeHtml(field.key)}" ` +
    `data-field-type="lookup" ` +
    `data-lookup-field-id="${escapeHtml(field.id)}" ` +
    `data-lookup-key-field="${escapeHtml(field.keyFieldId)}" ` +
    `data-lookup-key-column="${escapeHtml(field.keyColumn)}" ` +
    `data-lookup-source-table="${escapeHtml(field.sourceTable)}" ` +
    `data-lookup-source-column="${escapeHtml(field.sourceColumn)}" ` +
    `data-lookup-resolution-mode="${escapeHtml(field.resolutionMode)}" ` +
    `data-lookup-null-behavior="${escapeHtml(field.nullBehavior)}"`;

  if (field.resolutionMode === "prefill_hidden") {
    // No visible UI. Hidden input carries the resolved value forward; the
    // submit handler ignores it anyway (server-side re-resolve), so this
    // is purely so the form data round-trips.
    return `
<div class="field" ${dataAttrs}>
  <input type="hidden" name="${escapeHtml(field.key)}" id="${escapeHtml(field.id)}" value="" />
</div>`;
  }

  if (field.resolutionMode === "display_only") {
    // Callout div instead of an input. No `name` attr — the value
    // doesn't need to round-trip; submit handler drops the key.
    return `
<div class="field field-display-only" ${dataAttrs}>
  ${fieldLabel(field)}
  <div class="field-display-value" id="${escapeHtml(field.id)}">
    <em>Select ${escapeHtml(keyFieldLabel)} to populate</em>
  </div>
  ${fieldHelp(field)}
</div>`;
  }

  // prefill_visible
  return `
<div class="field" ${dataAttrs}>
  ${fieldLabel(field)}
  <input type="text"
         name="${escapeHtml(field.key)}"
         id="${escapeHtml(field.id)}"
         class="field-input field-lookup-disabled"
         disabled
         placeholder="Select ${escapeHtml(keyFieldLabel)} to populate" />
  ${fieldHelp(field)}
</div>`;
}
