// Display-only in-form image. No input, no payload. The asset URL is
// resolved from the R2 key convention `form-assets/{form_id}/{assetId}` —
// served by Brief 92's public asset route. For Brief 90 we render the
// expected URL; if no Brief 92 / asset upload yet exists the image will
// 404 in the browser but the rest of the form renders fine.

import type { ImageField } from "@splash/forms-schema";
import type { RenderBodyArgs } from "../index.js";
import { escapeHtml } from "../util.js";

export function renderImage(field: ImageField, ctx: RenderBodyArgs): string {
  const src = `/forms/api/asset/${encodeURIComponent(ctx.form.id)}/${encodeURIComponent(field.assetId)}`;
  const captionHtml = field.caption
    ? `<p class="field-image-caption">${escapeHtml(field.caption)}</p>`
    : "";
  return `
<div class="field-image-wrap" data-field-key="${escapeHtml(field.key)}" data-field-type="image">
  <img src="${escapeHtml(src)}" alt="${escapeHtml(field.altText)}" class="field-image field-image-${field.maxWidth}" />
  ${captionHtml}
</div>`;
}
