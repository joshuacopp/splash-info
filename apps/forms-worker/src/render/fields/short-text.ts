import type { ShortTextField } from "@splash/forms-schema";
import type { RenderBodyArgs } from "../index.js";
import { fieldLabel, fieldHelp, escapeHtml } from "../util.js";

export function renderShortText(field: ShortTextField, _ctx: RenderBodyArgs): string {
  const maxLength = field.maxLength ?? 500;
  const placeholder = field.placeholder ? `placeholder="${escapeHtml(field.placeholder)}"` : "";
  const value = field.defaultValue ? `value="${escapeHtml(field.defaultValue)}"` : "";
  // numeric: number keypad + a browser-side shape check; the server re-checks
  // the shape and the bounds (validators/payload.ts).
  const num = field.numeric;
  const numericAttrs = num
    ? `inputmode="${num.integer ? "numeric" : "decimal"}" pattern="${num.integer ? "\\d+" : "\\d+(\\.\\d+)?"}" title="Numbers only"`
    : "";
  return `
<div class="field" data-field-key="${escapeHtml(field.key)}" data-field-type="short_text">
  ${fieldLabel(field)}
  <input type="text"
         name="${escapeHtml(field.key)}"
         id="${escapeHtml(field.id)}"
         class="field-input"
         maxlength="${maxLength}"
         ${placeholder}
         ${value}
         ${numericAttrs}
         ${field.required ? "required" : ""} />
  ${fieldHelp(field)}
</div>`;
}
