import type { ShortTextField } from "@splash/forms-schema";
import type { RenderBodyArgs } from "../index.js";
import { fieldLabel, fieldHelp, escapeHtml } from "../util.js";

export function renderShortText(field: ShortTextField, _ctx: RenderBodyArgs): string {
  const maxLength = field.maxLength ?? 500;
  const placeholder = field.placeholder ? `placeholder="${escapeHtml(field.placeholder)}"` : "";
  return `
<div class="field" data-field-key="${escapeHtml(field.key)}" data-field-type="short_text">
  ${fieldLabel(field)}
  <input type="text"
         name="${escapeHtml(field.key)}"
         id="${escapeHtml(field.id)}"
         class="field-input"
         maxlength="${maxLength}"
         ${placeholder}
         ${field.required ? "required" : ""} />
  ${fieldHelp(field)}
</div>`;
}
