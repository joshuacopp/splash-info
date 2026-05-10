// Form body renderer — iterates the schema's fields, dispatches each to its
// per-type render module, wraps the result in a <form> with the submit
// button + (when audience === "public") the Turnstile widget.

import type { FormMeta, FormVersion, LocationOption } from "@splash/forms-schema";
import { renderField } from "./fields/index.js";
import { escapeHtml } from "./util.js";

export interface RenderBodyArgs {
  form: FormMeta;
  version: FormVersion;
  /** Pre-baked option list for any Location-type fields. Empty when the
   *  schema contains no Location field. */
  locationOptions: LocationOption[];
  /** UUID generated at render time; client uses it as the FormData key
   *  for upload routing in Brief 92 + the submit-idempotency key in
   *  Brief 91. */
  pendingSubmissionId: string;
  /** When set, the Turnstile <div class="cf-turnstile"> is rendered. */
  turnstileSiteKey?: string;
  /** URL search params from the GET; consumed by Hidden fields'
   *  `defaultValueFromUrlParam`. */
  urlParams: URLSearchParams;
}

export function renderFormBody(args: RenderBodyArgs): string {
  const fieldsHtml = args.version.schema.fields
    .map((field) => renderField(field, args))
    .join("\n");

  const turnstileWidget = args.turnstileSiteKey
    ? `<div class="turnstile-wrap"><div class="cf-turnstile" data-sitekey="${escapeHtml(args.turnstileSiteKey)}"></div></div>`
    : "";

  return `
<form action="/forms/api/submit/${escapeHtml(args.form.slug)}" method="post" enctype="multipart/form-data" class="forms-body">
  <input type="hidden" name="pending_submission_id" value="${escapeHtml(args.pendingSubmissionId)}" />
  ${fieldsHtml}
  ${turnstileWidget}
  <button type="submit" class="submit-btn">Submit</button>
</form>
`;
}
