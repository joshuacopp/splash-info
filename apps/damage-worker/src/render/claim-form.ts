// HTML renderers for the public customer claim flow:
//   GET /claims/{slug}          → renderClaimForm
//   GET /claims/{slug}/thanks   → renderThanksPage
//   GET /claims/{unknown-slug}  → renderClaimNotFound
//
// Source: ported (simplified) from legacy/damagemanager.js renderDamageForm
// at line 567. The legacy form was a two-section progressive form with
// a staff-password gate, animated bubbles, and a JS-driven multi-step
// navigation. This port collapses to a single-page form to keep the
// surface tractable; the visual language (splash-blue gradient header,
// white card on light-blue background, splash-blue accents) is preserved.
//
// Field-name discipline: every <input name="..."> here MUST match what
// handleClaimSubmission reads in src/index.ts (around line 1032). The
// brief listed slightly different names (customerMailingAddress,
// damageDescription, preexistingDamage, submittedBy) but the worker
// reads the legacy names verbatim (mailingAddress, issueDescription,
// preExistingDamage, employeeName); worker is source of truth.

import { ASSETS } from "@splash/storage-r2";

const EQUIPMENT_CHOICES = [
  "Top Brush",
  "Side Wraps",
  "Conveyor",
  "Dryer",
  "Wheel Blaster",
  "Other",
  "N/A"
] as const;

const DETERMINATION_CHOICES = [
  {
    value: "no_responsibility",
    label: "No Responsibility",
    hint: "Damage is pre-existing or not caused by the wash"
  },
  {
    value: "requires_gm_review",
    label: "Requires GM Review",
    hint: "Needs General Manager evaluation"
  },
  {
    value: "customer_get_quotes",
    label: "Requested Customer Get Quote(s)",
    hint: "Customer will obtain repair estimates (managers only)"
  }
] as const;

function escHtml(s: string | null | undefined): string {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (m) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      })[m] ?? m
  );
}

const SHARED_STYLES = `
  *, *::before, *::after { box-sizing: border-box; }
  body {
    margin: 0; padding: 0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
    background: linear-gradient(to bottom, #e0f2fe 0%, #bae6fd 100%);
    min-height: 100vh; color: #0f172a;
  }
  .page { max-width: 720px; margin: 0 auto; padding: 24px 16px 48px; }
  .card {
    background: white; border-radius: 16px;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.12);
    overflow: hidden;
  }
  .header {
    background: linear-gradient(135deg, #1e3a8a 0%, #3b82f6 100%);
    color: white; padding: 28px 24px; text-align: center;
  }
  .header img { max-width: 220px; height: auto; display: block; margin: 0 auto 8px; }
  .header h1 { margin: 12px 0 4px; font-size: 22px; font-weight: 700; }
  .header p { margin: 0; font-size: 14px; opacity: 0.9; }
  .section { padding: 22px 22px; border-top: 1px solid #e2e8f0; }
  .section:first-of-type { border-top: none; }
  .section-title {
    font-size: 17px; font-weight: 700; color: #1e3a8a;
    margin: 0 0 4px;
  }
  .section-sub { font-size: 13px; color: #64748b; margin: 0 0 16px; }
  .form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  @media (max-width: 540px) { .form-row { grid-template-columns: 1fr; } }
  .form-group { margin-bottom: 14px; }
  label { display: block; font-weight: 600; color: #334155; margin-bottom: 6px; font-size: 14px; }
  .required { color: #dc2626; }
  .hint { font-weight: 400; color: #64748b; font-size: 12px; display: block; margin-top: 2px; }
  input[type="text"], input[type="tel"], input[type="email"], input[type="number"], select, textarea {
    width: 100%; padding: 12px 14px; font-size: 16px;
    border: 2px solid #e2e8f0; border-radius: 8px;
    transition: border-color 0.2s ease, box-shadow 0.2s ease;
    font-family: inherit; background: white; color: inherit;
  }
  input:focus, select:focus, textarea:focus {
    outline: none; border-color: #3b82f6;
    box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.15);
  }
  textarea { min-height: 100px; resize: vertical; }
  .file-input { display: block; width: 100%; font-size: 14px; }
  .radio-group { display: flex; flex-direction: column; gap: 10px; }
  .radio-option {
    display: flex; align-items: flex-start; gap: 10px;
    padding: 12px 14px; border: 2px solid #e2e8f0;
    border-radius: 10px; cursor: pointer;
  }
  .radio-option:hover { border-color: #3b82f6; }
  .radio-option input { margin-top: 2px; width: 18px; height: 18px; cursor: pointer; flex-shrink: 0; }
  .radio-option .radio-label { font-size: 15px; color: #334155; font-weight: 600; }
  .radio-option .radio-hint { font-size: 12px; color: #64748b; margin-top: 2px; }
  .toggle-row {
    display: flex; align-items: center; gap: 10px; padding: 10px 14px;
    background: #f8fafc; border: 2px solid #e2e8f0; border-radius: 8px;
  }
  .toggle-row input { width: 18px; height: 18px; cursor: pointer; }
  .toggle-row label { margin: 0; font-weight: 500; color: #334155; }
  .submit-row {
    padding: 22px; border-top: 1px solid #e2e8f0;
    background: #f8fafc;
  }
  .btn-submit {
    display: block; width: 100%;
    background: linear-gradient(135deg, #059669 0%, #10b981 100%);
    color: white; font-weight: 700; font-size: 17px;
    padding: 14px 18px; border: none; border-radius: 10px;
    cursor: pointer; text-transform: uppercase; letter-spacing: 0.4px;
  }
  .btn-submit:hover { filter: brightness(1.03); }
  .banner-error {
    margin: 0 0 18px; padding: 12px 14px;
    background: #fef2f2; border: 1px solid #fecaca;
    border-radius: 8px; color: #991b1b; font-size: 14px;
  }
  .staff-warning {
    margin: 0 0 14px; padding: 10px 14px;
    background: #fef3c7; border: 1px solid #fbbf24;
    border-radius: 8px; color: #78350f; font-size: 13px; font-weight: 600;
  }
  .footer-note {
    text-align: center; font-size: 12px; color: #475569;
    margin-top: 16px;
  }
`;

