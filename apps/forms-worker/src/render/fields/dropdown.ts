import type { DropdownField } from "@splash/forms-schema";
import type { RenderBodyArgs } from "../index.js";
import { fieldLabel, fieldHelp, escapeHtml } from "../util.js";

export function renderDropdown(field: DropdownField, _ctx: RenderBodyArgs): string {
  const placeholder = field.placeholder ?? "— Select —";
  const optionsHtml = field.options
    .map((opt) => `<option value="${escapeHtml(opt.value)}">${escapeHtml(opt.label)}</option>`)
    .join("");
  return `
<div class="field" data-field-key="${escapeHtml(field.key)}" data-field-type="dropdown">
  ${fieldLabel(field)}
  <select name="${escapeHtml(field.key)}" id="${escapeHtml(field.id)}" class="field-select" ${field.required ? "required" : ""}>
    <option value="">${escapeHtml(placeholder)}</option>
    ${optionsHtml}
  </select>
  ${fieldHelp(field)}
</div>`;
}
