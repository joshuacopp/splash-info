import type { EmployeeField } from "@splash/forms-schema";
import type { RenderBodyArgs } from "../index.js";
import { fieldHelp, escapeHtml } from "../util.js";

/**
 * Employee picker (PLAN_FORMS_PERSONNEL.md phase 2). forms-public.js
 * (wireEmployees) searches /forms/api/employees/{slug} as the filler types,
 * scoped to the site the form's site field names.
 *
 * THE SUBMITTED VALUE IS ONE HIDDEN INPUT holding JSON ({id, name}), kept by
 * the script; the visible search box carries no `name`, so a half-typed search
 * is never submitted. Same pattern as the price grid, and for the same reason:
 * draft resume restores named inputs, and the script redraws the chosen
 * person from the restored hidden value.
 *
 * Without the script nothing can be picked; the server requires a value only
 * when the field is required, and re-checks whatever arrives.
 */
export function renderEmployee(field: EmployeeField, _ctx: RenderBodyArgs): string {
  const id = `f_${escapeHtml(field.key)}`;
  const allowTyped = field.allowTyped !== false;
  return `
<div class="field field-employee" data-field-key="${escapeHtml(field.key)}" data-field-type="employee"
     data-emp-key-field="${escapeHtml(field.keyFieldKey)}" data-emp-allow-typed="${allowTyped ? "1" : "0"}">
  <label class="field-label" for="${id}">${escapeHtml(field.label)}${field.required ? '<span class="field-required" aria-label="required">*</span>' : ""}</label>
  ${fieldHelp(field)}
  <input type="hidden" name="${escapeHtml(field.key)}" value="" data-emp-value="1"${field.required ? ' data-emp-required="1"' : ""} />
  <div class="emp-chosen" data-emp-chosen="1" hidden></div>
  <input type="text" id="${id}" class="field-input" autocomplete="off" data-emp-search="1"
         placeholder="Choose a site above, then type a name" aria-autocomplete="list" />
  <div class="emp-results" data-emp-results="1" role="listbox" hidden></div>
  <p class="emp-msg" data-emp-msg="1" hidden></p>
</div>`;
}
