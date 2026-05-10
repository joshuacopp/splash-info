// Location picker — pre-baked dropdown sourced from `pricing_simple`
// at render time. The payload value is always the `location_code` slug
// regardless of `displayFormat`.

import type { LocationField } from "@splash/forms-schema";
import type { RenderBodyArgs } from "../index.js";
import { fieldLabel, fieldHelp, escapeHtml } from "../util.js";

export function renderLocation(field: LocationField, ctx: RenderBodyArgs): string {
  const optionsHtml = ctx.locationOptions
    .map((loc) => {
      let display = loc.pretty;
      if (field.displayFormat === "name_and_address") {
        display = loc.address ? `${loc.pretty} — ${loc.address}` : loc.pretty;
      } else if (field.displayFormat === "site_number") {
        display = loc.site ? `${loc.site} — ${loc.pretty}` : loc.pretty;
      }
      return `<option value="${escapeHtml(loc.code)}">${escapeHtml(display)}</option>`;
    })
    .join("");
  return `
<div class="field" data-field-key="${escapeHtml(field.key)}" data-field-type="location">
  ${fieldLabel(field)}
  <select name="${escapeHtml(field.key)}" id="${escapeHtml(field.id)}" class="field-select" ${field.required ? "required" : ""}>
    <option value="">— Select a location —</option>
    ${optionsHtml}
  </select>
  ${fieldHelp(field)}
</div>`;
}
