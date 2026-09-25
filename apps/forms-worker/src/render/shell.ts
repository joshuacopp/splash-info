// Outer HTML shell — DOCTYPE / head / inline <style> / Splash navy header
// bar with white-script logo. Body content (the rendered form HTML) is
// passed in by the caller.

import { ASSETS } from "@splash/storage-r2";
import {
  SIGNATURE_PAD_JS_VERSION,
  FORMS_PUBLIC_JS_VERSION
} from "../uploads/static.js";
import type { FormMeta } from "@splash/forms-schema";
import { escapeHtml } from "./util.js";

interface ShellArgs {
  form: FormMeta;
  bodyHtml: string;
  /** When set, the Turnstile <script> tag is included in <head>. */
  turnstileSiteKey?: string;
}

export function renderShell({ form, bodyHtml, turnstileSiteKey }: ShellArgs): string {
  const turnstileScript = turnstileSiteKey
    ? `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>`
    : "";
  // Brief 92 — vendored signature_pad + the public-form wiring that
  // drives signature canvases and file inputs. Both are served by the
  // worker itself (`/forms/api/static/*`), bundled into the worker via
  // wrangler's `[[rules]] type = "Text"` block. `defer` so they run
  // after DOMContentLoaded; signature-pad must load before forms-public
  // (script tag order = execution order under defer).
  // ?v=<content hash> so a deploy invalidates the 24h cache immediately. The
  // serve handler matches on pathname, so the query is inert server-side and
  // purely a cache key. See uploads/static.ts for what went wrong without it.
  const formsClientScripts = `
  <script src="/forms/api/static/signature-pad.min.js?v=${SIGNATURE_PAD_JS_VERSION}" defer></script>
  <script src="/forms/api/static/forms-public.js?v=${FORMS_PUBLIC_JS_VERSION}" defer></script>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(form.title)} — Splash</title>
  ${turnstileScript}${formsClientScripts}
  <style>${SHELL_CSS}</style>
</head>
<body>
  <header class="splash-header">
    <img src="${ASSETS.logoWhite}" alt="Splash Car Wash" class="splash-logo" />
  </header>
  <main class="forms-main">
    <article class="forms-form-wrap">
      <h1 class="forms-title">${escapeHtml(form.title)}</h1>
      ${form.description ? `<p class="forms-description">${escapeHtml(form.description)}</p>` : ""}
      ${bodyHtml}
    </article>
  </main>
</body>
</html>`;
}

