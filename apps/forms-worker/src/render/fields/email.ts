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

// noAutofill: a plain text input with the email keyboard. Chrome may still
// autofill a type="email" box despite autocomplete="off", and on a shared
// site tablet the saved address is the wrong person's. The pattern attribute
// still checks the address in the browser; the server validates it as an
// email either way (payload.ts).
export function renderEmail(field: EmailField, _ctx: RenderBodyArgs): string {
  const maxLength = field.maxLength ?? 254;
  return `
<div class="field" data-field-key="${escapeHtml(field.key)}" data-field-type="email">
  ${fieldLabel(field)}
  <input type="${field.noAutofill ? "text" : "email"}"${field.noAutofill ? ' inputmode="email" spellcheck="false" autocapitalize="off"' : ""}
         name="${escapeHtml(field.key)}"
         id="${escapeHtml(field.id)}"
         class="field-input"
         autocomplete="${field.noAutofill ? "off" : "email"}"${field.noAutofill ? ' data-lpignore="true" data-1p-ignore' : ""}
         maxlength="${maxLength}"
         pattern="${EMAIL_PATTERN}"
         title="Please enter a valid email address."
         ${field.required ? "required" : ""} />
  ${fieldHelp(field)}
</div>`;
}
