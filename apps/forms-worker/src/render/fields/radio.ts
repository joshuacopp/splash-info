import type { RadioField } from "@splash/forms-schema";
import type { RenderBodyArgs } from "../index.js";
import { fieldHelp, escapeHtml } from "../util.js";

/**
 * Single choice as a real radio group, not a select.
 *
 * WHY THIS EXISTS ALONGSIDE `dropdown`, which stores the identical payload:
 * answering a select is two taps and a scroll; answering a radio row is one
 * tap. That is noise on a 3-field form and the whole ergonomics of a 47-row
 * site-visit audit filled in on a tablet while walking a property.
 *
 * `layout: "inline"` puts the options on one line -- Pass / Fail / NA across,
 * label to the left -- which is what makes a long inspection list scannable.
 * It only reads well for short labels and few options, so vertical stays the
 * default.
 *
 * Renders as a <fieldset>/<legend> rather than a <label>, because a label
 * pointing at a group of inputs has no valid `for` target. Same reason
 * `multi` does it.
 */
export function renderRadio(field: RadioField, _ctx: RenderBodyArgs): string {
  const inline = field.layout === "inline";

  const optionsHtml = field.options
    .map((opt, idx) => {
      const optId = `${field.id}_${idx}`;
      // `required` goes on every input in the group: HTML5 treats a radio
      // group as satisfied when ANY input sharing the name is checked, so
      // marking them all is both correct and the most portable across
      // browsers. Submit-time validation remains the authoritative gate.
      return `<label class="field-radio-option" for="${escapeHtml(optId)}">
        <input type="radio" id="${escapeHtml(optId)}" name="${escapeHtml(field.key)}" value="${escapeHtml(opt.value)}" ${field.required ? "required" : ""} />
        <span>${escapeHtml(opt.label)}</span>
      </label>`;
    })
    .join("");

  return `
<fieldset class="field field-radio${inline ? " field-radio-inline" : ""}" data-field-key="${escapeHtml(field.key)}" data-field-type="radio">
  <legend class="field-label">${escapeHtml(field.label)}${field.required ? '<span class="field-required" aria-label="required">*</span>' : ""}</legend>
  <div class="field-radio-options">${optionsHtml}</div>
  ${fieldHelp(field)}
</fieldset>`;
}
