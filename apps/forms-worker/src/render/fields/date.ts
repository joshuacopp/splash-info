import type { DateField } from "@splash/forms-schema";
import type { RenderBodyArgs } from "../index.js";
import { fieldLabel, fieldHelp, escapeHtml } from "../util.js";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function renderDate(field: DateField, _ctx: RenderBodyArgs): string {
  const min = field.minDate ? `min="${escapeHtml(field.minDate)}"` : "";
  const max = field.maxDate ? `max="${escapeHtml(field.maxDate)}"` : "";
  const value = field.defaultToToday ? `value="${todayIso()}"` : "";
  return `
<div class="field" data-field-key="${escapeHtml(field.key)}" data-field-type="date">
  ${fieldLabel(field)}
  <input type="date"
         name="${escapeHtml(field.key)}"
         id="${escapeHtml(field.id)}"
         class="field-input"
         ${min} ${max} ${value}
         ${field.required ? "required" : ""} />
  ${fieldHelp(field)}
</div>`;
}
