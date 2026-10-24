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
  if (field.multiSite) {
    // Sites are added by number inside the grid; forms-public.js draws one
    // section per site. The add box is a plain text input WITHOUT a name, so
    // a half-typed site number is never submitted as an answer.
    return `
<fieldset class="field field-price-grid" data-field-key="${escapeHtml(field.key)}" data-field-type="package_price_grid"
          data-grid-multi="1">
  <legend class="field-label">${escapeHtml(field.label)}${field.required ? '<span class="field-required" aria-label="required">*</span>' : ""}</legend>
  ${fieldHelp(field)}
  <input type="hidden" name="${escapeHtml(field.key)}" value="" data-grid-value="1" />
  <div class="price-grid-sites" data-grid-sites="1">
    <p class="price-grid-empty">No sites added yet.</p>
  </div>
  <div class="price-grid-add">
    <input type="text" inputmode="numeric" maxlength="3" autocomplete="off"
           class="field-input" placeholder="Site # (e.g. 019)" aria-label="Site number to add"
           data-grid-add-input="1" />
    <button type="button" class="price-grid-add-btn" data-grid-add-btn="1">+ Add site</button>
  </div>
  <p class="price-grid-add-msg" data-grid-add-msg="1" hidden></p>
  <p class="price-grid-hint">Add each site that is changing, then tick its packages. Leave a new price blank to keep it at the current price. "Copy from" fills a site from the first one; check its current prices afterwards.</p>
</fieldset>`;
  }
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
