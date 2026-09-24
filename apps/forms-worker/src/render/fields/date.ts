import type { DateField } from "@splash/forms-schema";
import type { RenderBodyArgs } from "../index.js";
import { fieldLabel, fieldHelp, escapeHtml } from "../util.js";
import { easternToday } from "../eastern.js";

export function renderDate(field: DateField, _ctx: RenderBodyArgs): string {
  const min = field.minDate ? `min="${escapeHtml(field.minDate)}"` : "";
  const max = field.maxDate ? `max="${escapeHtml(field.maxDate)}"` : "";
  // Eastern, not UTC: the worker runs in UTC and would pre-fill TOMORROW
  // from 8pm Eastern onward. See ../eastern.ts.
  const value = field.defaultToToday ? `value="${easternToday()}"` : "";
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
