import type { PhoneField } from "@splash/forms-schema";
import type { RenderBodyArgs } from "../index.js";
import { fieldLabel, fieldHelp, escapeHtml } from "../util.js";

export function renderPhone(field: PhoneField, _ctx: RenderBodyArgs): string {
  return `
<div class="field" data-field-key="${escapeHtml(field.key)}" data-field-type="phone">
  ${fieldLabel(field)}
  <input type="tel"
         name="${escapeHtml(field.key)}"
         id="${escapeHtml(field.id)}"
         class="field-input"
         autocomplete="tel"
         pattern="\\d{10}"
         maxlength="14"
         placeholder="10 digits, no formatting"
         ${field.required ? "required" : ""} />
  ${fieldHelp(field)}
</div>`;
}
