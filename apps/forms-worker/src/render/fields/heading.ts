// Display-only heading. No input element, no payload.

import type { HeadingField } from "@splash/forms-schema";
import type { RenderBodyArgs } from "../index.js";
import { escapeHtml } from "../util.js";

export function renderHeading(field: HeadingField, _ctx: RenderBodyArgs): string {
  const tag = field.level;
  return `<${tag} class="field-heading-${field.level}" data-field-key="${escapeHtml(field.key)}">${escapeHtml(field.text)}</${tag}>`;
}
