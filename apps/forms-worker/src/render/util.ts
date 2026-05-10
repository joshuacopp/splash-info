// Shared render helpers for the per-field-type modules.

import type { FieldBase } from "@splash/forms-schema";

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function fieldLabel(field: FieldBase): string {
  return `<label class="field-label" for="${escapeHtml(field.id)}">
    ${escapeHtml(field.label)}${field.required ? '<span class="field-required" aria-label="required">*</span>' : ""}
  </label>`;
}

export function fieldHelp(field: FieldBase): string {
  return field.helpText ? `<p class="field-help">${escapeHtml(field.helpText)}</p>` : "";
}
