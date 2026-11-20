import { ATTENDANCE_MAX_ROWS, type AttendanceField } from "@splash/forms-schema";
import type { RenderBodyArgs } from "../index.js";
import { fieldHelp, escapeHtml } from "../util.js";

/**
 * Attendance sheet (2026-11-18). forms-public.js (wireAttendance) builds the
 * rows -- each an employee search (same roster search as the employee field)
 * plus a signature pad -- and keeps ONE hidden input of JSON in step:
 * [{employee: {id, name} | null, sig: r2_key | ""}, ...].
 *
 * Rows are only ever added, never removed, so each row's index -- and with it
 * the R2 key its signature uploads under (`${key}__sig_${n}`) -- stays stable
 * for the life of the page and across a draft resume. A row left blank is
 * simply ignored at submit.
 */
export function renderAttendance(field: AttendanceField, _ctx: RenderBodyArgs): string {
  const allowTyped = field.allowTyped !== false;
  const initial = Math.min(field.initialRows ?? 5, ATTENDANCE_MAX_ROWS);
  return `
<div class="field field-attendance" data-field-key="${escapeHtml(field.key)}" data-field-type="attendance"
     data-emp-key-field="${escapeHtml(field.keyFieldKey)}" data-emp-allow-typed="${allowTyped ? "1" : "0"}"
     data-att-initial="${initial}" data-att-max="${ATTENDANCE_MAX_ROWS}">
  <div class="field-label">${escapeHtml(field.label)}${field.required ? '<span class="field-required" aria-label="required">*</span>' : ""}</div>
  ${fieldHelp(field)}
  <input type="hidden" name="${escapeHtml(field.key)}" value="" data-att-value="1" />
  <ol class="att-rows" data-att-rows="1"></ol>
  <button type="button" class="att-add-btn" data-att-add="1">+ Add employee</button>
  <noscript><p class="emp-msg">This sign-in sheet needs JavaScript turned on.</p></noscript>
</div>`;
}
