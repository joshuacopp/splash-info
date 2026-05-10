import type { HiddenField } from "@splash/forms-schema";
import type { RenderBodyArgs } from "../index.js";
import { escapeHtml } from "../util.js";

export function renderHidden(field: HiddenField, ctx: RenderBodyArgs): string {
  let value = field.defaultValue ?? "";
  if (field.defaultValueFromUrlParam) {
    const fromUrl = ctx.urlParams.get(field.defaultValueFromUrlParam);
    if (fromUrl !== null) value = fromUrl;
  }
  return `<input type="hidden" name="${escapeHtml(field.key)}" id="${escapeHtml(field.id)}" value="${escapeHtml(value)}" />`;
}