const SHELL_CSS = `
  /* Splash brand tokens */
  :root {
    --splash-navy: #0a2240;
    --splash-blue: #1e5fa8;
    --splash-cyan: #4cc4ec;
    --splash-gray-light: #f4f6f9;
    --splash-text: #1a1a1a;
    --splash-error: #c0392b;
  }
  /* Reset + base */
  * { box-sizing: border-box; }
  body {
    margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: var(--splash-gray-light); color: var(--splash-text); line-height: 1.5;
  }
  /* Header */
  .splash-header { background: var(--splash-navy); padding: 16px 24px; }
  .splash-logo { height: 36px; display: block; }
  /* Form layout */
  .forms-main { max-width: 720px; margin: 0 auto; padding: 32px 16px 64px; }
  .forms-form-wrap { background: white; border-radius: 8px; padding: 32px 28px; box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
  .forms-title { margin: 0 0 8px; font-size: 28px; color: var(--splash-navy); }
  .forms-description { margin: 0 0 24px; color: #555; }
  /* Field wrapper. scroll-margin-top keeps a field clear of the pinned
     headings when something scrolls it into view -- browser validation on
     submit, or the error summary's jump-to-field. Without it the field you are
     being sent to lands underneath the heading bar. */
  .field { margin-bottom: 20px; scroll-margin-top: 104px; }
  .field-label { display: block; font-weight: 600; margin-bottom: 6px; color: var(--splash-navy); }
  .field-required { color: var(--splash-error); margin-left: 2px; }
  .field-help { font-size: 13px; color: #666; margin-top: 4px; }
  .field-input, .field-select, .field-textarea {
    width: 100%; padding: 10px 12px; border: 1px solid #ccc; border-radius: 4px;
    font-size: 16px; font-family: inherit;
  }
  .field-input:focus, .field-select:focus, .field-textarea:focus {
    outline: 2px solid var(--splash-cyan); border-color: var(--splash-cyan);
  }
  .field-textarea { resize: vertical; min-height: 80px; }
  /* Headings */
  .field-heading-h1 { font-size: 28px; margin: 24px 0 8px; color: var(--splash-navy); }
  .field-heading-h2 { font-size: 22px; margin: 20px 0 8px; color: var(--splash-navy); }
  .field-heading-h3 { font-size: 18px; margin: 16px 0 8px; color: var(--splash-navy); }
  .field-heading-h4 { font-size: 16px; margin: 12px 0 6px; color: var(--splash-navy); }
  /* Pinned section headings.
     On a 90-question inspection the heading that says WHICH part of the site you
     are assessing scrolls off after the first few rows, and every answer after
     that is given without its reference. These pin it to the top of the
     viewport instead, section heading and sub-heading stacked, so "Marketing /
     Visibility" is on screen for every row it governs.
     Selected by POSITION, not by level: renderFieldsGrouped opens a section AT
     its heading, so a section's first child is always its heading whatever
     level the form happens to use, and any other heading inside is a
     sub-heading. That keeps the CSS working for a form built on h2/h3 as well
     as one built on h3/h4.
     The heights are load-bearing -- the sub-heading's "top" must equal the
     section heading's rendered height, or the two overlap. nowrap + ellipsis is
     what makes that height knowable: a section title that wrapped to two lines
     on a phone would push itself over the sub-heading below. Section titles are
     short by nature, so the ellipsis should be a theoretical case.
     Negative side margins bleed the background across the card's 28px padding;
     without them answers scroll visibly through the gutters beside the
     heading. */
  .forms-section { margin-bottom: 8px; }
  .forms-section > :first-child {
    position: sticky; top: 0; z-index: 3;
    background: #fff;
    margin: 0 -28px 12px; padding: 12px 28px 8px;
    border-bottom: 2px solid var(--splash-cyan);
    line-height: 24px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  /* A section heading carrying visible_if is wrapped in .field-conditional, so
     the WRAPPER is the first child and takes the pinned styling above. Zeroing
     the inner heading's own margin keeps the bar the same 46px tall either way
     -- the sub-heading's "top" below depends on it. (While the condition is
     unmet the wrapper is "hidden", so that section simply has no pinned
     heading, which is the right answer for a section that does not apply.) */
  .forms-section > :first-child > .field-heading-h1,
  .forms-section > :first-child > .field-heading-h2,
  .forms-section > :first-child > .field-heading-h3,
  .forms-section > :first-child > .field-heading-h4 { margin: 0; }
  .forms-section > .field-heading-h2:not(:first-child),
  .forms-section > .field-heading-h3:not(:first-child),
  .forms-section > .field-heading-h4:not(:first-child) {
    position: sticky; top: 46px; z-index: 2;
    background: #fff;
    margin: 18px -28px 10px; padding: 8px 28px 6px;
    border-bottom: 1px solid #dfe5ee;
    line-height: 22px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  /* Image (in-form display) */
  .field-image-wrap { margin: 16px 0; }
  .field-image { display: block; height: auto; }
  .field-image-small { max-width: 25%; }
  .field-image-medium { max-width: 50%; }
  .field-image-full { max-width: 100%; }
  .field-image-caption { font-size: 13px; color: #666; margin-top: 6px; font-style: italic; }
  /* Multi-checkbox group */
  .field-multi-option { display: flex; align-items: center; margin-bottom: 6px; }
  .field-multi-option input { margin-right: 8px; }
  /* Radio groups. Vertical stacks like multi; inline lays the options out in a
     row and lets them wrap, which is what makes a long Pass/Fail/NA inspection
     list scannable instead of forty screens of stacked blocks. Touch targets
     stay at 44px min-height per option -- these are answered on tablets. */
  .field-radio-option { display: flex; align-items: center; margin-bottom: 6px; min-height: 44px; }
  .field-radio-option input { margin-right: 8px; }
  .field-radio-inline .field-radio-options { display: flex; flex-wrap: wrap; gap: 4px 20px; }
  .field-radio-inline .field-radio-option { margin-bottom: 0; }
  /* Action item tick. Deliberately set apart from the answer above it -- it is
     a different question ("does this need follow-up?") from the one the field
     asks, and reading as part of the answer would get it ticked by accident. */
  .field-action-item { display: flex; align-items: center; flex-wrap: wrap; gap: 8px;
                       margin: -4px 0 14px; padding: 6px 10px; min-height: 44px;
                       border-left: 3px solid #d98324; background: #fdf6ec;
                       font-size: 14px; color: #6b4a16; }
  .field-action-item label { cursor: pointer; }
  /* Revealed by the tick with a sibling selector, deliberately WITHOUT
     JavaScript: this note is the whole informational value of an action item,
     and a stale cached script has already broken this form once. */
  .field-action-item-note, .field-action-item-hint { display: none; }
  .field-action-item input[type="checkbox"]:checked ~ .field-action-item-note {
    display: block; flex: 1 1 100%; margin-top: 4px; padding: 8px 10px;
    border: 1px solid #d98324; border-radius: 4px; font-size: 14px;
    font-family: inherit; color: var(--splash-navy); background: #fff;
    resize: vertical; min-height: 44px; }
  .field-action-item input[type="checkbox"]:checked ~ .field-action-item-hint {
    display: block; flex: 1 1 100%; font-size: 12px; color: #8a6a2f; }
  /* Disabled lookup placeholder */
  .field-lookup-disabled { background: #f0f0f0; color: #888; font-style: italic; }
  /* Display-only lookup callout (Brief 93) */
  .field-display-only .field-display-value {
    background: var(--splash-gray-light);
    border-left: 3px solid var(--splash-cyan);
    padding: 10px 14px;
    border-radius: 4px;
    color: #555;
    min-height: 44px;
    display: flex;
    align-items: center;
  }
  /* File / signature placeholders */
  .field-file-input { padding: 8px; }
  .field-signature-canvas { border: 1px solid #ccc; border-radius: 4px; background: white; display: block; width: 100%; height: 180px; cursor: crosshair; }
  .field-signature-clear { margin-top: 8px; font-size: 13px; }
  /* Submit button */
  .submit-btn {
    background: var(--splash-blue); color: white; border: none; padding: 14px 28px;
    font-size: 16px; font-weight: 600; border-radius: 4px; cursor: pointer;
    margin-top: 16px;
  }
  .submit-btn:hover { background: var(--splash-navy); }
  .submit-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  /* Turnstile */
  .turnstile-wrap { margin: 16px 0; }
  /* Footer */
  .forms-footer { text-align: center; margin-top: 24px; font-size: 13px; color: #888; }
`;
