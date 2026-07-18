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
import { EMAIL_REGEX_SOURCE } from "@splash/types/email-validate";

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
  /* Brief 138 Phase 2 — offline indicator */
  .banner-offline {
    margin: 0 18px 18px; padding: 10px 14px;
    background: #fef3c7; color: #92400e;
    border: 1px solid #fde68a; border-radius: 6px;
    font-size: 14px; line-height: 1.4;
  }
  .banner-offline[hidden] { display: none; }
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

  /* Brief 146 — per-photo upload state badges */
  .photo-thumb .photo-state {
    position: absolute; top: 4px; left: 4px;
    background: rgba(15, 23, 42, 0.78); color: white;
    padding: 2px 8px; border-radius: 999px;
    font-size: 11px; font-weight: 700; letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .photo-thumb .photo-state.state-ok { background: rgba(5, 150, 105, 0.85); }
  .photo-thumb .photo-state.state-uploading { background: rgba(30, 58, 138, 0.85); }
  .photo-thumb .photo-state.state-failed { background: rgba(220, 38, 38, 0.9); }
  .photo-thumb .photo-retry {
    display: block; text-align: center; padding: 6px 4px;
    font-size: 12px; font-weight: 700; color: white;
    background: #dc2626; text-decoration: none; cursor: pointer;
  }
  .photo-thumb .photo-retry:hover { background: #b91c1c; }
  .photo-thumb.is-placeholder {
    background: #eff6ff; min-height: 110px;
    display: flex; align-items: center; justify-content: center;
  }
  .photo-thumb.is-placeholder .placeholder-text {
    color: #1e3a8a; font-weight: 700; font-size: 13px; text-align: center;
    padding: 8px;
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

      <form id="claimForm" action="/claims-api/submit-claim" method="POST" novalidate>
        ${errorBanner}
        <div class="banner-error" role="alert" id="submitError" hidden></div>
        <div class="banner-offline" role="status" aria-live="polite" id="offlineBanner" hidden>You're offline — your form is saved on this device. Submit will retry automatically when the connection comes back.</div>

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
              <label for="mailingAddress">Mailing Address <span class="required">*</span></label>
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

          <!-- Date AND time the customer says the damage occurred. This is the
               only date/time field on the form, so it is REQUIRED (validated
               server-side; no HTML required attr because this section starts
               hidden and a hidden required field is non-focusable). Maps to
               claims.incident_date. Worker parses "incidentDate" on POST. -->
          <div class="form-group">
            <label for="incidentDate">Date &amp; Time Damage Occurred <span class="required">*</span>
              <span class="hint">When the customer says the damage happened — their visit date and time</span>
            </label>
            <input type="datetime-local" id="incidentDate" name="incidentDate">
          </div>

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

          <!-- Feature 4: vehicle condition. Required; worker enforces the
               same allow-list on POST. -->
          <div class="form-group">
            <label for="vehicleCondition">Vehicle Condition <span class="required">*</span></label>
            <select id="vehicleCondition" name="vehicleCondition" required>
              <option value="">Select condition...</option>
              <option value="Poor">Poor</option>
              <option value="Fair">Fair</option>
              <option value="Good">Good</option>
              <option value="Excellent">Excellent</option>
            </select>
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

          <div class="form-group">
            <label>Determination <span class="required">*</span></label>
            <div class="radio-group">
              ${determinationOpts}
            </div>
          </div>

          <!-- Equipment toggle (Brief 25): reveals only when the determination
               is "Requested Customer Get Quote(s)" (customer_get_quotes), and
               when shown a Yes/No answer is required. Flipping to Yes reveals
               the Equipment Involved dropdown. When hidden, no radio is checked
               and equipmentInvolved submits empty, so the worker derives
               equipment_related = 0. Ordered AFTER Determination on purpose. -->
          <div class="form-group" id="equipmentGroup" hidden>
            <label>Was the damage equipment related? <span class="required">*</span></label>
            <div class="seg-toggle" id="equipmentToggle">
              <input type="radio" name="__equipmentRelated" value="no" id="eqNo">
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
            <label for="customerTold">What Was the Customer Told? <span class="required">*</span>
              <span class="hint">Document exactly what you communicated to the customer</span>
            </label>
            <textarea id="customerTold" name="customerTold" required placeholder="e.g., Explained that a manager will review and contact them within 48 hours..."></textarea>
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

  // Brief 152 — pragmatic email regex compiled from EMAIL_REGEX_SOURCE in
  // @splash/types/email-validate so this client-side gate matches the
  // server-side isValidEmail check exactly. DO NOT EDIT inline — fix the
  // canonical source. Rejects trailing/leading/consecutive dots in
  // local-part that pass HTML5 type="email" + the legacy loose regex.
  var EMAIL_RE = new RegExp(${JSON.stringify(EMAIL_REGEX_SOURCE)});
  function validateCustomerEmail(input) {
    if (!input) return true;
    var v = (input.value || '').trim();
    if (v.length === 0 || v.length > 254) return false;
    return EMAIL_RE.test(v);
  }
  // Brief 146 — photoRefs is the authoritative submit payload (R2 keys for
  // OOB-uploaded photos). photos[] still holds File handles for the in-
  // session preview thumbnail and (when needed) retry-upload bytes, but the
  // submit POST no longer carries the File bytes. photoRefs entries align
  // 1:1 with photos[] by index.
  var FIELDS = ['fourCornersPhotos', 'vinPhoto', 'damagePhotos', 'platePhoto'];
  var photos = {
    fourCornersPhotos: [],
    vinPhoto: [],
    damagePhotos: [],
    platePhoto: []
  };
  // Each entry: { r2_key, mime, size_bytes, original_filename } OR
  // { pending: true, retryCount: number, error: msg } during upload OR
  // { failed: true, retryCount: number, error: msg } after exhausted retries.
  // The submit-eligibility check requires every entry to have r2_key set.
  var photoRefs = {
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
  var offlineBanner = document.getElementById('offlineBanner');
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
        // Brief 152: explicit email-regex check on top of HTML5 validity.
        // The browser's type="email" validator accepts trailing-dot
        // local-parts (e.g. "name.@gmail.com") which Exchange Online
        // rejects during recipient resolution. Surface the customError
        // bubble at the customerEmail field if so.
        var emailField = document.getElementById('customerEmail');
        if (emailField && !validateCustomerEmail(emailField)) {
          if (typeof emailField.setCustomValidity === 'function') {
            emailField.setCustomValidity('Please enter a valid email address.');
          }
          emailField.reportValidity();
          if (typeof emailField.setCustomValidity === 'function') {
            emailField.setCustomValidity('');
          }
          if (typeof emailField.focus === 'function') emailField.focus();
          return;
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
  var eqGroup = document.getElementById('equipmentGroup');
  var eqRadios = document.querySelectorAll('input[name="__equipmentRelated"]');
  // The equipment question is only relevant for the "Requested Customer Get
  // Quote(s)" determination. Show it only for that path; when shown a Yes/No
  // answer is required (radios flagged required, no default checked). When
  // hidden we clear the radios + drop 'required' so the group can't block
  // native form validation (the 'hidden' attribute alone does NOT exclude an
  // input from checkValidity — only removing 'required'/'disabled' does).
  function equipmentApplies() {
    var det = document.querySelector('input[name="determination"]:checked');
    return !!det && det.value === 'customer_get_quotes';
  }
  function syncEquipment() {
    var applies = equipmentApplies();
    if (eqGroup) eqGroup.hidden = !applies;
    if (!applies) {
      Array.prototype.forEach.call(eqRadios, function (r) {
        r.checked = false;
        r.required = false;
      });
    } else {
      Array.prototype.forEach.call(eqRadios, function (r) {
        r.required = true;
      });
    }
    var checked = document.querySelector('input[name="__equipmentRelated"]:checked');
    var isYes = applies && checked && checked.value === 'yes';
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
    eqRadios,
    function (r) { r.addEventListener('change', syncEquipment); }
  );
  Array.prototype.forEach.call(
    document.querySelectorAll('input[name="determination"]'),
    function (r) { r.addEventListener('change', syncEquipment); }
  );
  syncEquipment();
  if (eqMalToggle && eqMalHidden) {
    eqMalToggle.addEventListener('change', function () {
      eqMalHidden.value = eqMalToggle.checked ? 'true' : 'false';
    });
  }

  // ---- Photo widgets (Brief 146 — OOB upload + client-side resize) -------
  //
  // On file pick:
  //   1. Resize the image to a 2048 px long edge at JPEG q=0.90 via
  //      createImageBitmap → <canvas> → canvas.toBlob. createImageBitmap
  //      honors EXIF orientation natively on iOS Safari 14+ and modern
  //      Chrome; on older Android we accept the small upright-rotation
  //      risk (the resized JPEG still embeds the original orientation
  //      metadata). Images already ≤ 2048 px long edge skip resize.
  //   2. POST the resized blob to /claims-api/upload with the per-form
  //      pending_submission_id (== the idempotency key). Worker returns
  //      { ok, r2_key, mime, size_bytes, original_filename }.
  //   3. On success, store the r2_key in photoRefs[field]; render a
  //      thumbnail with a green ✓ badge.
  //   4. On failure (network, non-2xx), three transparent auto-retries
  //      with 500ms / 1500ms / 3500ms backoff, then surface a red retry
  //      icon. Manual retry click re-fires uploadOne with another bounded
  //      retry budget.
  //   5. Submit button disables until every visible photo entry has an
  //      r2_key (no pending or failed uploads).
  //
  // Removed photos leave R2 orphans — the daily cleanup cron sweeps
  // claim-uploads/{pendingId}/... entries with no matching claim row,
  // so client-side delete is a no-op on R2.

  function fileExt(name) {
    var dot = name.lastIndexOf('.');
    return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
  }

  // Resize via canvas. Returns a Blob (JPEG q=0.90) when scaling was
  // applied, the original File when no scaling was needed, or null if
  // anything in the pipeline failed (caller falls through to upload the
  // original File).
  function resizeImage(file) {
    var MAX_EDGE = 2048;
    var JPEG_QUALITY = 0.90;
    // HEIC isn't decodable by createImageBitmap in most browsers — punt
    // straight to upload-as-is. Worker accepts heic/heif passthrough.
    var name = (file.name || '').toLowerCase();
    if (name.indexOf('.heic') >= 0 || name.indexOf('.heif') >= 0 ||
        (file.type || '').indexOf('heic') >= 0 ||
        (file.type || '').indexOf('heif') >= 0) {
      return Promise.resolve(file);
    }
    if (typeof createImageBitmap !== 'function') return Promise.resolve(file);
    return createImageBitmap(file).then(function (bmp) {
      var w = bmp.width;
      var h = bmp.height;
      var longEdge = Math.max(w, h);
      if (longEdge <= MAX_EDGE) {
        try { bmp.close && bmp.close(); } catch (_) {}
        return file;
      }
      var scale = MAX_EDGE / longEdge;
      var tw = Math.round(w * scale);
      var th = Math.round(h * scale);
      var canvas = document.createElement('canvas');
      canvas.width = tw;
      canvas.height = th;
      var ctx = canvas.getContext('2d');
      ctx.drawImage(bmp, 0, 0, tw, th);
      try { bmp.close && bmp.close(); } catch (_) {}
      return new Promise(function (resolve) {
        canvas.toBlob(function (blob) {
          if (!blob) {
            resolve(file); // fall through to original
            return;
          }
          // Stamp a synthetic name so the worker has something to log.
          // Strip the source extension before appending .jpg so a resized
          // photo.jpg/photo.png doesn't become photo.jpg.jpg / photo.png.jpg.
          // (String ops, not regex — this whole script is a TS template
          //  literal, so a /\.x/ regex would lose its backslash on render.)
          try {
            var srcName = file.name || 'photo';
            var dotAt = srcName.lastIndexOf('.');
            var base = dotAt > 0 ? srcName.slice(0, dotAt) : srcName;
            var renamed = new File([blob], base + '.jpg',
              { type: 'image/jpeg' });
            resolve(renamed);
          } catch (_) {
            resolve(blob);
          }
        }, 'image/jpeg', JPEG_QUALITY);
      });
    }).catch(function (_err) {
      // createImageBitmap can throw on weird/corrupt inputs — upload as-is.
      return file;
    });
  }

  var BACKOFF_MS = [500, 1500, 3500];
  var MAX_AUTO_RETRIES = 3;

  function uploadOne(field, blob) {
    var fd = new FormData();
    fd.append('pending_submission_id', currentPendingId());
    fd.append('field', field);
    fd.append('file', blob, (blob && blob.name) || 'photo.jpg');
    var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timer = setTimeout(function () {
      if (controller) controller.abort();
    }, 60000);
    var opts = { method: 'POST', body: fd, headers: { 'Accept': 'application/json' } };
    if (controller) opts.signal = controller.signal;
    return fetch('/claims-api/upload', opts).then(function (r) {
      clearTimeout(timer);
      if (!r.ok) {
        return r.text().then(function (t) {
          var parsed = null;
          try { parsed = JSON.parse(t); } catch (_) {}
          var msg = (parsed && parsed.error) || ('upload failed (' + r.status + ')');
          throw new Error(msg);
        });
      }
      return r.json();
    }, function (err) {
      clearTimeout(timer);
      throw err;
    });
  }

  function currentPendingId() {
    // Defined after this section; reads the closure variable below.
    return submissionId;
  }

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
      var entries = photoRefs[field];
      entries.forEach(function (entry, idx) {
        var tile = document.createElement('div');
        tile.className = 'photo-thumb';
        // Thumbnail. Prefer the in-session File from photos[field][idx]; on
        // a Resume restore where photos[] is empty but photoRefs has r2_keys,
        // show a placeholder tile.
        var file = photos[field][idx] || null;
        if (file && typeof URL.createObjectURL === 'function') {
          var url = URL.createObjectURL(file);
          thumbUrls.push(url);
          var img = document.createElement('img');
          img.src = url;
          img.alt = '';
          img.setAttribute('data-blob-url', url);
          tile.appendChild(img);
        } else {
          tile.classList.add('is-placeholder');
          var ph = document.createElement('div');
          ph.className = 'placeholder-text';
          ph.textContent = entry && entry.r2_key
            ? '✓ Uploaded'
            : (entry && entry.failed ? 'Upload failed' : 'Uploading…');
          tile.appendChild(ph);
        }
        // State badge.
        var state = document.createElement('span');
        state.className = 'photo-state';
        if (entry && entry.r2_key) {
          state.classList.add('state-ok');
          state.textContent = '✓';
        } else if (entry && entry.failed) {
          state.classList.add('state-failed');
          state.textContent = '!';
        } else {
          state.classList.add('state-uploading');
          state.textContent = '…';
        }
        tile.appendChild(state);
        // Remove or retry action.
        if (entry && entry.failed) {
          var retry = document.createElement('a');
          retry.className = 'photo-retry';
          retry.href = '#';
          retry.textContent = 'Retry';
          (function (capturedIdx, capturedEntry) {
            retry.addEventListener('click', function (e) {
              e.preventDefault();
              // Find the current idx — array may have shifted since render.
              var currentIdx = photoRefs[field].indexOf(capturedEntry);
              if (currentIdx < 0) return;
              var f = photos[field][currentIdx];
              if (!f) {
                // No File in session (post-Resume retry on a previously-failed
                // upload). Force the customer to re-add the photo.
                photos[field].splice(currentIdx, 1);
                photoRefs[field].splice(currentIdx, 1);
                renderThumbs();
                updateBtnLabel();
                updateSubmitGate();
                return;
              }
              capturedEntry.pending = true;
              capturedEntry.failed = false;
              capturedEntry.retryCount = 0;
              capturedEntry.error = undefined;
              renderThumbs();
              updateSubmitGate();
              uploadWithRetries(field, capturedEntry, f);
            });
          })(idx, entry);
          tile.appendChild(retry);
        } else {
          var rm = document.createElement('a');
          rm.className = 'photo-remove';
          rm.href = '#';
          rm.textContent = 'Remove';
          (function (capturedEntry) {
            rm.addEventListener('click', function (e) {
              e.preventDefault();
              // Find current idx — earlier splices may have shifted it.
              var currentIdx = photoRefs[field].indexOf(capturedEntry);
              if (currentIdx < 0) return;
              photos[field].splice(currentIdx, 1);
              photoRefs[field].splice(currentIdx, 1);
              renderThumbs();
              updateBtnLabel();
              updateSubmitGate();
              // Persist the updated photoRefs into the draft.
              scheduleSave();
            });
          })(entry);
          tile.appendChild(rm);
        }
        thumbsEl.appendChild(tile);
      });
    }
    function updateBtnLabel() {
      if (photoRefs[field].length === 0) {
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
      var entry = { pending: true, retryCount: 0 };
      if (multi) {
        photos[field].push(f);
        photoRefs[field].push(entry);
      } else {
        // Single-photo widget — replacing wipes the existing entry and
        // its uploaded ref (orphan cleanup sweeps R2 later).
        photos[field] = [f];
        photoRefs[field] = [entry];
      }
      e.target.value = '';
      renderThumbs();
      updateBtnLabel();
      updateSubmitGate();
      uploadWithRetries(field, entry, f);
    });

    // Expose renderThumbs/updateBtnLabel via section so restoreFromDraft
    // can repaint after Resume.
    section.__renderThumbs = renderThumbs;
    section.__updateBtnLabel = updateBtnLabel;
    updateBtnLabel();
  }

  function uploadWithRetries(field, entry, file) {
    // Resize first, then upload. Resize failure falls through to upload
    // the original file (resizeImage handles its own errors).
    resizeImage(file).then(function (blob) {
      attemptUpload(field, entry, blob, 0);
    });
  }
  // Closure-captured entry reference is the authoritative state owner.
  // When the customer removes a photo the entry gets spliced out of
  // photoRefs[field] but the in-flight handler still holds a reference
  // to it; we mutate the orphaned object harmlessly and skip the
  // repaint when entry is no longer in the array. Avoids index-shift
  // bugs that an idx-based scheme would inherit from parallel uploads.
  function entryStillTracked(field, entry) {
    var arr = photoRefs[field];
    for (var i = 0; i < arr.length; i++) {
      if (arr[i] === entry) return true;
    }
    return false;
  }
  function attemptUpload(field, entry, blob, attempt) {
    if (!entry.pending) return;
    if (!entryStillTracked(field, entry)) return;
    uploadOne(field, blob).then(function (out) {
      if (!entryStillTracked(field, entry)) return;
      if (out && out.ok && out.r2_key) {
        entry.pending = false;
        entry.r2_key = out.r2_key;
        entry.mime = out.mime;
        entry.size_bytes = out.size_bytes;
        entry.original_filename = out.original_filename;
        repaintSection(field);
        updateSubmitGate();
        scheduleSave();
      } else {
        markFailedOrRetry(field, entry, blob, attempt, 'upload returned ok=false');
      }
    }).catch(function (err) {
      markFailedOrRetry(field, entry, blob, attempt, err && err.message || 'upload error');
    });
  }
  function markFailedOrRetry(field, entry, blob, attempt, errMsg) {
    if (!entry.pending) return;
    if (!entryStillTracked(field, entry)) return;
    var nextAttempt = attempt + 1;
    if (nextAttempt < MAX_AUTO_RETRIES) {
      var delay = BACKOFF_MS[nextAttempt - 1] || BACKOFF_MS[BACKOFF_MS.length - 1];
      entry.retryCount = nextAttempt;
      setTimeout(function () { attemptUpload(field, entry, blob, nextAttempt); }, delay);
      return;
    }
    entry.pending = false;
    entry.failed = true;
    entry.retryCount = nextAttempt;
    entry.error = errMsg;
    repaintSection(field);
    updateSubmitGate();
  }
  function repaintSection(field) {
    var section = document.querySelector('[data-photo-section][data-field="' + field + '"]');
    if (section && section.__renderThumbs) {
      section.__renderThumbs();
      if (section.__updateBtnLabel) section.__updateBtnLabel();
    }
  }
  // Submit button is disabled until every visible photo entry has r2_key.
  // Also disabled when no photos at all (validateBeforeSubmit catches it,
  // but disabling avoids the customer scrolling back to see the banner).
  function allPhotosReady() {
    var anyPending = false;
    for (var i = 0; i < FIELDS.length; i++) {
      var entries = photoRefs[FIELDS[i]];
      for (var j = 0; j < entries.length; j++) {
        var e = entries[j];
        if (!e || !e.r2_key) { anyPending = true; break; }
      }
      if (anyPending) break;
    }
    return !anyPending;
  }
  function updateSubmitGate() {
    if (!submitBtn) return;
    submitBtn.disabled = !allPhotosReady();
    if (submitBtn.disabled) {
      submitBtn.title = 'Waiting for photo uploads to finish…';
    } else {
      submitBtn.removeAttribute('title');
    }
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
      // Brief 139: surface idempotencyKey with defensive UUID v4 validation.
      // Drafts saved by pre-Brief-139 builds won't have the field — that's
      // fine, the IIFE init falls through to generateSubmissionId().
      var idemRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      var idemKey = (typeof parsed.idempotencyKey === 'string' && idemRe.test(parsed.idempotencyKey))
        ? parsed.idempotencyKey
        : null;
      // Brief 146: surface persisted photoRefs. Drafts saved by pre-
      // Brief-146 builds won't have the field; init falls through to
      // empty arrays per category.
      var photoRefsRestored = null;
      if (parsed.photoRefs && typeof parsed.photoRefs === 'object') {
        photoRefsRestored = {};
        for (var k = 0; k < FIELDS.length; k++) {
          var fld = FIELDS[k];
          var arr = parsed.photoRefs[fld];
          if (Array.isArray(arr)) {
            // Filter to entries with valid r2_key shape — defense against
            // tampered localStorage.
            var filtered = [];
            for (var m = 0; m < arr.length; m++) {
              var ent = arr[m];
              if (ent && typeof ent === 'object' &&
                  typeof ent.r2_key === 'string' &&
                  ent.r2_key.indexOf('claim-uploads/') === 0) {
                filtered.push({
                  r2_key: ent.r2_key,
                  mime: typeof ent.mime === 'string' ? ent.mime : 'image/jpeg',
                  size_bytes: typeof ent.size_bytes === 'number' ? ent.size_bytes : 0,
                  original_filename: typeof ent.original_filename === 'string' ? ent.original_filename : ''
                });
              }
            }
            photoRefsRestored[fld] = filtered;
          } else {
            photoRefsRestored[fld] = [];
          }
        }
      }
      return {
        values: parsed.values,
        savedAt: parsed.savedAt,
        idempotencyKey: idemKey,
        photoRefs: photoRefsRestored
      };
    } catch (_) { return null; }
  }
  function saveDraft(values) {
    if (!draftKey) return;
    try {
      // Brief 139: persist the current submissionId alongside the typed
      // values so a tab-close + reload + Resume reuses the same key,
      // letting the worker dedup any duplicate-submit-after-lost-response.
      // Brief 146: persist the photoRefs map so a Resume picks up the
      // already-uploaded photos without re-prompting the customer. Only
      // successfully-uploaded entries (r2_key set) are stored — pending /
      // failed entries die with the page session.
      var photoRefsPersist = {};
      for (var k = 0; k < FIELDS.length; k++) {
        var fld = FIELDS[k];
        var arr = photoRefs[fld];
        var keep = [];
        for (var m = 0; m < arr.length; m++) {
          var ent = arr[m];
          if (ent && ent.r2_key) {
            keep.push({
              r2_key: ent.r2_key,
              mime: ent.mime,
              size_bytes: ent.size_bytes,
              original_filename: ent.original_filename
            });
          }
        }
        photoRefsPersist[fld] = keep;
      }
      window.localStorage.setItem(draftKey, JSON.stringify({
        values: values,
        savedAt: Date.now(),
        idempotencyKey: submissionId,
        photoRefs: photoRefsPersist
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
      // Brief 146: restore the persisted photoRefs and repaint every photo
      // section with placeholder tiles for each. photos[] (File handles)
      // stays empty — customers re-add the File only if they want to
      // change a photo; the r2_key alone is sufficient for submit.
      if (draft.photoRefs) {
        for (var k = 0; k < FIELDS.length; k++) {
          var fld = FIELDS[k];
          var restoredArr = draft.photoRefs[fld] || [];
          photoRefs[fld] = restoredArr.slice();
          // Pad photos[] with nulls so indexes line up; renderThumbs
          // tolerates null and falls back to a placeholder tile.
          photos[fld] = new Array(restoredArr.length);
          repaintSection(fld);
        }
        updateSubmitGate();
      }
      removeBanner();
    });
    var startOverBtn = document.createElement('button');
    startOverBtn.type = 'button';
    startOverBtn.className = 'btn-start-over';
    startOverBtn.textContent = 'Start over';
    startOverBtn.addEventListener('click', function () {
      clearDraft();
      // Brief 139: regenerate the idempotency key so the next submit
      // attempt is treated as a genuinely new claim, not a retry of the
      // discarded draft's prior key.
      submissionId = generateSubmissionId();
      // Brief 146: also wipe any photoRefs hanging around in memory. The
      // associated R2 objects (under the prior submissionId prefix) get
      // swept by the daily orphan cleanup.
      for (var k = 0; k < FIELDS.length; k++) {
        photoRefs[FIELDS[k]] = [];
        photos[FIELDS[k]] = [];
        repaintSection(FIELDS[k]);
      }
      updateSubmitGate();
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

  // ---- Brief 138 Phase 2 — offline indicator ----------------------------
  //
  // navigator.onLine is a best-effort browser hint; it's accurate enough for
  // a visual cue but the retry loop (Phase 4) is the authoritative gate.
  // Submit button stays clickable while offline — Phase 4's retry loop polls
  // for connectivity and the offline banner is the visual cue, not button
  // gating (disabling would be a regression vs the pre-Brief-138 one-shot
  // behavior which also let customers click while offline).
  var pendingOnlineRetry = null;
  function updateOfflineBanner() {
    if (!offlineBanner) return;
    offlineBanner.hidden = !!navigator.onLine;
  }
  window.addEventListener('online', function () {
    updateOfflineBanner();
    // Brief 138 Phase 4 — if a retry attempt is held pending reconnection,
    // fire it immediately instead of waiting out the backoff timer.
    if (typeof pendingOnlineRetry === 'function') {
      var fn = pendingOnlineRetry;
      pendingOnlineRetry = null;
      try { fn(); } catch (_) {}
    }
  });
  window.addEventListener('offline', updateOfflineBanner);
  updateOfflineBanner();

  // ---- Brief 138 Phase 3 — idempotency key ------------------------------
  //
  // Generated once per form instance and reused on every retry attempt (the
  // whole point — a retried submission lands on the same row, not a
  // duplicate). Regenerated only on showOutcome success.
  //
  // Brief 139: prefer an idempotencyKey restored from the localStorage
  // draft over a freshly-generated one. The restored key fingerprints the
  // customer's prior submit attempt — if that attempt actually succeeded
  // server-side but the response was lost (Wi-Fi blip, edge timeout, tab
  // closed mid-response), reusing the key on retry collapses to the
  // existing claim via the worker's dedup path instead of creating a
  // duplicate. loadDraft() is a function declaration further down the file
  // — JavaScript hoists function declarations, so the call here is safe.
  function generateSubmissionId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      try { return window.crypto.randomUUID(); } catch (_) { /* fall through */ }
    }
    // RFC 4122 v4 polyfill for older Safari etc. Math.random is fine here:
    // the value is a client-supplied dedup hint, not a security token.
    var hex = '0123456789abcdef';
    var s = '';
    for (var i = 0; i < 36; i++) {
      if (i === 8 || i === 13 || i === 18 || i === 23) { s += '-'; continue; }
      if (i === 14) { s += '4'; continue; }
      var r = Math.random() * 16 | 0;
      if (i === 19) r = (r & 0x3) | 0x8;
      s += hex.charAt(r);
    }
    return s;
  }
  var existingDraft = loadDraft();
  var submissionId = (existingDraft && existingDraft.idempotencyKey)
    ? existingDraft.idempotencyKey
    : generateSubmissionId();

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
  function setSubmitting(on, attempt) {
    submittingOverlay.hidden = !on;
    submitBtn.disabled = !!on;
    if (on) {
      submitBtn.textContent = 'Submitting...';
      if (submittingOverlay) {
        if (attempt && attempt > 1) {
          submittingOverlay.textContent = 'Submitting (retry ' + (attempt - 1) + ' of 3)...';
        } else {
          submittingOverlay.textContent = 'Submitting claim, please wait...';
        }
      }
    } else {
      submitBtn.textContent = 'Submit claim';
      if (submittingOverlay) submittingOverlay.textContent = 'Submitting claim, please wait...';
    }
  }

  // ---- Brief 138 Phase 4 — retry with exponential backoff ---------------
  //
  // Wraps fetch in a retry loop covering transient network failures + HTTP
  // 408/500/502/503/504. The submitting overlay stays up across attempts;
  // overlay text shows attempt count for the second + later attempts.
  // The worker dedups using idempotency_key (Phase 3), so a re-fired
  // attempt after a lost-response success collapses to the original
  // claim's response shape — no duplicate row.
  // Brief 140 widened the retryable set to include 500. Brief 140
  // redefines 500 to mean "transient D1 failure" (the worker now returns
  // 500 with a truthful error message when d1Success === false). Risk: a
  // true deterministic 500 (unhandled exception) gets retried 3 times
  // pointlessly. Acceptable — the worker's idempotency dedup collapses
  // the duplicate attempts.
  // Brief 141 dropped the navigator.onLine retry gate from
  // scheduleNextAttempt — empirical fetch failure is the authoritative
  // signal that the network is unreachable to our origin; navigator.onLine
  // is unreliable on Windows when any interface is "up" (VPN, sleeping
  // Ethernet, virtual adapter). The amber offline banner still uses it
  // as a visual hint, but the retry loop trusts the fetch result. Brief
  // 141 also lengthened the backoff to 2s/5s/15s with +/-20% jitter
  // (computeBackoffDelay below) to give flaky networks more time to
  // recover before the bounded retry exhausts; total elapsed across
  // 3 attempts is ~7s vs Brief 138's ~3s.
  var RETRYABLE_STATUS = { 408: true, 500: true, 502: true, 503: true, 504: true };
  function isRetryableStatus(n) { return RETRYABLE_STATUS[n] === true; }
  function computeBackoffDelay(attempt) {
    // attempt is 1-indexed; this is the delay BEFORE the next attempt
    // (called from scheduleNextAttempt after attempt N fails, before
    // attempt N+1 starts). Schedule: 2s, 5s, 15s. +/-20% jitter so
    // concurrent submits from multiple devices don't synchronize.
    var BACKOFF_SCHEDULE_MS = [2000, 5000, 15000];
    var idx = Math.min(attempt - 1, BACKOFF_SCHEDULE_MS.length - 1);
    var base = BACKOFF_SCHEDULE_MS[idx];
    var jitter = base * 0.2 * (Math.random() * 2 - 1);
    return Math.max(500, Math.round(base + jitter));
  }
  function submitWithRetry(jsonBody, maxAttempts) {
    var attempt = 0;
    return new Promise(function (resolve, reject) {
      function tryOnce() {
        attempt += 1;
        setSubmitting(true, attempt);
        var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        var timer = setTimeout(function () {
          if (controller) controller.abort();
        }, 30000);
        var fetchOpts = {
          method: 'POST',
          body: JSON.stringify(jsonBody),
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json'
          }
        };
        if (controller) fetchOpts.signal = controller.signal;
        fetch('/claims-api/submit-claim', fetchOpts).then(function (r) {
          return r.text().then(function (text) {
            var body = null;
            try { body = JSON.parse(text); } catch (_) { body = null; }
            return { status: r.status, ok: r.ok, body: body, raw: text };
          });
        }).then(function (out) {
          clearTimeout(timer);
          if (out.ok) { resolve(out); return; }
          if (isRetryableStatus(out.status) && attempt < maxAttempts) {
            scheduleNextAttempt();
            return;
          }
          resolve(out); // non-retryable — let caller surface the error
        }).catch(function (err) {
          clearTimeout(timer);
          if (attempt < maxAttempts) {
            scheduleNextAttempt();
            return;
          }
          reject(err);
        });
      }
      function scheduleNextAttempt() {
        var delay = computeBackoffDelay(attempt);
        setTimeout(tryOnce, delay);
      }
      tryOnce();
    });
  }

  // ---- Brief 141 Phase 3 — post-exhaustion watchdog ---------------------
  //
  // After submitWithRetry's bounded loop exhausts (3 attempts, ~7s total),
  // we don't give up entirely — we attach a long-lived listener that fires
  // one-shot retry attempts as connectivity recovers. Two triggers:
  // (a) browser fires an 'online' event (reliable in the offline->online
  // direction even when navigator.onLine was wrong about being offline);
  // (b) a periodic 60s timer fires, up to 30 attempts (30 minutes max),
  // catching cases where the browser never sees an offline transition but
  // the network is actually broken-then-restored.
  //
  // submitOnceForWatchdog is a one-shot fetch (no retry, no backoff) so a
  // 30-minute watchdog window doesn't spawn nested retry loops. Worker
  // dedup via idempotency_key (Brief 138) collapses any repeats.
  //
  // activeWatchdogTeardown is a closure var set by startWatchdog; the
  // submit handler tears it down before running a fresh manual submit.
  var activeWatchdogTeardown = null;
  function submitOnceForWatchdog(jsonBody) {
    var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timer = setTimeout(function () {
      if (controller) controller.abort();
    }, 30000);
    var fetchOpts = {
      method: 'POST',
      body: JSON.stringify(jsonBody),
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      }
    };
    if (controller) fetchOpts.signal = controller.signal;
    return fetch('/claims-api/submit-claim', fetchOpts).then(function (r) {
      return r.text().then(function (text) {
        var body = null;
        try { body = JSON.parse(text); } catch (_) { body = null; }
        return { status: r.status, ok: r.ok, body: body, raw: text };
      });
    }).then(function (out) {
      clearTimeout(timer);
      return out;
    }, function (err) {
      clearTimeout(timer);
      throw err;
    });
  }
  function startWatchdog(jsonBody) {
    var WATCHDOG_INTERVAL_MS = 60000;
    var WATCHDOG_MAX_ATTEMPTS = 30;
    var watchdogAttempts = 0;
    var watchdogTimer = null;
    var displayTimer = null;
    var lastAttemptStartMs = Date.now();
    var armed = true;

    function updateBannerCopy() {
      if (!armed || !submitError) return;
      var elapsedSec = Math.max(0, Math.round((Date.now() - lastAttemptStartMs) / 1000));
      submitError.textContent =
        "Network unstable — we'll keep trying every minute. You can also click Submit manually. (Last attempt: "
        + elapsedSec + 's ago)';
      submitError.hidden = false;
    }
    function fireWatchdogAttempt() {
      if (!armed) return;
      watchdogAttempts += 1;
      if (watchdogAttempts > WATCHDOG_MAX_ATTEMPTS) {
        if (submitError) {
          submitError.textContent =
            "Network unstable — please click Submit to retry manually.";
          submitError.hidden = false;
        }
        teardown();
        return;
      }
      lastAttemptStartMs = Date.now();
      updateBannerCopy();
      submitOnceForWatchdog(jsonBody).then(function (out) {
        if (!armed) return;
        if (out.ok && out.body && out.body.ok && out.body.d1Success !== false) {
          showOutcome(
            out.body.claim_id || out.body.claimId || '',
            out.body.summary_pdf_url || ''
          );
          clearDraft();
          submissionId = generateSubmissionId();
          teardown();
        }
        // Non-success — wait for next tick or online event. Banner stays.
      }).catch(function () {
        // Same — wait for next tick.
      });
    }
    function teardown() {
      armed = false;
      if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
      if (displayTimer) { clearInterval(displayTimer); displayTimer = null; }
      window.removeEventListener('online', fireWatchdogAttempt);
      if (activeWatchdogTeardown === teardown) activeWatchdogTeardown = null;
    }

    window.addEventListener('online', fireWatchdogAttempt);
    watchdogTimer = setInterval(fireWatchdogAttempt, WATCHDOG_INTERVAL_MS);
    displayTimer = setInterval(updateBannerCopy, 1000);
    updateBannerCopy();
    activeWatchdogTeardown = teardown;
    return teardown;
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
    // Brief 152: defense-in-depth re-check on the email regex at final
    // submit time. The Continue-button gate already runs the same check
    // before revealing the staff section, but a programmatic / a11y path
    // that bypasses Continue would otherwise reach here unchecked.
    var emailField = document.getElementById('customerEmail');
    if (emailField && !validateCustomerEmail(emailField)) {
      showError('Please enter a valid email address.');
      if (typeof emailField.focus === 'function') emailField.focus();
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
    // Brief 141 — tear down any watchdog left running from a prior failed
    // submit before starting a fresh attempt. The new attempt's success
    // or exhaustion either way ends the watchdog cycle. Idempotency key
    // is reused across both, so even a race where the watchdog's in-flight
    // fetch lands alongside the new submit collapses at the worker.
    if (typeof activeWatchdogTeardown === 'function') {
      try { activeWatchdogTeardown(); } catch (_) {}
    }
    // Brief 138 reversed Brief 136/122's optimistic-clear (option B) in favor
    // of a post-success clear (option A). clearDraft() now fires inside the
    // success branch below, after showOutcome(...) paints. Rationale: a
    // network/server failure (including the Phase 4 retry exhaustion path)
    // leaves the draft intact on the customer's device, so a page reload /
    // tab crash before manual retry preserves the typed fields — the resume
    // banner on next page load brings them back. Trade-off: customers who
    // submit successfully AND immediately navigate away before showOutcome
    // paints (extremely rare with the submitting overlay covering the page)
    // might see a stale resume banner on next visit. The inverse trade-off
    // vs option B — the failure-preserves-draft case is the high-value one.

    // Brief 146 — submit body is JSON-only. Field values flow through the
    // existing FormData → object conversion (one path for both the wire
    // shape and the autosave draft) and photo_refs carries the r2_keys
    // collected by uploadOne. No File bytes ride along — the bytes are
    // already in R2 from the OOB upload pass.
    var fd = new FormData(form);
    fd.delete('__equipmentRelated');
    var checked = document.querySelector('input[name="__equipmentRelated"]:checked');
    if (!checked || checked.value === 'no') {
      fd.set('equipmentInvolved', '');
    }
    var jsonBody = {};
    fd.forEach(function (value, key) {
      // Skip File parts (none expected — photo inputs use [hidden]) and
      // dedupe to last-write-wins for keys with multiple entries.
      if (typeof value === 'string') {
        jsonBody[key] = value;
      }
    });
    jsonBody['idempotency_key'] = submissionId;
    var refsPayload = {};
    FIELDS.forEach(function (field) {
      refsPayload[field] = photoRefs[field]
        .filter(function (e) { return e && e.r2_key; })
        .map(function (e) {
          return { r2_key: e.r2_key, original_filename: e.original_filename || '' };
        });
    });
    jsonBody['photo_refs'] = refsPayload;

    setSubmitting(true);
    submitWithRetry(jsonBody, 3).then(function (out) {
      // Brief 140 — d1Success !== false guard. The worker returns 500
      // when D1 fails (Brief 140 Phase 2); on the rare path where the
      // worker returns 200 with d1Success: false (older worker version
      // or a future regression), the explicit-false check still blocks
      // the success card from painting. Permissive on missing/undefined
      // so older workers that don't ship d1Success still succeed.
      if (out.ok && out.body && out.body.ok && out.body.d1Success !== false) {
        showOutcome(
          out.body.claim_id || out.body.claimId || '',
          out.body.summary_pdf_url || ''
        );
        // Brief 138 Phase 1 — clear the draft only after the success card
        // paints. A failed submit (including retry exhaustion) leaves the
        // draft intact for resume-on-next-page-load.
        clearDraft();
        // Brief 138 Phase 3 — defensive regen for any future code that
        // re-shows the form after a successful submit. Today the outcome
        // card terminally replaces the form, so this is belt-and-suspenders.
        submissionId = generateSubmissionId();
      } else {
        var errMsg = (out.body && out.body.error)
          || (out.body && out.body.message)
          || ('Submission failed (status ' + out.status + ').');
        setSubmitting(false);
        // Brief 141 — only watchdog on retryable-exhausted (transient).
        // A deterministic 4xx (e.g., 400 validation) gets the standard
        // error banner with "Please retry" copy; the customer must act.
        // isRetryableStatus(out.status) === true means submitWithRetry
        // burned through all 3 attempts on a transient 5xx/408 — kick
        // off the watchdog and let it overwrite the banner.
        if (isRetryableStatus(out.status)) {
          startWatchdog(jsonBody);
        } else {
          showError(errMsg + ' Please retry.');
        }
      }
    }).catch(function (_err) {
      setSubmitting(false);
      // Brief 141 — fetch reject after retry exhaustion is the canonical
      // "network is down" signal. Start the watchdog; it overwrites the
      // banner with the post-exhaustion copy + last-attempt timer.
      // showError is intentionally NOT called here — the watchdog's
      // updateBannerCopy paints the banner immediately on start.
      startWatchdog(jsonBody);
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
