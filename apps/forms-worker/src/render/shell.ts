// Outer HTML shell — DOCTYPE / head / inline <style> / Splash navy header
// bar with white-script logo. Body content (the rendered form HTML) is
// passed in by the caller.

import { ASSETS } from "@splash/storage-r2";
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
  const formsClientScripts = `
  <script src="/forms/api/static/signature-pad.min.js" defer></script>
  <script src="/forms/api/static/forms-public.js" defer></script>`;
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
  /* Field wrapper */
  .field { margin-bottom: 20px; }
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
