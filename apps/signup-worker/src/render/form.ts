// Signup-form page renderer.
//
// GET /signup/{location}/{pkg}  →  renderSignupForm(...)  when SIGNATURE_MODE === "inline"
//
// Source: legacy/signupworker.js:2248 renderSignupForm. The full submit
// handler with fraud-detection modals (Deny / Warn / Monitor / Success)
// lands in Chunk 3 — for now the form POSTs to /api/submit-signup which
// returns 501. Customers don't reach this until cutover.
//
// Phone-format and email-validation client-side JS is included so the form
// behaves correctly in dev / shadow-test before fraud detection is wired.

import { ASSETS } from "@splash/storage-r2/assets";
import type { PricingSimpleResolvedRow } from "@splash/types/pricing";
import { EMAIL_REGEX_SOURCE } from "@splash/types/email-validate";
import { BUBBLE_BACKGROUND_CSS, BUBBLES_HTML, FORM_CSS } from "./css.js";
import { cap, escHtml } from "./escape.js";

export interface SignupFormRenderArgs {
  locationCode: string;
  packageCode: string;
  /** Resolved pricing row for the package — already in hand from the cache layer. */
  row: PricingSimpleResolvedRow;
  /** Generated terms text for THIS pricing snapshot — must equal what the
   *  submission handler stores in maxpass_signups.terms_text. The legacy
   *  worker generated terms inline at render time and re-read it from the
   *  hidden form field on submit; the new worker preserves that contract. */
  termsText: string;
  /** BOGO ("Buy One Get One") schedule modifier. When true, the form renders
   *  the yellow 3-step callout between .package-info and the form, and the
   *  hidden `is_bogo` / `recurring_start_date` fields carry true / the
   *  month-3 ISO date back to the submit handler. */
  isBogo: boolean;
  /** Today's date MM-DD-YYYY — shown in the BOGO callout. */
  todayStr: string;
  /** Today + 1 month MM-DD-YYYY — "second month FREE" in the BOGO callout. */
  nextBillingStr: string;
  /** Today + 2 months MM-DD-YYYY — recurring-billing-starts date in the
   *  BOGO callout. Empty string when isBogo === false. */
  month3Str: string;
  /** Today + 2 months YYYY-MM-DD — value of the hidden `recurring_start_date`
   *  input. Empty string when isBogo === false. */
  month3Iso: string;
  /** "${todayPrice} plus tax" — line 1 of the BOGO callout. */
  priceTextToday: string;
  /** "${monthlyPrice} plus tax" (or family-plan variant) — line 3 of the BOGO callout. */
  priceTextMonthly: string;
}

