import type { PackagePriceGridField } from "@splash/forms-schema";
import type { RenderBodyArgs } from "../index.js";
import { fieldHelp, escapeHtml } from "../util.js";

/**
 * Package price grid. The rows cannot be rendered here: which packages exist
 * depends on the site the submitter has not picked yet. forms-public.js
 * (wirePriceGrids) fetches them from /forms/api/packages/{slug} when the site
 * field changes and draws one row per package.
 *
 * THE SUBMITTED VALUE IS ONE HIDDEN INPUT holding JSON, maintained by the
 * script; the visible price boxes carry no `name`. Two reasons:
 *   - Draft resume (Brief 122) restores named inputs at page load, before the
 *     rows exist. A single hidden value survives that, and the script
 *     re-applies it once the rows arrive.
 *   - Package names are free text from pricing_simple, and none of them has to
 *     be turned into a form-field name.
 *
 * The visible boxes still carry `required` while their row is ticked, so the
 * browser blocks a submit with a missing current price -- constraint
 * validation does not care whether an input is named.
 */
export function renderPackagePriceGrid(
  field: PackagePriceGridField,
  _ctx: RenderBodyArgs
): string {
  return `
<fieldset class="field field-price-grid" data-field-key="${escapeHtml(field.key)}" data-field-type="package_price_grid"
          data-grid-key-field="${escapeHtml(field.keyFieldKey)}">
  <legend class="field-label">${escapeHtml(field.label)}${field.required ? '<span class="field-required" aria-label="required">*</span>' : ""}</legend>
  ${fieldHelp(field)}
  <input type="hidden" name="${escapeHtml(field.key)}" value="" data-grid-value="1" />
  <div class="price-grid-rows" data-grid-rows="1">
    <p class="price-grid-empty">Choose a site above to list its packages.</p>
  </div>
  <p class="price-grid-hint">Tick each package that is changing. Leave a new price blank to keep it at the current price.</p>
</fieldset>`;
}
