// Per-field-type render dispatcher. The discriminated `Field` union in
// `@splash/forms-schema` makes this switch exhaustive at compile time —
// adding a 17th field type is a TypeScript error here until the new case
// lands.

import {
  actionItemInputName,
  actionItemNoteInputName,
  type Field
} from "@splash/forms-schema";
import { escapeHtml } from "../util.js";
import type { RenderBodyArgs } from "../index.js";

import { renderHeading } from "./heading.js";
import { renderImage } from "./image.js";
import { renderName } from "./name.js";
import { renderEmail } from "./email.js";
import { renderPhone } from "./phone.js";
import { renderShortText } from "./short-text.js";
import { renderLongText } from "./long-text.js";
import { renderHidden } from "./hidden.js";
import { renderDropdown } from "./dropdown.js";
import { renderRadio } from "./radio.js";
import { renderMulti } from "./multi.js";
import { renderDate } from "./date.js";
import { renderTime } from "./time.js";
import { renderFile } from "./file.js";
import { renderSignature } from "./signature.js";
import { renderLocation } from "./location.js";
import { renderLookup } from "./lookup.js";

/**
 * Brief 176 — the "Create action item" checkbox.
 *
 * Emitted HERE rather than inside each of the 17 field renderers, for the same
 * reason AdvancedSection is wired once into the Inspector wrapper: a flag every
 * field type inherits should be implemented once, or the 18th field type
 * silently lacks it.
 *
 * Display-only types carry no payload and cannot spawn an action item, so they
 * never get one regardless of the flag.
 */
function actionItemCheckbox(field: Field): string {
  if (!field.action_item_eligible) return "";
  if (field.type === "heading" || field.type === "image") return "";
  const name = actionItemInputName(field.key);
  const noteName = actionItemNoteInputName(field.key);
  const id = `${field.id}__ai`;
  // The note reveals on tick via a CSS sibling selector, NOT JavaScript. It is
  // the one control whose absence silently destroys the feature's value, and
  // this form has already been broken once by a stale cached script. The
  // checkbox is a direct child rather than nested in the <label> so
  // `:checked ~ .field-action-item-note` can reach it.
  return `
<div class="field-action-item">
  <input type="checkbox" id="${escapeHtml(id)}" name="${escapeHtml(name)}" value="1" />
  <label for="${escapeHtml(id)}">Create action item</label>
  <textarea class="field-action-item-note" rows="2" maxlength="2000"
            name="${escapeHtml(noteName)}"
            placeholder="Action item title/description"></textarea>
  <span class="field-action-item-hint">One per line &mdash; each line becomes its own action item.</span>
</div>`;
}

export function renderField(field: Field, ctx: RenderBodyArgs): string {
  const inner = renderFieldBody(field, ctx) + actionItemCheckbox(field);
  const vis = field.visible_if;
  if (!vis) return inner;
  // Starts HIDDEN and is revealed by forms-public.js once the controlling
  // value is known, rather than starting visible and blinking away on load.
  //
  // If scripting fails the field stays hidden, its inputs stay disabled and
  // therefore unsubmitted, and the server skips its `required` check -- so the
  // form still submits. The failure mode is a missing optional question, not a
  // form nobody can send. (Uploads, lookups and autosave already need JS.)
  //
  // The action-item checkbox is INSIDE the wrapper on purpose: a question that
  // does not apply must not offer to raise work about itself.
  return `
<div class="field-conditional" hidden
     data-visible-if-key="${escapeHtml(vis.field_key)}"
     data-visible-if-equals="${escapeHtml(JSON.stringify(vis.equals))}">${inner}</div>`;
}

function renderFieldBody(field: Field, ctx: RenderBodyArgs): string {
  switch (field.type) {
    case "heading":     return renderHeading(field, ctx);
    case "image":       return renderImage(field, ctx);
    case "name":        return renderName(field, ctx);
    case "email":       return renderEmail(field, ctx);
    case "phone":       return renderPhone(field, ctx);
    case "short_text":  return renderShortText(field, ctx);
    case "long_text":   return renderLongText(field, ctx);
    case "hidden":      return renderHidden(field, ctx);
    case "dropdown":    return renderDropdown(field, ctx);
    case "radio":       return renderRadio(field, ctx);
    case "multi":       return renderMulti(field, ctx);
    case "date":        return renderDate(field, ctx);
    case "time":        return renderTime(field, ctx);
    case "file":        return renderFile(field, ctx);
    case "signature":   return renderSignature(field, ctx);
    case "location":    return renderLocation(field, ctx);
    case "lookup":      return renderLookup(field, ctx);
  }
}
