import type { RequiredTopicsField } from "@splash/forms-schema";
import type { RenderBodyArgs } from "../index.js";
import { fieldHelp, escapeHtml } from "../util.js";

/**
 * Committee-set topics for the month of the form's date field (2026-11-18).
 * forms-public.js (wireRequiredTopics) fetches the list from
 * /forms/api/required-topics/{slug} whenever the date changes and draws one
 * "Covered" checkbox per topic. The checkboxes carry no `name`: the ticked
 * topics live in ONE hidden JSON input so a draft resume can restore ticks
 * even before the list has loaded. The server re-reads the list at submit and
 * refuses an un-ticked topic.
 */
export function renderRequiredTopics(field: RequiredTopicsField, _ctx: RenderBodyArgs): string {
  return `
<div class="field field-required-topics" data-field-key="${escapeHtml(field.key)}" data-field-type="required_topics"
     data-rt-date-field="${escapeHtml(field.dateFieldKey)}">
  <div class="field-label">${escapeHtml(field.label)}</div>
  ${fieldHelp(field)}
  <input type="hidden" name="${escapeHtml(field.key)}" value="[]" data-rt-value="1" />
  <div class="rt-list" data-rt-list="1"><p class="rt-empty">Loading this month's required topics&hellip;</p></div>
</div>`;
}
