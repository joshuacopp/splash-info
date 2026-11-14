// Display-only heading. No input element, no payload.

import type { HeadingField } from "@splash/forms-schema";
import type { RenderBodyArgs } from "../index.js";
import { escapeHtml } from "../util.js";

export function renderHeading(field: HeadingField, _ctx: RenderBodyArgs): string {
  const tag = field.level;
  // helpText under a heading is a block of reading text (e.g. the rights the
  // employee reads before signing); blank lines separate paragraphs.
  const body = field.helpText
    ? `<p class="field-help" style="white-space:pre-line">${escapeHtml(field.helpText)}</p>`
    : "";
  return `<${tag} class="field-heading-${field.level}" data-field-key="${escapeHtml(field.key)}">${escapeHtml(field.text)}</${tag}>${body}`;
}
