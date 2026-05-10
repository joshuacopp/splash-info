// Per-field-type render dispatcher. The discriminated `Field` union in
// `@splash/forms-schema` makes this switch exhaustive at compile time —
// adding a 17th field type is a TypeScript error here until the new case
// lands.

import type { Field } from "@splash/forms-schema";
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
import { renderMulti } from "./multi.js";
import { renderDate } from "./date.js";
import { renderTime } from "./time.js";
import { renderFile } from "./file.js";
import { renderSignature } from "./signature.js";
import { renderLocation } from "./location.js";
import { renderLookup } from "./lookup.js";

export function renderField(field: Field, ctx: RenderBodyArgs): string {
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
    case "multi":       return renderMulti(field, ctx);
    case "date":        return renderDate(field, ctx);
    case "time":        return renderTime(field, ctx);
    case "file":        return renderFile(field, ctx);
    case "signature":   return renderSignature(field, ctx);
    case "location":    return renderLocation(field, ctx);
    case "lookup":      return renderLookup(field, ctx);
  }
}
