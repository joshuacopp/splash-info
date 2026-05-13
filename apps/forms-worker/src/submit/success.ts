// Server-rendered thank-you page returned by `handleSubmit` on a successful
// (or idempotent re-submit) insert. Per planning Decision 8 + Brief 85's
// relative-URL convention.
//
// Visual style mirrors Brief 90's `render/shell.ts` — same Splash navy
// header bar, same brand tokens — so the success transition feels like the
// same surface, not a different page. We don't reuse the shell helper
// because the body shape is materially different (no <form>, just a
// confirmation block + nav CTAs).
//
// Brief 118 — post-submit nav added.
//   - `audience === "internal"` (operators logged into apps/web): three
//     CTAs — "Back to Forms" (→ /forms), "Dashboard" (→ /admin/dashboard),
//     and "Fill Out Another" (→ /forms/{slug}).
//   - `audience === "public" | "link-only"` (no apps/web session): two
//     CTAs — "Fill Out Another" + "Back to Forms" (the index just lists
//     internal forms for credentialed users, but the link is harmless
//     for non-authed visitors — it bounces them to /login by middleware).
//     The Dashboard link is suppressed since these visitors aren't
//     authenticated and the link would just bounce to /login.

import { ASSETS } from "@splash/storage-r2";
import type { FormMeta } from "@splash/forms-schema";
import { escapeHtml } from "../render/util.js";

export function renderSuccessPage(form: FormMeta): Response {
  const successMessage =
    form.successMessage ?? "Thank you for your submission.";
  const slug = form.slug;
  const isInternal = form.audience === "internal";

  const dashboardBtn = isInternal
    ? `<a href="/admin/dashboard" class="nav-btn nav-btn-secondary">Dashboard</a>`
    : "";

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(form.title)} — Submitted</title>
  <style>${SUCCESS_CSS}</style>
</head>
<body>
  <header class="splash-header">
    <img src="${ASSETS.logoWhite}" alt="Splash Car Wash" class="splash-logo" />
  </header>
  <main class="success-main">
    <article class="success-card">
      <div class="success-icon" aria-hidden="true">&#x2713;</div>
      <h1 class="success-title">${escapeHtml(form.title)}</h1>
      <p class="success-msg">${escapeHtml(successMessage)}</p>
      <div class="nav-actions">
        <a href="/forms" class="nav-btn nav-btn-primary">Back to Forms</a>
        ${dashboardBtn}
        <a href="/forms/${escapeHtml(slug)}" class="nav-btn nav-btn-tertiary">Fill Out Another</a>
      </div>
    </article>
  </main>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

// Inline so the success page doesn't need a second round trip.
const SUCCESS_CSS = `
  :root {
    --splash-navy: #0a2240;
    --splash-blue: #1e5fa8;
    --splash-cyan: #4cc4ec;
    --splash-gray-light: #f4f6f9;
    --splash-text: #1a1a1a;
    --splash-success: #2ecc71;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: var(--splash-gray-light);
    color: var(--splash-text);
    line-height: 1.5;
  }
  .splash-header { background: var(--splash-navy); padding: 16px 24px; }
  .splash-logo { height: 36px; display: block; }
  .success-main { max-width: 560px; margin: 0 auto; padding: 64px 16px; }
  .success-card {
    background: white; border-radius: 8px; padding: 40px 28px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06); text-align: center;
  }
  .success-icon { font-size: 64px; color: var(--splash-success); margin-bottom: 12px; line-height: 1; }
  .success-title { color: var(--splash-navy); margin: 0 0 12px; font-size: 24px; }
  .success-msg { color: #555; margin: 0 0 32px; }
  .nav-actions {
    display: flex; flex-wrap: wrap; justify-content: center; gap: 10px;
  }
  .nav-btn {
    text-decoration: none; padding: 11px 22px; border-radius: 4px;
    font-weight: 600; display: inline-block; font-size: 15px;
    border: 1px solid transparent; line-height: 1.2;
  }
  .nav-btn-primary { background: var(--splash-blue); color: white; }
  .nav-btn-primary:hover { background: var(--splash-navy); }
  .nav-btn-secondary {
    background: white; color: var(--splash-blue);
    border-color: var(--splash-blue);
  }
  .nav-btn-secondary:hover { background: var(--splash-gray-light); }
  .nav-btn-tertiary { background: transparent; color: var(--splash-navy); }
  .nav-btn-tertiary:hover { background: var(--splash-gray-light); }
`;