export function renderSignupForm({
  locationCode,
  packageCode,
  row,
  termsText,
  isBogo,
  todayStr,
  nextBillingStr,
  month3Str,
  month3Iso,
  priceTextToday,
  priceTextMonthly
}: SignupFormRenderArgs): string {
  const today = Number(row.today ?? 0).toFixed(2);
  const monthly = Number(row.ongoing ?? 0).toFixed(2);

  // Yellow 3-step BOGO callout — rendered between .package-info and the
  // form when row.bogo is true. Verbatim port of the legacy worker's
  // bogoCallout block (legacy/signup_worker_with_BOGO.js line 2225-2233).
  const bogoCallout = isBogo
    ? `<div class="bogo-callout">
        <div class="bogo-banner">BOGO — Buy One, Get One Free</div>
        <ol class="bogo-steps">
          <li><strong>Today (${escHtml(todayStr)}):</strong> ${escHtml(priceTextToday)}</li>
          <li><strong>${escHtml(nextBillingStr)}:</strong> Second month <strong>FREE</strong></li>
          <li><strong>${escHtml(month3Str)}:</strong> Recurring billing begins at ${escHtml(priceTextMonthly)}</li>
        </ol>
      </div>`
    : "";

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<link rel="icon" type="image/png" href="${ASSETS.favicon}"/>
<title>Sign Up – ${escHtml(row.pretty_pkg)} – ${escHtml(cap(locationCode))}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Asap:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
${BUBBLE_BACKGROUND_CSS}
${FORM_CSS}
</style>
</head>
<body>
  ${BUBBLES_HTML}

  <div class="scroll-wrapper">
    <div class="container">
      <div class="header">
        <img class="logo" src="${ASSETS.logoWhite}" alt="Splash Car Wash"/>
        <h1>${escHtml(cap(locationCode))} MaxPass</h1>
      </div>

      <div class="package-info">
        <div class="package-name">${escHtml(row.pretty_pkg)}</div>
        <div class="pricing">
          First month <span class="amount">$${escHtml(today)}</span>
          &nbsp;·&nbsp; Then $${escHtml(monthly)}/month
        </div>
      </div>

      ${bogoCallout}

      <form id="signupForm" novalidate>
        <input type="hidden" name="location" value="${escHtml(locationCode)}"/>
        <input type="hidden" name="location_pretty" value="${escHtml(row.location_pretty)}"/>
        <input type="hidden" name="package" value="${escHtml(packageCode)}"/>
        <input type="hidden" name="package_pretty" value="${escHtml(row.pretty_pkg)}"/>
        <input type="hidden" name="today_price" value="${escHtml(today)}"/>
        <input type="hidden" name="monthly_price" value="${escHtml(monthly)}"/>
        <input type="hidden" name="terms" id="termsInput"/>
        <input type="hidden" name="is_bogo" value="${isBogo ? "true" : "false"}"/>
        <input type="hidden" name="recurring_start_date" value="${escHtml(month3Iso)}"/>

        <div class="field">
          <label for="phone">Phone Number</label>
          <input
            type="tel" id="phone" name="phone_formatted"
            inputmode="numeric" autocomplete="tel-national"
            maxlength="13" placeholder="(555)555-5555"
            required autofocus
          />
          <div class="field-error" id="phoneError">Please enter a valid 10-digit phone number.</div>
        </div>

        <div class="field">
          <label for="email">Email Address</label>
          <input
            type="email" id="email" name="email"
            autocomplete="email" placeholder="you@example.com"
            required
          />
          <div class="field-error" id="emailError">Please enter a valid email address.</div>
        </div>

        <div class="terms">
          <div class="terms-text" id="termsDisplay"></div>
        </div>

        <label class="agree-row">
          <input type="checkbox" id="agreeTerms" name="terms_agreed" value="true"/>
          <span>I agree to the terms above.</span>
        </label>

        <button type="submit" id="submitBtn" class="submit-btn" disabled>
          Complete Sign Up
        </button>
      </form>
    </div>
  </div>

  <script>
    (function(){
      // Terms text is rendered into both the visible <div> and the hidden
      // form field — the submit handler stores the exact string the
      // customer agreed to in maxpass_signups.terms_text. Single source.
      var termsText = ${JSON.stringify(termsText)};
      document.getElementById('termsDisplay').textContent = termsText;
      document.getElementById('termsInput').value = termsText;

      var phoneInput   = document.getElementById('phone');
      var phoneError   = document.getElementById('phoneError');
      var emailInput   = document.getElementById('email');
      var emailError   = document.getElementById('emailError');
      var agree        = document.getElementById('agreeTerms');
      var submitBtn    = document.getElementById('submitBtn');
      var form         = document.getElementById('signupForm');

      // Brief 152: email regex compiled from EMAIL_REGEX_SOURCE in
      // @splash/types/email-validate so the client-side gate matches the
      // server-side isValidEmail check exactly. DO NOT EDIT inline — fix
      // the canonical source. Rejects trailing/leading/consecutive dots
      // in local-part that pass the legacy /^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.
      var EMAIL_RE = new RegExp(${JSON.stringify(EMAIL_REGEX_SOURCE)});

      // Phone auto-format: (XXX)XXX-XXXX, no space after closing paren —
      // matches the documented format used by phone_usage_log + JotForm prefill.
      phoneInput.addEventListener('input', function(e){
        var digits = e.target.value.replace(/\\D/g, '').slice(0, 10);
        var out = '';
        if (digits.length > 0) out = '(' + digits.substring(0, 3);
        if (digits.length >= 4) out += ')' + digits.substring(3, 6);
        if (digits.length >= 7) out += '-' + digits.substring(6, 10);
        e.target.value = out;
        validatePhone();
        checkValid();
      });
      phoneInput.addEventListener('blur', validatePhone);
      emailInput.addEventListener('input', function(){ validateEmail(); checkValid(); });
      emailInput.addEventListener('blur', validateEmail);
      agree.addEventListener('change', checkValid);

      function validatePhone(){
        var d = phoneInput.value.replace(/\\D/g, '');
        var ok = d.length === 10;
        phoneInput.classList.toggle('error', !!phoneInput.value && !ok);
        phoneError.classList.toggle('show', !!phoneInput.value && !ok);
        return ok;
      }
      function validateEmail(){
        var v = emailInput.value.trim();
        var ok = v.length > 0 && v.length <= 254 && EMAIL_RE.test(v);
        emailInput.classList.toggle('error', !!v && !ok);
        emailError.classList.toggle('show', !!v && !ok);
        return ok;
      }
      function checkValid(){
        submitBtn.disabled = !(validatePhone() && validateEmail() && agree.checked);
      }

      // -------------------------------------------------------------
      // Modal kit — ported from legacy/signupworker.js:2882-3030.
      // The four signup-flow modals (Deny / Warn / Monitor / Success)
      // are created on demand and removed on dismiss. Branch keys on
      // the response JSON: { denied, warning, monitor, success }.
      // -------------------------------------------------------------
      var MODAL_OVERLAY_STYLE =
        'position:fixed;inset:0;background:rgba(0,0,0,0.7);' +
        'display:flex;align-items:center;justify-content:center;' +
        'z-index:9999;padding:20px;';
      var MODAL_CARD_STYLE =
        'background:white;border-radius:16px;padding:40px 30px;' +
        'max-width:420px;width:100%;text-align:center;' +
        'box-shadow:0 20px 60px rgba(0,0,0,0.3);';
      function btnStyle(gradient){
        return 'width:100%;padding:14px 24px;font-size:16px;font-weight:700;' +
          'color:white;border:none;border-radius:10px;cursor:pointer;' +
          'box-shadow:0 4px 12px rgba(0,0,0,0.15);background:' + gradient + ';';
      }
      function makeOverlay(){
        var el = document.createElement('div');
        el.style.cssText = MODAL_OVERLAY_STYLE;
        return el;
      }
      function makeCard(){
        var el = document.createElement('div');
        el.style.cssText = MODAL_CARD_STYLE;
        return el;
      }
      function closeOverlay(overlay){ document.body.removeChild(overlay); }

      function showDenyModal(errorMessage){
        var overlay = makeOverlay();
        var card = makeCard();
        card.innerHTML =
          '<div style="font-size:80px;margin-bottom:20px;color:#dc2626;">✕</div>' +
          '<h2 style="color:#dc2626;font-size:32px;margin-bottom:15px;font-weight:bold;">Invalid Phone Number</h2>' +
          '<p style="color:#64748b;font-size:16px;margin-bottom:35px;line-height:1.5;"></p>' +
          '<button id="denyOkBtn" style="' + btnStyle('linear-gradient(135deg,#dc2626 0%,#ef4444 100%)') + '">Enter Valid Number</button>';
        // textContent on the <p> so server-supplied error strings can't inject HTML
        card.querySelector('p').textContent = errorMessage || 'Invalid phone number.';
        overlay.appendChild(card);
        document.body.appendChild(overlay);
        document.getElementById('denyOkBtn').addEventListener('click', function(){
          closeOverlay(overlay);
          phoneInput.value = '';
          phoneInput.focus();
          submitBtn.disabled = true;
          submitBtn.textContent = 'Complete Sign Up';
        });
      }

      function showWarnModal(message, originalBody){
        var overlay = makeOverlay();
        var card = makeCard();
        card.innerHTML =
          '<div style="font-size:80px;margin-bottom:20px;color:#f59e0b;">⚠</div>' +
          '<h2 style="color:#f59e0b;font-size:32px;margin-bottom:15px;font-weight:bold;">Phone Number Warning</h2>' +
          '<p style="color:#64748b;font-size:16px;margin-bottom:35px;line-height:1.5;"></p>' +
          '<div style="display:grid;gap:12px;">' +
            '<button id="confirmPhoneBtn" style="' + btnStyle('linear-gradient(135deg,#059669 0%,#10b981 100%)') + '">This is My Phone Number</button>' +
            '<button id="changePhoneBtn"  style="' + btnStyle('linear-gradient(135deg,#6b7280 0%,#9ca3af 100%)') + '">Enter New Number</button>' +
          '</div>';
        card.querySelector('p').textContent = message || 'Please verify this phone number.';
        overlay.appendChild(card);
        document.body.appendChild(overlay);
        document.getElementById('confirmPhoneBtn').addEventListener('click', function(){
          closeOverlay(overlay);
          var resubmit = Object.assign({}, originalBody, { user_confirmed: true });
          submitToServer(resubmit);
        });
        document.getElementById('changePhoneBtn').addEventListener('click', function(){
          closeOverlay(overlay);
          phoneInput.value = '';
          phoneInput.focus();
          submitBtn.disabled = true;
          submitBtn.textContent = 'Complete Sign Up';
        });
      }

      function showMonitorModal(message, originalBody){
        var overlay = makeOverlay();
        var card = makeCard();
        card.innerHTML =
          '<div style="font-size:80px;margin-bottom:20px;color:#ea580c;">🚨</div>' +
          '<h2 style="color:#ea580c;font-size:32px;margin-bottom:15px;font-weight:bold;">Number Flagged</h2>' +
          '<p style="color:#64748b;font-size:16px;margin-bottom:35px;line-height:1.5;"></p>' +
          '<div style="display:grid;gap:12px;">' +
            '<button id="monitorConfirmBtn" style="' + btnStyle('linear-gradient(135deg,#059669 0%,#10b981 100%)') + '">This is My Phone Number</button>' +
            '<button id="monitorChangeBtn"  style="' + btnStyle('linear-gradient(135deg,#ea580c 0%,#f97316 100%)') + '">Enter Different Number</button>' +
          '</div>';
        card.querySelector('p').textContent = message || 'This number has been flagged.';
        overlay.appendChild(card);
        document.body.appendChild(overlay);
        document.getElementById('monitorConfirmBtn').addEventListener('click', function(){
          closeOverlay(overlay);
          // Carry user_confirmed forward as well — Monitor tier paths can
          // re-enter the warn-tier branch on subsequent flows; both flags
          // tell the server "user has acknowledged the friction."
          var resubmit = Object.assign({}, originalBody, {
            user_confirmed: true,
            monitor_acknowledged: true
          });
          submitToServer(resubmit);
        });
        document.getElementById('monitorChangeBtn').addEventListener('click', function(){
          closeOverlay(overlay);
          phoneInput.value = '';
          phoneInput.focus();
          submitBtn.disabled = true;
          submitBtn.textContent = 'Complete Sign Up';
        });
      }

      function showSuccessModal(){
        var overlay = makeOverlay();
        var card = makeCard();
        card.innerHTML =
          '<div style="font-size:80px;margin-bottom:20px;color:#059669;">✓</div>' +
          '<h2 style="color:#059669;font-size:36px;margin-bottom:15px;font-weight:bold;">MaxPass Success!</h2>' +
          '<p style="color:#64748b;font-size:18px;margin-bottom:35px;">Signup completed successfully</p>' +
          '<button id="fillAgainBtn" style="' + btnStyle('linear-gradient(135deg,#1e3a8a 0%,#3b82f6 100%)') + '">Fill Form Again?</button>';
        overlay.appendChild(card);
        document.body.appendChild(overlay);
        document.getElementById('fillAgainBtn').addEventListener('click', function(){
          // Brief 57 (2026-05-06): redirect to the package picker so the
          // next signup can pick a different package. Previously this
          // reset the form in-place which assumed the next signup was
          // for the same package — operationally, "fill again" usually
          // means a different vehicle in the same household.
          window.location.href = '/signup/${escHtml(locationCode)}';
        });
      }

      function buildBody(){
        return {
          location: form.location.value,
          location_pretty: form.location_pretty.value,
          package: form.package.value,
          package_pretty: form.package_pretty.value,
          today_price: form.today_price.value,
          monthly_price: form.monthly_price.value,
          phone: phoneInput.value.replace(/\\D/g, ''),
          phone_formatted: phoneInput.value,
          email: emailInput.value.trim(),
          terms: termsText,
          terms_agreed: agree.checked,
          timestamp: new Date().toISOString(),
          // BOGO fields — defensive defaults so non-BOGO signups and older
          // clients (which don't post these fields) land as is_bogo=false /
          // recurring_start_date=null without breaking the insert.
          is_bogo: form.is_bogo.value === 'true',
          recurring_start_date: form.recurring_start_date.value || null
        };
      }

      // submitToServer is reused by the form's submit event AND by the
      // Warn / Monitor modal "confirm" buttons (which resubmit with
      // user_confirmed / monitor_acknowledged set).
      async function submitToServer(body){
        submitBtn.disabled = true;
        submitBtn.textContent = 'Submitting…';
        try {
          var resp = await fetch('/api/submit-signup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
          });
          var result = await resp.json().catch(function(){ return {}; });

          // Branch on response shape — see handlers/submit-signup.ts
          // contract block for the four modal JSON shapes.
          if (resp.ok && result.success) { showSuccessModal(); return; }
          if (result.denied)              { showDenyModal(result.error); return; }
          if (result.warning)             { showWarnModal(result.message, body); return; }
          if (result.monitor)             { showMonitorModal(result.message, body); return; }

          // Unrecognized response — generic alert + recoverable.
          alert(result.error || result.message || ('Submission failed (' + resp.status + ').'));
          submitBtn.disabled = false;
          submitBtn.textContent = 'Complete Sign Up';
        } catch (err) {
          alert('Network error. Please check your connection and try again.');
          submitBtn.disabled = false;
          submitBtn.textContent = 'Complete Sign Up';
        }
      }

      form.addEventListener('submit', function(e){
        e.preventDefault();
        if (submitBtn.disabled) return;
        submitToServer(buildBody());
      });
    })();
  </script>
</body>
</html>`;
}
