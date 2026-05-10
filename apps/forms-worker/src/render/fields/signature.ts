// Brief 90 renders the canvas markup. Brief 92 wires signature_pad,
// the Clear button handler, and the upload-to-R2 flow.

import type { SignatureField } from "@splash/forms-schema";
import type { RenderBodyArgs } from "../index.js";
import { fieldLabel, fieldHelp, escapeHtml } from "../util.js";

export function renderSignature(field: SignatureField, _ctx: RenderBodyArgs): string {
  return `
<div class="field" data-field-key="${escapeHtml(field.key)}" data-field-type="signature"
     data-format="${escapeHtml(field.format)}"
     data-pen-color="${escapeHtml(field.penColor ?? "#000000")}"
     data-min-strokes="${field.minStrokes ?? 1}">
  ${fieldLabel(field)}
  <canvas class="field-signature-canvas" id="signature-${escapeHtml(field.id)}" width="600" height="180"></canvas>
  <input type="hidden" name="${escapeHtml(field.key)}" id="signature-input-${escapeHtml(field.id)}" />
  <div class="field-signature-clear">
    <button type="button" class="signature-clear-btn" data-target="${escapeHtml(field.id)}">Clear signature</button>
  </div>
  ${fieldHelp(field)}
</div>`;
}
