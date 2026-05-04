// Package-picker page renderer.
//
// GET /signup/{location}  →  renderPicker(location, rows, prefix)
//
// Source: legacy/signupworker.js:1864 renderPicker (simplified-picker branch).
// Cards are tap-to-navigate to /signup/{location}/{pkg}; the worker
// dispatches that route to inline form render or JotForm redirect based on
// SIGNATURE_MODE.

import { ASSETS } from "@splash/storage-r2/assets";
import type { PricingSimpleResolvedRow } from "@splash/types/pricing";
import { BUBBLE_BACKGROUND_CSS, BUBBLES_HTML, PICKER_CSS } from "./css.js";
import { cap, escHtml } from "./escape.js";

export interface PickerRenderArgs {
  /** URL-form location code, e.g. "binghamton". */
  locationCode: string;
  /** Resolved pricing rows for the location, sorted by `sort`. */
  rows: PricingSimpleResolvedRow[];
  /** Route prefix used to build links. Matches the URL the user came in on:
   *  "/signup", "/q", or "/join". */
  prefix: string;
}

export function renderPicker({ locationCode, rows, prefix }: PickerRenderArgs): string {
  const cards = rows
    .map((r) => {
      const today = Number(r.today ?? 0).toFixed(2);
      const monthly = Number(r.ongoing ?? 0).toFixed(2);
      return `
      <div class="card" data-pkg="${escHtml(r.pkg)}" role="button" tabindex="0">
        <div class="title">${escHtml(r.pretty_pkg)}</div>
        <div class="price">First month: <span class="price-amount">$${escHtml(today)}</span></div>
        <div class="ongoing">Then $${escHtml(monthly)}/month</div>
      </div>`;
    })
    .join("");

  const fallbackHtml = `<div style="grid-column: 1 / -1; text-align: center; color: #64748b;">No packages configured for ${escHtml(locationCode)}.</div>`;

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<link rel="icon" type="image/png" href="${ASSETS.favicon}"/>
<title>${escHtml(cap(locationCode))} – Choose Package</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Asap:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
${BUBBLE_BACKGROUND_CSS}
${PICKER_CSS}
</style>
</head>
<body>
  ${BUBBLES_HTML}

  <div class="scroll-wrapper">
    <div class="container">
      <div class="header">
        <img class="logo" src="${ASSETS.logoBlue}" alt="Splash Car Wash"/>
        <div class="location-title">${escHtml(cap(locationCode))}</div>
      </div>
      <div class="content">
        <div class="subtitle">Select your MaxPass package</div>
        <div class="grid">
          ${cards.length > 0 ? cards : fallbackHtml}
        </div>
        <div class="hint">💧 Tap a package to continue with your signup</div>
      </div>
    </div>
  </div>

  <script>
    (function(){
      var loc = ${JSON.stringify(locationCode)};
      var prefix = ${JSON.stringify(prefix)};
      function go(card) {
        var pkg = card.getAttribute('data-pkg') || '';
        if (!pkg) return;
        window.location.href = prefix + '/' + encodeURIComponent(loc) + '/' + encodeURIComponent(pkg);
      }
      document.querySelectorAll('.card').forEach(function(card){
        card.addEventListener('click', function(){ go(card); });
        card.addEventListener('keydown', function(e){
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(card); }
        });
      });
    })();
  </script>
</body>
</html>`;
}