const PAGE_STYLES = `
  ${SHARED_STYLES}
`;

interface RenderClaimFormArgs {
  locationCode: string;
  locationPretty: string;
  errorMessage?: string | null;
}

export function renderClaimForm(args: RenderClaimFormArgs): string {
  const { locationCode, locationPretty, errorMessage } = args;
  const equipmentOpts = EQUIPMENT_CHOICES.map(
    (eq) => `<option value="${escHtml(eq)}">${escHtml(eq)}</option>`
  ).join("");
  const determinationOpts = DETERMINATION_CHOICES.map(
    (d, i) => `
      <label class="radio-option">
        <input type="radio" name="determination" value="${escHtml(d.value)}" required ${i === 0 ? "" : ""}>
        <div>
          <div class="radio-label">${escHtml(d.label)}</div>
          <div class="radio-hint">${escHtml(d.hint)}</div>
        </div>
      </label>`
  ).join("");

  const errorBanner = errorMessage
    ? `<div class="banner-error" role="alert">${escHtml(errorMessage)}</div>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="icon" type="image/png" href="${escHtml(ASSETS.favicon)}">
  <title>Vehicle Issue Report — ${escHtml(locationPretty)}</title>
  <style>${PAGE_STYLES}</style>
</head>
<body>
  <div class="page">
    <div class="card">
      <div class="header">
        <img src="${escHtml(ASSETS.logoWhite)}" alt="Splash Car Wash">
        <h1>${escHtml(locationPretty)}</h1>
        <p>Vehicle Issue Report</p>
      </div>

      <form action="/claims-api/submit-claim" method="POST" enctype="multipart/form-data">
        ${errorBanner}
        <input type="hidden" name="location" value="${escHtml(locationCode)}">
        <input type="hidden" name="locationPretty" value="${escHtml(locationPretty)}">
        <input type="hidden" name="equipmentMalfunction" id="equipmentMalfunctionHidden" value="false">

        <div class="section">
          <h2 class="section-title">1. Customer Information</h2>
          <p class="section-sub">Please provide your contact and vehicle details.</p>

          <div class="form-row">
            <div class="form-group">
              <label for="customerName">Your Name <span class="required">*</span></label>
              <input type="text" id="customerName" name="customerName" required autocomplete="name">
            </div>
            <div class="form-group">
              <label for="customerPhone">Phone Number <span class="required">*</span></label>
              <input type="tel" id="customerPhone" name="customerPhone" required autocomplete="tel" placeholder="(555) 555-5555">
            </div>
          </div>

          <div class="form-row">
            <div class="form-group">
              <label for="customerEmail">Email Address</label>
              <input type="email" id="customerEmail" name="customerEmail" autocomplete="email">
            </div>
            <div class="form-group">
              <label for="mailingAddress">Mailing Address
                <span class="hint">Required for payment if claim is approved</span>
              </label>
              <input type="text" id="mailingAddress" name="mailingAddress" autocomplete="street-address">
            </div>
          </div>

          <div class="form-row">
            <div class="form-group">
              <label for="licensePlate">License Plate</label>
              <input type="text" id="licensePlate" name="licensePlate" style="text-transform: uppercase;">
            </div>
            <div class="form-group">
              <label for="vehicleYear">Vehicle Year</label>
              <input type="number" id="vehicleYear" name="vehicleYear" min="1900" max="2030">
            </div>
          </div>

          <div class="form-row">
            <div class="form-group">
              <label for="vehicleMake">Vehicle Make <span class="required">*</span></label>
              <input type="text" id="vehicleMake" name="vehicleMake" required placeholder="e.g., Toyota">
            </div>
            <div class="form-group">
              <label for="vehicleModel">Vehicle Model <span class="required">*</span></label>
              <input type="text" id="vehicleModel" name="vehicleModel" required placeholder="e.g., Camry">
            </div>
          </div>

          <div class="form-group">
            <label for="vehicleColor">Vehicle Color</label>
            <input type="text" id="vehicleColor" name="vehicleColor">
          </div>

          <div class="form-group">
            <label for="issueDescription">Description of Issue <span class="required">*</span>
              <span class="hint">Please describe what happened in your own words</span>
            </label>
            <textarea id="issueDescription" name="issueDescription" required placeholder="Please describe the issue you experienced..."></textarea>
          </div>
        </div>

        <div class="section">
          <h2 class="section-title">2. Staff Assessment</h2>
          <p class="section-sub">For Splash employees only.</p>
          <div class="staff-warning">⚠️ This section must be completed by a Splash employee.</div>

          <div class="form-row">
            <div class="form-group">
              <label for="employeeName">Employee Name <span class="required">*</span></label>
              <input type="text" id="employeeName" name="employeeName" required>
            </div>
            <div class="form-group">
              <label for="membershipNumber">Membership / Barcode
                <span class="hint">If customer is a member</span>
              </label>
              <input type="text" id="membershipNumber" name="membershipNumber">
            </div>
          </div>

          <div class="form-group">
            <label for="fourCornersPhotos">Four-Corner / Full-Vehicle Photos <span class="required">*</span>
              <span class="hint">Photos of all four corners showing overall vehicle condition</span>
            </label>
            <input class="file-input" type="file" id="fourCornersPhotos" name="fourCornersPhotos"
              accept="image/*,image/heic,image/heif" multiple capture="environment" required>
          </div>

          <div class="form-group">
            <label for="vinPhoto">VIN Photo <span class="required">*</span>
              <span class="hint">Usually on driver's side dashboard or door jamb</span>
            </label>
            <input class="file-input" type="file" id="vinPhoto" name="vinPhoto"
              accept="image/*,image/heic,image/heif" capture="environment" required>
          </div>

          <div class="form-group">
            <label for="damagePhotos">Damage Photos <span class="required">*</span>
              <span class="hint">Close-up photos of all damage areas (one or more)</span>
            </label>
            <input class="file-input" type="file" id="damagePhotos" name="damagePhotos"
              accept="image/*,image/heic,image/heif" multiple capture="environment" required>
          </div>

          <div class="form-group">
            <label for="platePhoto">License Plate Photo <span class="required">*</span></label>
            <input class="file-input" type="file" id="platePhoto" name="platePhoto"
              accept="image/*,image/heic,image/heif" capture="environment" required>
          </div>

          <div class="form-group">
            <label for="preExistingDamage">Pre-Existing Damage Noted
              <span class="hint">Describe any damage visible before the wash</span>
            </label>
            <textarea id="preExistingDamage" name="preExistingDamage" placeholder="e.g., Scratch on rear bumper, dent on driver door..."></textarea>
          </div>

          <div class="form-group">
            <label for="equipmentInvolved">Equipment Involved <span class="required">*</span></label>
            <select id="equipmentInvolved" name="equipmentInvolved" required>
              <option value="">Select equipment...</option>
              ${equipmentOpts}
            </select>
          </div>

          <div class="form-group">
            <div class="toggle-row">
              <input type="checkbox" id="equipmentMalfunctionToggle">
              <label for="equipmentMalfunctionToggle">Was there an equipment malfunction?</label>
            </div>
          </div>

          <div class="form-group">
            <label>Determination <span class="required">*</span></label>
            <div class="radio-group">
              ${determinationOpts}
            </div>
          </div>

          <div class="form-group">
            <label for="customerTold">What Was the Customer Told?
              <span class="hint">Document exactly what you communicated to the customer</span>
            </label>
            <textarea id="customerTold" name="customerTold" placeholder="e.g., Explained that a manager will review and contact them within 48 hours..."></textarea>
          </div>

          <div class="form-group">
            <label for="customerDemeanor">Customer Interaction & Demeanor
              <span class="hint">Optional but helpful for claim review</span>
            </label>
            <textarea id="customerDemeanor" name="customerDemeanor" placeholder="e.g., Customer was calm and understanding..."></textarea>
          </div>
        </div>

        <div class="submit-row">
          <button type="submit" class="btn-submit">Submit claim</button>
        </div>
      </form>
    </div>
    <p class="footer-note">© Splash Car Wash</p>
  </div>

  <script>
    // Mirror the equipmentMalfunction checkbox state into the hidden input
    // that the worker reads ("true"/"false" strings — see
    // handleClaimSubmission's claimData.equipmentMalfunction parse).
    (function () {
      var box = document.getElementById('equipmentMalfunctionToggle');
      var hid = document.getElementById('equipmentMalfunctionHidden');
      if (!box || !hid) return;
      box.addEventListener('change', function () {
        hid.value = box.checked ? 'true' : 'false';
      });
    })();
  </script>
</body>
</html>`;
}

