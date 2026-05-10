import type { NameField } from "@splash/forms-schema";
import type { RenderBodyArgs } from "../index.js";
import { fieldLabel, fieldHelp, escapeHtml } from "../util.js";

export function renderName(field: NameField, _ctx: RenderBodyArgs): string {
  const maxLength = field.maxLength ?? 120;
  return `
<div class="field" data-field-key="${escapeHtml(field.key)}" data-field-type="name">
  ${fieldLabel(field)}
  <input type="text"
         name="${escapeHtml(field.key)}"
         id="${escapeHtml(field.id)}"
         class="field-input"
         autocomplete="name"
         maxlength="${maxLength}"
         ${field.required ? "required" : ""} />
  ${fieldHelp(field)}
</div>`;
}
