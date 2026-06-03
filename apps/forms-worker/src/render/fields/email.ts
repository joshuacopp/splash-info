import type { EmailField } from "@splash/forms-schema";
import type { RenderBodyArgs } from "../index.js";
import { fieldLabel, fieldHelp, escapeHtml } from "../util.js";

// Brief 152: HTML5 `pattern` attribute mirrors EMAIL_REGEX in
// @splash/types/email-validate (also duplicated as EMAIL_RE in
// @splash/forms-schema/src/validators/payload.ts). Rejects leading /
// trailing / consecutive dots in local-part that the browser's native
// type="email" validator otherwise accepts. If you change one, change
// all three.
const EMAIL_PATTERN =
  "^[A-Za-z0-9](?:[A-Za-z0-9_+-]|\\.(?=[A-Za-z0-9_+-]))*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\\.)+[A-Za-z]{2,}$";

export function renderEmail(field: EmailField, _ctx: RenderBodyArgs): string {
  const maxLength = field.maxLength ?? 254;
  return `
<div class="field" data-field-key="${escapeHtml(field.key)}" data-field-type="email">
  ${fieldLabel(field)}
  <input type="email"
         name="${escapeHtml(field.key)}"
         id="${escapeHtml(field.id)}"
         class="field-input"
         autocomplete="email"
         maxlength="${maxLength}"
         pattern="${EMAIL_PATTERN}"
         title="Please enter a valid email address."
         ${field.required ? "required" : ""} />
  ${fieldHelp(field)}
</div>`;
}
