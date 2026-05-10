// Brief 90 renders a plain file input. Brief 92 wires the upload
// (POST /forms/api/upload, R2 write, preview rendering, error display).

import type { FileField } from "@splash/forms-schema";
import type { RenderBodyArgs } from "../index.js";
import { fieldLabel, fieldHelp, escapeHtml } from "../util.js";

export function renderFile(field: FileField, _ctx: RenderBodyArgs): string {
  const accept = (field.allowedMimeTypes ?? ["image/*", "application/pdf"]).join(",");
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
