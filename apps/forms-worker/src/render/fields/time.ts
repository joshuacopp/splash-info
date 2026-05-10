import type { TimeField } from "@splash/forms-schema";
import type { RenderBodyArgs } from "../index.js";
import { fieldLabel, fieldHelp, escapeHtml } from "../util.js";

export function renderTime(field: TimeField, _ctx: RenderBodyArgs): string {
  const min = field.minTime ? `min="${escapeHtml(field.minTime)}"` : "";
  const max = field.maxTime ? `max="${escapeHtml(field.maxTime)}"` : "";
  return `
<div class="field" data-field-key="${escapeHtml(field.key)}" data-field-type="time">
  ${fieldLabel(field)}
  <input type="time"
         name="${escapeHtml(field.key)}"
         id="${escapeHtml(field.id)}"
         class="field-input"
         ${min} ${max}
         ${field.required ? "required" : ""} />
  ${fieldHelp(field)}
</div>`;
}
