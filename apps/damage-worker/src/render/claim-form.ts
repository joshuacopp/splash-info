// HTML renderers for the public customer claim flow:
//   GET /claims/{slug}          → renderClaimForm
//   GET /claims/{slug}/thanks   → renderThanksPage
//   GET /claims/{unknown-slug}  → renderClaimNotFound
//
// Source: ported (simplified) from legacy/damagemanager.js renderDamageForm
// at line 567. Brief 23 collapsed the legacy two-section form into a single
// page; Brief 25 restores the two-step PIN-gated reveal, the multi-photo
// "add another?" widget, and the JS-driven submit + outcome card.
//
// Field-name discipline: every `<input name="..."/>` here MUST match what
// handleClaimSubmission reads in src/index.ts. The worker reads the legacy
// names verbatim (mailingAddress, issueDescription, preExistingDamage,
// employeeName); worker is source of truth.

import { ASSETS } from "@splash/storage-r2";

const EQUIPMENT_CHOICES = [
  "Top Brush",
  "Side Wraps",
  "Conveyor",
  "Dryer",
  "Wheel Blaster",
  "Other"
] as const;

interface DeterminationChoice {
  value: string;
  label: string;
  hint: string;
  managersOnly: boolean;
}

const DETERMINATION_CHOICES: readonly DeterminationChoice[] = [
  {
    value: "no_responsibility",
    label: "No Responsibility",
    hint: "Damage is pre-existing or not caused by the wash",
    managersOnly: false
  },
  {
    value: "requires_gm_review",
    label: "Requires GM Review",
    hint: "Needs General Manager evaluation",
    managersOnly: false
  },
  {
    value: "customer_get_quotes",
    label: "Requested Customer Get Quote(s)",
    hint: "Customer will obtain repair estimates",
    managersOnly: true
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
  .section[hidden] { display: none; }
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
  input[type="text"], input[type="tel"], input[type="email"], input[type="number"], input[type="password"], select, textarea {
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
  .pill {
    display: inline-block; border-radius: 9999px;
    padding: 2px 10px; font-size: 0.7rem; font-weight: 700;
    text-transform: uppercase; letter-spacing: 0.05em;
    margin-left: 8px; vertical-align: middle;
  }
  .pill-warn { background: #f59e0b; color: white; }

  /* Equipment yes/no segmented toggle */
  .seg-toggle { display: inline-flex; border: 2px solid #e2e8f0; border-radius: 999px; overflow: hidden; }
  .seg-toggle label {
    margin: 0; padding: 8px 18px; font-size: 14px; font-weight: 600;
    color: #475569; cursor: pointer; background: white;
  }
  .seg-toggle input { display: none; }
  .seg-toggle input:checked + label { background: #1e3a8a; color: white; }

  /* Continue / submit / secondary buttons */
  .submit-row {
    padding: 22px; border-top: 1px solid #e2e8f0;
    background: #f8fafc;
  }
  .btn-primary {
    display: inline-block; background: linear-gradient(135deg, #1e3a8a 0%, #3b82f6 100%);
    color: white; font-weight: 700; font-size: 15px;
    padding: 12px 18px; border: none; border-radius: 10px;
    cursor: pointer; text-transform: uppercase; letter-spacing: 0.4px;
  }
  .btn-primary:hover { filter: brightness(1.05); }
  .btn-primary:disabled { opacity: 0.55; cursor: not-allowed; }
  .btn-submit {
    display: block; width: 100%;
    background: linear-gradient(135deg, #059669 0%, #10b981 100%);
    color: white; font-weight: 700; font-size: 17px;
    padding: 14px 18px; border: none; border-radius: 10px;
    cursor: pointer; text-transform: uppercase; letter-spacing: 0.4px;
  }
  .btn-submit:hover { filter: brightness(1.03); }
  .btn-submit:disabled { opacity: 0.55; cursor: not-allowed; }
  .btn-secondary {
    display: inline-block; background: white;
    color: #1e3a8a; font-weight: 700; font-size: 14px;
    padding: 10px 16px; border: 2px solid #1e3a8a; border-radius: 10px;
    cursor: pointer;
  }
  .continue-row {
    margin-top: 18px; padding-top: 16px; border-top: 1px dashed #e2e8f0;
    text-align: right;
  }
  .banner-error {
    margin: 0 18px 18px; padding: 12px 14px;
    background: #fef2f2; border: 1px solid #fecaca;
    border-radius: 8px; color: #991b1b; font-size: 14px;
  }
  .banner-error[hidden] { display: none; }
  .staff-warning {
    margin: 0 0 14px; padding: 10px 14px;
    background: #fef3c7; border: 1px solid #fbbf24;
    border-radius: 8px; color: #78350f; font-size: 13px; font-weight: 600;
  }
  .footer-note {
    text-align: center; font-size: 12px; color: #475569;
    margin-top: 16px;
  }

  /* Photo widget */
  .photo-section { margin-bottom: 18px; }
  .photo-thumbs {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
    gap: 10px; margin: 8px 0;
  }
  .photo-thumb {
    position: relative; border: 2px solid #e2e8f0; border-radius: 8px;
    overflow: hidden; background: #f8fafc;
  }
  .photo-thumb img {
    display: block; width: 100%; height: 110px; object-fit: cover;
  }
  .photo-thumb .photo-remove {
    display: block; text-align: center; padding: 6px 4px;
    font-size: 12px; font-weight: 600; color: #991b1b;
    background: #fef2f2; text-decoration: none; cursor: pointer;
  }
  .photo-thumb .photo-remove:hover { background: #fecaca; }
  .btn-add-photo {
    display: inline-block; background: white; color: #1e3a8a;
    font-weight: 700; font-size: 14px; padding: 10px 16px;
    border: 2px dashed #1e3a8a; border-radius: 8px; cursor: pointer;
  }
  .btn-add-photo:hover { background: #eff6ff; }

  /* PIN modal */
  .pin-overlay {
    position: fixed; inset: 0; background: rgba(15, 23, 42, 0.55);
    display: flex; align-items: center; justify-content: center;
    z-index: 100; padding: 16px;
  }
  .pin-overlay[hidden] { display: none; }
  .pin-card {
    background: white; border-radius: 14px; max-width: 380px; width: 100%;
    padding: 22px; box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
  }
  .pin-card h3 { margin: 0 0 6px; color: #1e3a8a; font-size: 18px; }
  .pin-card p { margin: 0 0 14px; color: #475569; font-size: 14px; }
  .pin-card .pin-error {
    margin: 0 0 10px; padding: 8px 10px; background: #fef2f2;
    border: 1px solid #fecaca; border-radius: 6px; color: #991b1b;
    font-size: 13px; font-weight: 600;
  }
  .pin-card .pin-error[hidden] { display: none; }
  .pin-card .pin-actions {
    display: flex; gap: 10px; justify-content: flex-end; margin-top: 14px;
  }

  /* Submit overlay (in-flight) */
  .submitting-overlay {
    position: fixed; inset: 0; background: rgba(255, 255, 255, 0.7);
    display: flex; align-items: center; justify-content: center;
    z-index: 90; font-weight: 700; color: #1e3a8a; font-size: 16px;
  }
  .submitting-overlay[hidden] { display: none; }

  /* Outcome card */
  .outcome-card { padding: 36px 28px; text-align: center; }
  .outcome-card[hidden] { display: none; }
  .outcome-card .check-mark { font-size: 64px; color: #059669; line-height: 1; margin-bottom: 12px; }
  .outcome-card h1 { margin: 0 0 6px; color: #059669; font-size: 26px; font-weight: 700; }
  .outcome-card p { margin: 0 0 8px; color: #475569; font-size: 15px; }
  .outcome-card .claim-id-line {
    margin: 14px 0; color: #1e3a8a; font-size: 16px;
  }
  .outcome-card .claim-id-line strong {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 18px; letter-spacing: 0.05em;
    background: #eff6ff; padding: 4px 10px; border-radius: 6px;
    display: inline-block; margin-left: 6px;
  }

  /* Brief 136 — localStorage autosave resume banner (mirrors Brief 122
     palette on the splash-forms public renderer) */
  .resume-banner {
    margin: 18px 22px 0; padding: 12px 14px;
    background: #fff8e1; border: 1px solid #f0c674;
    border-radius: 8px;
    display: flex; flex-wrap: wrap; align-items: center; gap: 10px;
    color: #5a4a1a; font-size: 14px;
  }
  .resume-banner-icon { font-size: 20px; line-height: 1; }
  .resume-banner-text { flex: 1 1 220px; }
  .resume-banner-actions { display: inline-flex; flex-wrap: wrap; gap: 8px; }
  .resume-banner-actions button {
    cursor: pointer; padding: 8px 14px; border-radius: 6px;
    font-size: 14px; font-weight: 600; font-family: inherit; line-height: 1.2;
  }
  .resume-banner-actions .btn-resume {
    background: #1e3a8a; color: white; border: 1px solid #1e3a8a;
  }
  .resume-banner-actions .btn-resume:hover { filter: brightness(1.05); }
  .resume-banner-actions .btn-start-over {
    background: white; color: #1e3a8a; border: 1px solid #c9c9c9;
  }
  .resume-banner-actions .btn-start-over:hover { background: #f1f5f9; }
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
    (d) => `
      <label class="radio-option">
        <input type="radio" name="determination" value="${escHtml(d.value)}" required>
        <div>
          <div class="radio-label">${escHtml(d.label)}${
            d.managersOnly ? ' <span class="pill pill-warn">Managers only</span>' : ""
          }</div>
          <div class="radio-hint">${escHtml(d.hint)}</div>
        </div>
      </label>`
  ).join("");

  const errorBanner = errorMessage
    ? `<div class="banner-error" role="alert" id="initialErrorBanner">${escHtml(errorMessage)}</div>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="icon" type="image/png" href="${escHtml(ASSETS.favicon)}">
  <title>Vehicle Issue Report — ${escHtml(locationPretty)}</title>
  <style>${SHARED_STYLES}</style>
</head>
<body>
  <div class="page" id="formPage">
    <div class="card">
      <div class="header">
        <img src="${escHtml(ASSETS.logoWhite)}" alt="Splash Car Wash">
        <h1>${escHtml(locationPretty)}</h1>
        <p>Vehicle Issue Report</p>
      </div>

      <form id="claimForm" action="/claims-api/submit-claim" method="POST" enctype="multipart/form-data" novalidate>
        ${errorBanner}
        <div class="banner-error" role="alert" id="submitError" hidden></div>

        <input type="hidden" name="location" value="${escHtml(locationCode)}">
        <input type="hidden" name="locationPretty" value="${escHtml(locationPretty)}">
        <input type="hidden" name="equipmentMalfunction" id="equipmentMalfunctionHidden" value="false">

        <div class="section" id="customerSection">
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
              <label for="customerEmail">Email Address <span class="required">*</span>
                <span class="hint">We'll email you a copy of this claim.</span>
              </label>
              <input type="email" id="customerEmail" name="customerEmail" required autocomplete="email">
            </div>
            <div class="form-group">
              <label for="mailingAddress">Mailing Address <span class="required">*</span>
                <span class="hint">Where we'll mail claim correspondence and any approved payment.</span>
              </label>
              <input type="text" id="mailingAddress" name="mailingAddress" required autocomplete="street-address">
            </div>
          </div>

          <div class="form-row">
            <div class="form-group">
              <label for="licensePlate">License Plate <span class="required">*</span></label>
              <input type="text" id="licensePlate" name="licensePlate" required style="text-transform: uppercase;">
            </div>
            <div class="form-group">
              <label for="vehicleYear">Vehicle Year <span class="required">*</span></label>
              <input type="number" id="vehicleYear" name="vehicleYear" required min="1900" max="2030">
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
            <label for="vehicleColor">Vehicle Color <span class="required">*</span></label>
            <input type="text" id="vehicleColor" name="vehicleColor" required>
          </div>

          <div class="form-group">
            <label for="issueDescription">Description of Issue <span class="required">*</span>
              <span class="hint">Please describe what happened in your own words</span>
            </label>
            <textarea id="issueDescription" name="issueDescription" required placeholder="Please describe the issue you experienced..."></textarea>
          </div>

          <div class="continue-row">
            <button type="button" class="btn-primary" id="btnContinue">Continue to staff assessment →</button>
          </div>
        </div>

        <div class="section" id="employeeSection" hidden>
          <h2 class="section-title">2. Staff Assessment</h2>
          <p class="section-sub">For Splash employees only.</p>
          <div class="staff-warning">⚠️ This section must be completed by a Splash employee.</div>

          <div class="form-row">
            <div class="form-group">
              <label for="employeeName">Employee Name <span class="required">*</span></label>
              <input type="text" id="employeeName" name="employeeName">
            </div>
            <div class="form-group">
              <label for="membershipNumber">Membership / Barcode
                <span class="hint">If customer is a member</span>
              </label>
              <input type="text" id="membershipNumber" name="membershipNumber">
            </div>
          </div>

          <!-- Photo widget: four corners (multi) -->
          <div class="photo-section" data-photo-section data-field="fourCornersPhotos" data-multi="true" data-required="true">
            <label>Four-Corner / Full-Vehicle Photos <span class="required">*</span>
              <span class="hint">Photos of all four corners showing overall vehicle condition</span>
            </label>
            <div class="photo-thumbs" data-photo-thumbs></div>
            <input type="file" accept="image/*" hidden data-photo-input>
            <button type="button" class="btn-add-photo" data-add-photo>+ Add photo</button>
          </div>

          <!-- Photo widget: VIN (single) -->
          <div class="photo-section" data-photo-section data-field="vinPhoto" data-multi="false" data-required="true">
            <label>VIN Photo <span class="required">*</span>
              <span class="hint">Usually on driver's side dashboard or door jamb</span>
            </label>
            <div class="photo-thumbs" data-photo-thumbs></div>
            <input type="file" accept="image/*" hidden data-photo-input>
            <button type="button" class="btn-add-photo" data-add-photo>+ Add photo</button>
          </div>

          <!-- Photo widget: damage (multi) -->
          <div class="photo-section" data-photo-section data-field="damagePhotos" data-multi="true" data-required="true">
            <label>Damage Photos <span class="required">*</span>
              <span class="hint">Close-up photos of all damage areas (one or more)</span>
            </label>
            <div class="photo-thumbs" data-photo-thumbs></div>
            <input type="file" accept="image/*" hidden data-photo-input>
            <button type="button" class="btn-add-photo" data-add-photo>+ Add photo</button>
          </div>

          <!-- Photo widget: license plate (single) -->
          <div class="photo-section" data-photo-section data-field="platePhoto" data-multi="false" data-required="true">
            <label>License Plate Photo <span class="required">*</span></label>
            <div class="photo-thumbs" data-photo-thumbs></div>
            <input type="file" accept="image/*" hidden data-photo-input>
            <button type="button" class="btn-add-photo" data-add-photo>+ Add photo</button>
          </div>

          <div class="form-group">
            <label for="preExistingDamage">Pre-Existing Damage Noted
              <span class="hint">Describe any damage visible before the wash</span>
            </label>
            <textarea id="preExistingDamage" name="preExistingDamage" placeholder="e.g., Scratch on rear bumper, dent on driver door..."></textarea>
          </div>

          <!-- Damage type (Brief 41): selecting "Other" reveals the
               free-text description input. Worker enforces the same
               allow-list on POST. -->
          <div class="form-group">
            <label for="damageType">Damage Type <span class="required">*</span></label>
            <select id="damageType" name="damageType" required>
              <option value="">Select damage type...</option>
              <option value="License Plate">License Plate</option>
              <option value="Wiper">Wiper</option>
              <option value="Collision">Collision</option>
              <option value="Roof Rack/Roof Accessory">Roof Rack/Roof Accessory</option>
              <option value="PS Mirror">PS Mirror</option>
              <option value="DS Mirror">DS Mirror</option>
              <option value="Window">Window</option>
              <option value="Paint Damage">Paint Damage</option>
              <option value="Rims">Rims</option>
              <option value="Tires">Tires</option>
              <option value="Other">Other</option>
            </select>
            <div id="damageOtherWrap" hidden style="margin-top: 12px;">
              <label for="damageOther">Description of other <span class="required">*</span></label>
              <input type="text" id="damageOther" name="damageOther"
                     placeholder="Describe the damage..." maxlength="200">
            </div>
          </div>

          <!-- Equipment toggle (Brief 25): defaults to No; flipping to Yes
               reveals the dropdown. equipmentInvolved submits as empty string
               when No, so the worker derives equipment_related = 0. -->
          <div class="form-group">
            <label>Was the damage equipment related?</label>
            <div class="seg-toggle" id="equipmentToggle">
              <input type="radio" name="__equipmentRelated" value="no" id="eqNo" checked>
              <label for="eqNo">No</label>
              <input type="radio" name="__equipmentRelated" value="yes" id="eqYes">
              <label for="eqYes">Yes</label>
            </div>
            <div id="equipmentDetails" hidden style="margin-top: 12px;">
              <label for="equipmentInvolved">Equipment Involved <span class="required">*</span></label>
              <select id="equipmentInvolved" name="equipmentInvolved">
                <option value="">Select equipment...</option>
                ${equipmentOpts}
              </select>
              <!-- Brief 55 (2026-05-06): equipment-malfunction checkbox hidden
                pending decision on whether to promote it to a real field (D1
                column + admin display) or remove entirely. The hidden input
                named "equipmentMalfunction" above stays wired so the
                claimData.equipmentMalfunction field continues to round-trip
                through the worker -> Power Automate -> SharePoint path with the
                legacy default of "false". To re-enable the visible toggle:
                un-comment this block and the eqMalToggle/eqMalHidden handler
                in the inline script below. -->
              <!--
              <div style="margin-top: 10px; display: flex; align-items: center; gap: 10px;">
                <input type="checkbox" id="equipmentMalfunctionToggle" style="width: 18px; height: 18px; cursor: pointer;">
                <label for="equipmentMalfunctionToggle" style="margin: 0; font-weight: 500; color: #334155; cursor: pointer;">Was there an equipment malfunction?</label>
              </div>
              -->
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

        <div class="submit-row" id="submitRow" hidden>
          <button type="submit" class="btn-submit" id="submitBtn">Submit claim</button>
        </div>
      </form>
    </div>
    <p class="footer-note">© Splash Car Wash</p>
  </div>

  <!-- Outcome card (shown post-submit) -->
  <div class="page" id="outcomePage" hidden>
    <div class="card outcome-card">
      <div class="check-mark">✓</div>
      <h1>Claim submitted</h1>
      <p>Your claim for <strong>${escHtml(locationPretty)}</strong> has been recorded.</p>
      <div class="claim-id-line">Claim ID: <strong id="outcomeClaimId"></strong></div>
      <p>Please give the customer a copy or photo of the claim ID for their records. A manager will review and may follow up.</p>
      <p id="outcomeDownloadRow" hidden style="margin: 18px 0 6px;">
        <a id="outcomeDownloadLink" class="btn-primary" href="#" target="_blank" rel="noopener noreferrer">Download a copy (PDF)</a>
      </p>
      <button type="button" class="btn-primary" onclick="window.location.reload()" style="margin-top: 10px;">Submit another claim</button>
    </div>
  </div>

  <!-- PIN modal -->
  <div class="pin-overlay" id="pinOverlay" hidden>
    <div class="pin-card">
      <h3>Staff PIN required</h3>
      <p>Enter the staff PIN to continue with the assessment portion of this claim.</p>
      <div class="pin-error" id="pinError" hidden>Incorrect PIN. Please try again.</div>
      <input type="password" inputmode="numeric" pattern="[0-9]*" id="pinInput" autocomplete="off" placeholder="••••" maxlength="8">
      <div class="pin-actions">
        <button type="button" class="btn-secondary" id="btnPinCancel">Cancel</button>
        <button type="button" class="btn-primary" id="btnPinSubmit">Continue</button>
      </div>
    </div>
  </div>

  <!-- Submitting overlay -->
  <div class="submitting-overlay" id="submittingOverlay" hidden>
    Submitting claim, please wait...
  </div>

  <script>${FORM_SCRIPT}</script>
</body>
</html>`;
}

// All client-side logic for the claim form. Defined as a plain string so
// the outer TS template literal does not interpolate any `${...}` patterns
// (the JS uses string concatenation throughout instead of JS template
// literals to keep this safe). PIN=1981 is hardcoded obfuscation, NOT a
// secret — it's customer-visible source. If the operator wants real auth
// on the staff section that's a separate brief (Supabase-backed
// short-lived token or similar).
const FORM_SCRIPT = `(function () {
  var STAFF_PIN = '1981';
  var photos = {
    fourCornersPhotos: [],
    vinPhoto: [],
    damagePhotos: [],
    platePhoto: []
  };
  var thumbUrls = []; // for revokeObjectURL on cleanup

  var form = document.getElementById('claimForm');
  if (!form) return;

  var btnContinue = document.getElementById('btnContinue');
  var customerSection = document.getElementById('customerSection');
  var employeeSection = document.getElementById('employeeSection');
  var submitRow = document.getElementById('submitRow');
  var pinOverlay = document.getElementById('pinOverlay');
  var pinInput = document.getElementById('pinInput');
  var pinError = document.getElementById('pinError');
  var btnPinSubmit = document.getElementById('btnPinSubmit');
  var btnPinCancel = document.getElementById('btnPinCancel');
  var submitError = document.getElementById('submitError');
  var submittingOverlay = document.getElementById('submittingOverlay');
  var formPage = document.getElementById('formPage');
  var outcomePage = document.getElementById('outcomePage');
  var outcomeClaimId = document.getElementById('outcomeClaimId');
  var outcomeDownloadRow = document.getElementById('outcomeDownloadRow');
  var outcomeDownloadLink = document.getElementById('outcomeDownloadLink');
  var submitBtn = document.getElementById('submitBtn');
  var employeeNameInput = document.getElementById('employeeName');

  // ---- PIN gate ----------------------------------------------------------
  function openPinModal() {
    pinError.hidden = true;
    pinInput.value = '';
    pinOverlay.hidden = false;
    setTimeout(function () { pinInput.focus(); }, 50);
  }
  function closePinModal() {
    pinOverlay.hidden = true;
  }
  function unlockEmployeeSection() {
    employeeSection.hidden = false;
    submitRow.hidden = false;
    btnContinue.parentElement.style.display = 'none';
    // employeeName becomes required only after the gate opens — keeping it
    // required while hidden would let the form's required-field check fire
    // before the operator could see the field.
    if (employeeNameInput) employeeNameInput.required = true;
    employeeSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  if (btnContinue) {
    btnContinue.addEventListener('click', function () {
      // Brief 135: validate the customer section's required fields
      // before revealing the staff section. Surface the browser's
      // native validity bubble at the first invalid field so the
      // customer fixes it without scrolling through staff content.
      if (customerSection) {
        var requiredFields = customerSection.querySelectorAll('[required]');
        for (var i = 0; i < requiredFields.length; i++) {
          var field = requiredFields[i];
          if (!field.checkValidity()) {
            field.reportValidity();
            if (typeof field.focus === 'function') field.focus();
            return;
          }
        }
      }
      openPinModal();
    });
  }
  if (btnPinCancel) {
    btnPinCancel.addEventListener('click', function () { closePinModal(); });
  }
  function trySubmitPin() {
    var v = (pinInput.value || '').trim();
    if (v === STAFF_PIN) {
      closePinModal();
      unlockEmployeeSection();
    } else {
      pinError.hidden = false;
      pinInput.value = '';
      pinInput.focus();
    }
  }
  if (btnPinSubmit) {
    btnPinSubmit.addEventListener('click', trySubmitPin);
  }
  if (pinInput) {
    pinInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        trySubmitPin();
      }
    });
  }

  // ---- Damage type (Brief 41) -------------------------------------------
  var dmgTypeSel = document.getElementById('damageType');
  var dmgOtherWrap = document.getElementById('damageOtherWrap');
  var dmgOtherInput = document.getElementById('damageOther');
  function syncDamageOther() {
    var isOther = dmgTypeSel && dmgTypeSel.value === 'Other';
    if (dmgOtherWrap) dmgOtherWrap.hidden = !isOther;
    if (dmgOtherInput) {
      if (isOther) {
        dmgOtherInput.setAttribute('required', '');
      } else {
        dmgOtherInput.removeAttribute('required');
        dmgOtherInput.value = '';
      }
    }
  }
  if (dmgTypeSel) dmgTypeSel.addEventListener('change', syncDamageOther);
  syncDamageOther();

  // ---- Equipment toggle --------------------------------------------------
  var eqDetails = document.getElementById('equipmentDetails');
  var eqSelect = document.getElementById('equipmentInvolved');
  // Brief 55 (2026-05-06): equipment-malfunction toggle hidden in
  // the form HTML above. The lookups below resolve to null at
  // runtime; the existing null-guards make this safe. Restoring
  // the visible toggle is a two-step revert -- un-comment the
  // markup block above and these handler bindings will pick it up
  // automatically.
  var eqMalToggle = document.getElementById('equipmentMalfunctionToggle');
  var eqMalHidden = document.getElementById('equipmentMalfunctionHidden');
  function syncEquipment() {
    var checked = document.querySelector('input[name="__equipmentRelated"]:checked');
    var isYes = checked && checked.value === 'yes';
    if (eqDetails) eqDetails.hidden = !isYes;
    if (eqSelect) {
      eqSelect.required = !!isYes;
      if (!isYes) {
        eqSelect.value = '';
        if (eqMalToggle) eqMalToggle.checked = false;
        if (eqMalHidden) eqMalHidden.value = 'false';
      }
    }
  }
  Array.prototype.forEach.call(
    document.querySelectorAll('input[name="__equipmentRelated"]'),
    function (r) { r.addEventListener('change', syncEquipment); }
  );
  syncEquipment();
  if (eqMalToggle && eqMalHidden) {
    eqMalToggle.addEventListener('change', function () {
      eqMalHidden.value = eqMalToggle.checked ? 'true' : 'false';
    });
  }

  // ---- Photo widgets -----------------------------------------------------
  function setupPhotoSection(section) {
    var field = section.getAttribute('data-field');
    var multi = section.getAttribute('data-multi') === 'true';
    var thumbsEl = section.querySelector('[data-photo-thumbs]');
    var input = section.querySelector('[data-photo-input]');
    var btn = section.querySelector('[data-add-photo]');

    function renderThumbs() {
      // Revoke previously-rendered URLs scoped to this section
      Array.prototype.forEach.call(
        thumbsEl.querySelectorAll('img'),
        function (img) {
          var u = img.getAttribute('data-blob-url');
          if (u) {
            try { URL.revokeObjectURL(u); } catch (_) {}
          }
        }
      );
      thumbsEl.innerHTML = '';
      photos[field].forEach(function (file, idx) {
        var url = URL.createObjectURL(file);
        thumbUrls.push(url);
        var tile = document.createElement('div');
        tile.className = 'photo-thumb';
        var img = document.createElement('img');
        img.src = url;
        img.alt = '';
        img.setAttribute('data-blob-url', url);
        var rm = document.createElement('a');
        rm.className = 'photo-remove';
        rm.href = '#';
        rm.textContent = 'Remove';
        rm.addEventListener('click', function (e) {
          e.preventDefault();
          photos[field].splice(idx, 1);
          renderThumbs();
          updateBtnLabel();
        });
        tile.appendChild(img);
        tile.appendChild(rm);
        thumbsEl.appendChild(tile);
      });
    }
    function updateBtnLabel() {
      if (photos[field].length === 0) {
        btn.textContent = '+ Add photo';
      } else if (multi) {
        btn.textContent = '+ Add another photo';
      } else {
        btn.textContent = 'Replace photo';
      }
    }

    btn.addEventListener('click', function () {
      input.click();
    });
    input.addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      if (!f) return;
      if (multi) {
        photos[field].push(f);
      } else {
        photos[field] = [f];
      }
      e.target.value = '';
      renderThumbs();
      updateBtnLabel();
    });
    updateBtnLabel();
  }
  Array.prototype.forEach.call(
    document.querySelectorAll('[data-photo-section]'),
    setupPhotoSection
  );

  // ---- Brief 136 — localStorage autosave + resume banner ----------------
  //
  // Per-customer-device persistence of customer-section + staff-section
  // form values. Mirrors the Brief 122 pattern from forms-public.js: 500ms
  // debounce on input/change, 30-day staleness, amber resume banner above
  // the first section with Resume / Start over actions, clear-on-success.
  //
  // Storage key: claims.draft.{location_code} — per-site isolation so a
  // browser used across multiple Splash sites keeps drafts separate.
  //
  // What is NOT persisted: photos. This form uses a local File-in-closure
  // pattern (photos appended to FormData at submit), NOT the OOB upload +
  // hidden r2_key pattern Brief 92 introduced for splash-forms. File
  // objects don't survive JSON.stringify, and base64-encoding photos to
  // localStorage would blow the 5MB quota on a typical 4-photo claim.
  // Customer must re-add photos on resume; the typed customer-section
  // fields (the bulk of the value) are preserved.
  //
  // The PIN gate stays sealed on resume — the staff section remains hidden
  // until the operator clicks Continue and enters the PIN. Resume restores
  // staff-section form values silently underneath; once unlocked, those
  // fields show pre-populated with whatever was saved.
  var DRAFT_KEY_PREFIX = 'claims.draft.';
  var DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
  var SAVE_DEBOUNCE_MS = 500;
  var locationInput = form.querySelector('input[name="location"]');
  var draftSite = locationInput && locationInput.value ? locationInput.value : '';
  var draftKey = draftSite ? (DRAFT_KEY_PREFIX + draftSite) : '';

  function loadDraft() {
    if (!draftKey) return null;
    try {
      var raw = window.localStorage.getItem(draftKey);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      if (!parsed.values || typeof parsed.values !== 'object') return null;
      if (typeof parsed.savedAt !== 'number') return null;
      return parsed;
    } catch (_) { return null; }
  }
  function saveDraft(values) {
    if (!draftKey) return;
    try {
      window.localStorage.setItem(draftKey, JSON.stringify({
        values: values,
        savedAt: Date.now()
      }));
    } catch (_) {
      // Quota exceeded, storage disabled, etc. — degrade silently.
    }
  }
  function clearDraft() {
    if (!draftKey) return;
    try { window.localStorage.removeItem(draftKey); } catch (_) {}
  }
  function shouldPersistName(name) {
    if (!name) return false;
    // Skip cosmetic __* prefixed fields (e.g., __equipmentRelated — the
    // companion equipmentMalfunction hidden input round-trips its
    // intended value). Skip the PIN even though pinInput sits outside
    // the form (defensive).
    if (name.indexOf('__') === 0) return false;
    if (name === 'pinInput') return false;
    return true;
  }
  function serializeForm() {
    var values = {};
    var checkboxNames = {};
    var elements = form.elements;
    for (var i = 0; i < elements.length; i++) {
      var el = elements[i];
      if (!shouldPersistName(el.name)) continue;
      var type = (el.type || '').toLowerCase();
      if (type === 'file' || type === 'submit' || type === 'button' || type === 'reset') continue;
      if (type === 'radio') {
        if (el.checked) values[el.name] = el.value;
        continue;
      }
      if (type === 'checkbox') {
        if (!checkboxNames[el.name]) {
          checkboxNames[el.name] = true;
          values[el.name] = [];
        }
        if (el.checked) values[el.name].push(el.value);
        continue;
      }
      if (el.tagName === 'SELECT' && el.multiple) {
        var opts = [];
        for (var j = 0; j < el.options.length; j++) {
          if (el.options[j].selected) opts.push(el.options[j].value);
        }
        values[el.name] = opts;
        continue;
      }
      values[el.name] = el.value;
    }
    return values;
  }
  function restoreForm(values) {
    var elements = form.elements;
    var touched = {};
    for (var i = 0; i < elements.length; i++) {
      var el = elements[i];
      if (!shouldPersistName(el.name)) continue;
      if (!Object.prototype.hasOwnProperty.call(values, el.name)) continue;
      var type = (el.type || '').toLowerCase();
      if (type === 'file' || type === 'submit' || type === 'button' || type === 'reset') continue;
      var saved = values[el.name];
      if (type === 'radio') {
        el.checked = el.value === saved;
        touched[el.name] = el;
        continue;
      }
      if (type === 'checkbox') {
        var arr = Array.isArray(saved) ? saved : (saved == null ? [] : [saved]);
        el.checked = arr.indexOf(el.value) !== -1;
        touched[el.name] = el;
        continue;
      }
      if (el.tagName === 'SELECT' && el.multiple) {
        var arr2 = Array.isArray(saved) ? saved : (saved == null ? [] : [saved]);
        for (var j = 0; j < el.options.length; j++) {
          el.options[j].selected = arr2.indexOf(el.options[j].value) !== -1;
        }
        touched[el.name] = el;
        continue;
      }
      el.value = saved == null ? '' : String(saved);
      touched[el.name] = el;
    }
    // Re-fire dependent visibility handlers AFTER values are in place so
    // damageOther / equipmentInvolved show/hide correctly. Calling
    // syncDamageOther / syncEquipment directly is idempotent and cheaper
    // than relying on synthetic 'change' events alone.
    syncDamageOther();
    syncEquipment();
    // Defensive: fire input + change events on touched elements so any
    // other wired listeners (none today, but future-proofs against new
    // field types) pick up the rehydrated values.
    Object.keys(touched).forEach(function (name) {
      var el = touched[name];
      try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) {}
      try { el.dispatchEvent(new Event('change', { bubbles: true })); } catch (_) {}
    });
  }
  // Debounced autosave via event delegation on the form root — any named
  // input / textarea / select inside the form triggers a save without
  // explicit per-field wiring.
  var saveTimer;
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { saveDraft(serializeForm()); }, SAVE_DEBOUNCE_MS);
  }
  form.addEventListener('input', scheduleSave);
  form.addEventListener('change', scheduleSave);

  // Resume banner on init. If a <30-day draft exists, surface an amber
  // banner above the first section with Resume / Start over actions.
  // Stale drafts (>30 days) clear silently.
  function formatTimeAgo(ms) {
    var s = Math.round(ms / 1000);
    if (s < 60) return s <= 1 ? '1 sec ago' : s + ' sec ago';
    var m = Math.round(s / 60);
    if (m < 60) return m === 1 ? '1 min ago' : m + ' min ago';
    var h = Math.round(m / 60);
    if (h < 24) return h === 1 ? '1 hr ago' : h + ' hr ago';
    var d = Math.round(h / 24);
    return d === 1 ? '1 day ago' : d + ' days ago';
  }
  function maybeRenderResumeBanner() {
    var draft = loadDraft();
    if (!draft) return;
    var age = Date.now() - draft.savedAt;
    if (age < 0 || age > DRAFT_TTL_MS) {
      clearDraft();
      return;
    }
    var banner = document.createElement('div');
    banner.className = 'resume-banner';
    banner.setAttribute('role', 'status');
    banner.setAttribute('data-resume-banner', '1');
    var icon = document.createElement('span');
    icon.setAttribute('aria-hidden', 'true');
    icon.className = 'resume-banner-icon';
    icon.textContent = '📋';
    banner.appendChild(icon);
    var text = document.createElement('span');
    text.className = 'resume-banner-text';
    text.innerHTML = 'We saved your progress from <strong></strong>. Pick up where you left off?';
    text.querySelector('strong').textContent = formatTimeAgo(age);
    banner.appendChild(text);
    var actions = document.createElement('span');
    actions.className = 'resume-banner-actions';
    var resumeBtn = document.createElement('button');
    resumeBtn.type = 'button';
    resumeBtn.className = 'btn-resume';
    resumeBtn.textContent = 'Resume';
    resumeBtn.addEventListener('click', function () {
      restoreForm(draft.values);
      removeBanner();
    });
    var startOverBtn = document.createElement('button');
    startOverBtn.type = 'button';
    startOverBtn.className = 'btn-start-over';
    startOverBtn.textContent = 'Start over';
    startOverBtn.addEventListener('click', function () {
      clearDraft();
      removeBanner();
    });
    actions.appendChild(resumeBtn);
    actions.appendChild(startOverBtn);
    banner.appendChild(actions);
    function removeBanner() {
      if (banner.parentNode) banner.parentNode.removeChild(banner);
    }
    // Insert above the customer section (the first .section inside the
    // form). Falls back to the form's first child if the section lookup
    // somehow misses.
    var firstSection = form.querySelector('.section');
    if (firstSection && firstSection.parentNode === form) {
      form.insertBefore(banner, firstSection);
    } else if (form.firstChild) {
      form.insertBefore(banner, form.firstChild);
    } else {
      form.appendChild(banner);
    }
  }
  maybeRenderResumeBanner();

  // ---- Submit ------------------------------------------------------------
  function showError(msg) {
    submitError.textContent = msg || 'Submission failed. Please retry.';
    submitError.hidden = false;
    submitError.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  function clearError() {
    submitError.hidden = true;
    submitError.textContent = '';
  }
  function setSubmitting(on) {
    submittingOverlay.hidden = !on;
    submitBtn.disabled = !!on;
    if (on) submitBtn.textContent = 'Submitting...';
    else submitBtn.textContent = 'Submit claim';
  }
  function showOutcome(claimId, summaryPdfUrl) {
    setSubmitting(false);
    formPage.hidden = true;
    outcomePage.hidden = false;
    outcomeClaimId.textContent = claimId || '(unknown)';
    if (summaryPdfUrl && outcomeDownloadLink && outcomeDownloadRow) {
      outcomeDownloadLink.setAttribute('href', summaryPdfUrl);
      outcomeDownloadRow.hidden = false;
    } else if (outcomeDownloadRow) {
      outcomeDownloadRow.hidden = true;
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function validateBeforeSubmit() {
    clearError();
    syncEquipment();
    syncDamageOther();
    // HTML5 validation across the whole form (now that employee fields are
    // visible). reportValidity() shows the browser's bubble on the first
    // invalid input. damageType is required; damageOther is required only
    // when damageType === 'Other' (toggled by syncDamageOther) — so both
    // gates are covered without explicit checks here.
    if (!form.checkValidity()) {
      form.reportValidity();
      return false;
    }
    var missing = [];
    if (photos.fourCornersPhotos.length === 0) missing.push('four-corner photos');
    if (photos.vinPhoto.length === 0) missing.push('VIN photo');
    if (photos.damagePhotos.length === 0) missing.push('damage photos');
    if (photos.platePhoto.length === 0) missing.push('license-plate photo');
    if (missing.length > 0) {
      showError('Please add: ' + missing.join(', ') + '.');
      return false;
    }
    return true;
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!validateBeforeSubmit()) return;
    // Brief 136: clear the localStorage draft optimistically before the
    // fetch fires. Mirrors Brief 122's option B — trade-off is that a
    // network/server failure leaves the customer with an empty draft on
    // next page load, but the DOM state survives until they navigate
    // away. validateBeforeSubmit() already gated; only valid submits
    // reach this point.
    clearDraft();

    var fd = new FormData(form);
    fd.delete('__equipmentRelated');
    // When the equipment toggle is No, equipmentInvolved is hidden and the
    // form serializes it as empty (or the field is absent); ensure the
    // worker sees an empty string so equipment_related derives to 0.
    var checked = document.querySelector('input[name="__equipmentRelated"]:checked');
    if (!checked || checked.value === 'no') {
      fd.set('equipmentInvolved', '');
    }
    // Append photos under the canonical worker field names. The worker uses
    // formData.getAll(field) so multiple appends per key land cleanly.
    ['fourCornersPhotos', 'vinPhoto', 'damagePhotos', 'platePhoto'].forEach(function (field) {
      photos[field].forEach(function (file) {
        fd.append(field, file, file.name);
      });
    });

    setSubmitting(true);
    fetch('/claims-api/submit-claim', {
      method: 'POST',
      body: fd,
      headers: { 'Accept': 'application/json' }
    }).then(function (r) {
      return r.text().then(function (text) {
        var body = null;
        try { body = JSON.parse(text); } catch (_) { body = null; }
        return { status: r.status, ok: r.ok, body: body, raw: text };
      });
    }).then(function (out) {
      if (out.ok && out.body && out.body.ok) {
        showOutcome(
          out.body.claim_id || out.body.claimId || '',
          out.body.summary_pdf_url || ''
        );
      } else {
        var errMsg = (out.body && out.body.error)
          || (out.body && out.body.message)
          || ('Submission failed (status ' + out.status + ').');
        showError(errMsg + ' Please retry.');
        setSubmitting(false);
      }
    }).catch(function (err) {
      var msg = (err && err.message) ? err.message : 'unknown';
      showError('Network error: ' + msg + '. Please check your connection and retry.');
      setSubmitting(false);
    });
  });
})();`;

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