interface RenderThanksArgs {
  locationPretty: string;
  claimId: string | null;
}

export function renderThanksPage(args: RenderThanksArgs): string {
  const { locationPretty, claimId } = args;
  const claimRow = claimId
    ? `<p class="claim-id">Claim ID: <strong>${escHtml(claimId)}</strong></p>`
    : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="icon" type="image/png" href="${escHtml(ASSETS.favicon)}">
  <title>Claim Submitted — ${escHtml(locationPretty)}</title>
  <style>
    ${SHARED_STYLES}
    .thanks-card { padding: 36px 28px; text-align: center; }
    .check-mark { font-size: 64px; color: #059669; line-height: 1; margin-bottom: 12px; }
    .thanks-card h1 { margin: 0 0 6px; color: #059669; font-size: 26px; font-weight: 700; }
    .thanks-card p { margin: 0 0 8px; color: #475569; font-size: 15px; }
    .thanks-card .claim-id { color: #1e3a8a; font-size: 16px; }
    .thanks-card a {
      display: inline-block; margin-top: 18px;
      background: linear-gradient(135deg, #1e3a8a 0%, #3b82f6 100%);
      color: white; text-decoration: none; font-weight: 700;
      padding: 12px 22px; border-radius: 10px;
      text-transform: uppercase; letter-spacing: 0.4px; font-size: 14px;
    }
  </style>
</head>
<body>
  <div class="page">
    <div class="card thanks-card">
      <div class="check-mark">✓</div>
      <h1>Claim Submitted</h1>
      <p>Your claim for <strong>${escHtml(locationPretty)}</strong> has been recorded.</p>
      ${claimRow}
      <p>A manager will review and may follow up. You can close this page.</p>
    </div>
  </div>
</body>
</html>`;
}

export function renderClaimNotFound(slug: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="icon" type="image/png" href="${escHtml(ASSETS.favicon)}">
  <title>Location Not Found</title>
  <style>
    ${SHARED_STYLES}
    .nf-card { padding: 36px 28px; text-align: center; }
    .nf-card h1 { margin: 0 0 12px; color: #1e3a8a; font-size: 24px; }
    .nf-card p { margin: 0 0 8px; color: #475569; font-size: 15px; }
    .nf-card code { background: #e2e8f0; padding: 2px 8px; border-radius: 4px; }
  </style>
</head>
<body>
  <div class="page">
    <div class="card nf-card">
      <h1>Location not found</h1>
      <p>We couldn't find a Splash Car Wash location for <code>${escHtml(slug)}</code>.</p>
      <p>Please double-check the URL on your tablet bookmark, or contact a manager for help.</p>
    </div>
  </div>
</body>
</html>`;
}

export function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" }
  });
}
