import type { EmailField } from "@splash/forms-schema";
import type { RenderBodyArgs } from "../index.js";
import { fieldLabel, fieldHelp, escapeHtml } from "../util.js";

export function renderEmail(field: EmailField, _ctx: RenderBodyArgs): string {
  const maxLength = field.maxLength ?? 254;
  return `
<div class="field" data-field-key="${escapeHtml(field.key)}" data-field-type="email">
  ${fieldLabel(field)}
  <input type="email"
         name="${escapeHtml(field.key)}"
         id="${escapeHtml(field.id)}"
         class="field-input"
         autocomplete="email"
         maxlength="${maxLength}"
         pattern="^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$"
         ${field.required ? "required" : ""} />
  ${fieldHelp(field)}
</div>`;
}
