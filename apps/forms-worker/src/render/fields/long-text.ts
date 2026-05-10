import type { LongTextField } from "@splash/forms-schema";
import type { RenderBodyArgs } from "../index.js";
import { fieldLabel, fieldHelp, escapeHtml } from "../util.js";

export function renderLongText(field: LongTextField, _ctx: RenderBodyArgs): string {
  const maxLength = field.maxLength ?? 10000;
  const rows = field.rows ?? 4;
  const placeholder = field.placeholder ? `placeholder="${escapeHtml(field.placeholder)}"` : "";
  return `
<div class="field" data-field-key="${escapeHtml(field.key)}" data-field-type="long_text">
  ${fieldLabel(field)}
  <textarea name="${escapeHtml(field.key)}"
            id="${escapeHtml(field.id)}"
            class="field-textarea"
            maxlength="${maxLength}"
            rows="${rows}"
            ${placeholder}
            ${field.required ? "required" : ""}></textarea>
  ${fieldHelp(field)}
</div>`;
}
