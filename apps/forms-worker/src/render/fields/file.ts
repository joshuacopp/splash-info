// Brief 90 renders a plain file input. Brief 92 wires the upload
// (POST /forms/api/upload, R2 write, preview rendering, error display).

import type { FileField } from "@splash/forms-schema";
import type { RenderBodyArgs } from "../index.js";
import { fieldLabel, fieldHelp, escapeHtml } from "../util.js";

export function renderFile(field: FileField, _ctx: RenderBodyArgs): string {
  const accept = (field.allowedMimeTypes ?? ["image/*", "application/pdf"]).join(",");
  if (field.allowMultiple) {
    // Each picked file uploads on its own and joins a list the submitter can
    // prune; the hidden `${key}_r2` input carries the JSON array of r2_keys.
    // The picker itself is cleared after each pick, so it has no `name` and no
    // `required` (a required-but-empty picker would block a form that already
    // has files) -- the server enforces "at least one" when the field is
    // required.
    return `
<div class="field" data-field-key="${escapeHtml(field.key)}" data-field-type="file" data-multiple="1"
     data-field-max-size-mb="${field.maxSizeMb ?? 10}">
  ${fieldLabel(field)}
  <input type="file"
         id="${escapeHtml(field.id)}"
         class="field-file-input"
         accept="${escapeHtml(accept)}"
         multiple />
  <input type="hidden" name="${escapeHtml(field.key)}_r2" value="" data-r2-key="1" />
  <ul class="field-file-list" data-file-list="1"></ul>
  ${fieldHelp(field)}
</div>`;
  }
  return `
<div class="field" data-field-key="${escapeHtml(field.key)}" data-field-type="file"
     data-field-max-size-mb="${field.maxSizeMb ?? 10}">
  ${fieldLabel(field)}
  <input type="file"
         name="${escapeHtml(field.key)}"
         id="${escapeHtml(field.id)}"
         class="field-file-input"
         accept="${escapeHtml(accept)}"
         ${field.allowMultiple ? "multiple" : ""}
         ${field.required ? "required" : ""} />
  ${fieldHelp(field)}
</div>`;
}
