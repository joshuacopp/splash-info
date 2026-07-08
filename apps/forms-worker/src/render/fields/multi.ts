import type { MultiField } from "@splash/forms-schema";
import type { RenderBodyArgs } from "../index.js";
import { fieldLabel, fieldHelp, escapeHtml } from "../util.js";

export function renderMulti(field: MultiField, _ctx: RenderBodyArgs): string {
  // Multi-select renders as a checkbox group. Each checkbox shares the
  // same `name` so FormData's `getAll(name)` returns the array.
  const optionsHtml = field.options
    .map((opt, idx) => {
      const optId = `${field.id}_${idx}`;
      return `<label class="field-multi-option" for="${escapeHtml(optId)}">
        <input type="checkbox" id="${escapeHtml(optId)}" name="${escapeHtml(field.key)}" value="${escapeHtml(opt.value)}" />
        <span>${escapeHtml(opt.label)}</span>
      </label>`;
    })
    .join("");
  // Note: HTML5's `required` on checkboxes means "at least one must be
  // checked" but only when ALL inputs in the group share a name AND the
  // attribute. Browsers vary; submit-time validation in Brief 91 is the
  // authoritative gate for `required` + `minSelected`.
  // When min and max are both set and equal, the two hints ("at least N" +
  // "at most N") are redundant, so collapse them into a single "N".
  const hasMin = field.minSelected != null && field.minSelected > 0;
  const hasMax = field.maxSelected != null;
  const exact = hasMin && hasMax && field.minSelected === field.maxSelected;
  const minHint = exact
    ? `<p class="field-help">Select ${field.minSelected}</p>`
    : hasMin
      ? `<p class="field-help">Select at least ${field.minSelected}.</p>`
      : "";
  const maxHint = !exact && hasMax
    ? `<p class="field-help">Select at most ${field.maxSelected}.</p>`
    : "";
  return `
<fieldset class="field" data-field-key="${escapeHtml(field.key)}" data-field-type="multi"
          data-min-selected="${field.minSelected ?? 0}"
          ${field.maxSelected != null ? `data-max-selected="${field.maxSelected}"` : ""}>
  <legend class="field-label">${escapeHtml(field.label)}${field.required ? '<span class="field-required" aria-label="required">*</span>' : ""}</legend>
  ${optionsHtml}
  ${minHint}
  ${maxHint}
  ${fieldHelp(field)}
</fieldset>`;
}
