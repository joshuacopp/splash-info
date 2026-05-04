// Brand CSS strings for the public signup pages (raw HTML render path).
//
// =============================================================================
// SOURCE OF TRUTH NOTE
// =============================================================================
// @splash/ui has React versions of these primitives (BubbleBackground.tsx,
// PageShell.tsx, BrandHeader.tsx) — they are canonical for apps/web's
// eventual takeover of HTML rendering. The CSS below is INTENTIONALLY
// PARALLEL: it ports legacy/signupworker.js verbatim (class names,
// keyframe names, bubble count) so the cutover from legacy to the new
// worker doesn't change a single visible pixel for customers. When
// apps/web takes over rendering in a later step, this module goes away.
//
// Brand color hexes are imported from @splash/ui/tokens (single source of
// truth) so a brand-color update is a one-file edit even today.
//
// Differences vs @splash/ui versions intentional and surfaced in the
// Chunk 2 summary:
//   - bubble class:       legacy `.bubble`        — @splash/ui `.splash-bubble`
//   - keyframe name:      legacy `rise`           — @splash/ui `splash-bubble-rise`
//   - bubble count:       legacy 10               — @splash/ui 6
// =============================================================================

import { SPLASH_COLORS, BRAND_FONT_FAMILY } from "@splash/ui/tokens";

/**
 * Light-mode bubble background CSS — port of legacy/signupworker.js:1888.
 * Used by both the picker and signup-form pages. Sits behind a translucent
 * container; bubbles rise via the `rise` keyframe.
 */
export const BUBBLE_BACKGROUND_CSS = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html { overflow: hidden; height: 100%; width: 100%; position: fixed; }
  body {
    font-family: ${BRAND_FONT_FAMILY};
    background: linear-gradient(to bottom, #e0f2fe 0%, #bae6fd 100%);
    height: 100%; width: 100%; margin: 0; padding: 0;
    overflow: hidden; position: fixed;
  }
  .scroll-wrapper {
    position: fixed; top: 0; left: 0; right: 0; bottom: 0;
    overflow-y: auto; overflow-x: hidden;
    -webkit-overflow-scrolling: touch;
    padding: 20px;
    display: flex; justify-content: center; align-items: flex-start;
  }
  .bubble {
    position: absolute; bottom: -100px;
    background: radial-gradient(circle at 30% 30%, rgba(255, 255, 255, 0.8), rgba(255, 255, 255, 0.3));
    border-radius: 50%; opacity: 0.6;
    animation: rise linear infinite;
    box-shadow: inset 0 0 20px rgba(255, 255, 255, 0.5), 0 0 20px rgba(255, 255, 255, 0.3);
    pointer-events: none; z-index: 1;
  }
  .bubble::before {
    content: ''; position: absolute; top: 10%; left: 10%;
    width: 40%; height: 40%;
    background: radial-gradient(circle, rgba(255, 255, 255, 0.9), transparent);
    border-radius: 50%;
  }
  @keyframes rise {
    0%   { bottom: -100px; transform: translateX(0) scale(1); }
    50%  { transform: translateX(100px) scale(1.1); }
    100% { bottom: 110vh; transform: translateX(-100px) scale(0.8); }
  }
  .bubble:nth-child(1)  { left:  5%; width: 60px; height: 60px; animation-duration: 8s;   animation-delay: 0s; }
  .bubble:nth-child(2)  { left: 18%; width: 40px; height: 40px; animation-duration: 6s;   animation-delay: 1s; }
  .bubble:nth-child(3)  { left: 30%; width: 80px; height: 80px; animation-duration: 10s;  animation-delay: 2s; }
  .bubble:nth-child(4)  { left: 42%; width: 50px; height: 50px; animation-duration: 7s;   animation-delay: 0.5s; }
  .bubble:nth-child(5)  { left: 55%; width: 70px; height: 70px; animation-duration: 9s;   animation-delay: 1.5s; }
  .bubble:nth-child(6)  { left: 68%; width: 45px; height: 45px; animation-duration: 6.5s; animation-delay: 0.8s; }
  .bubble:nth-child(7)  { left: 80%; width: 55px; height: 55px; animation-duration: 7.5s; animation-delay: 2.5s; }
  .bubble:nth-child(8)  { left: 92%; width: 35px; height: 35px; animation-duration: 5.5s; animation-delay: 0.3s; }
  .bubble:nth-child(9)  { left: 12%; width: 65px; height: 65px; animation-duration: 8.5s; animation-delay: 1.8s; }
  .bubble:nth-child(10) { left: 75%; width: 50px; height: 50px; animation-duration: 9.5s; animation-delay: 0.6s; }
`;

/** The 10 bubble divs the page body needs — matches the :nth-child rules. */
export const BUBBLES_HTML = Array.from({ length: 10 })
  .map(() => '<div class="bubble"></div>')
  .join("\n  ");

/**
 * Picker-specific CSS — package grid, card styling, hover states.
 * Brand colors interpolated from @splash/ui/tokens.
 */
export const PICKER_CSS = `
  .container {
    max-width: 700px; width: 100%;
    background: white; border-radius: 24px;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.15);
    position: relative; z-index: 10;
    margin: auto 0;
  }
  .header {
    background: linear-gradient(135deg, ${SPLASH_COLORS.blue} 0%, ${SPLASH_COLORS.navy} 100%);
    color: white; padding: 32px 28px; text-align: center;
    border-radius: 24px 24px 0 0;
  }
  .header .logo { height: 48px; width: auto; margin-bottom: 12px; }
  .header .location-title {
    font-size: 22px; font-weight: 700; letter-spacing: -0.005em;
  }
  .content { padding: 28px; }
  .subtitle {
    color: ${SPLASH_COLORS.navy}; font-size: 16px; font-weight: 600;
    text-align: center; margin-bottom: 18px;
  }
  .grid {
    display: grid; gap: 14px;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  }
  .card {
    background: white;
    border: 2px solid ${SPLASH_COLORS.grayLight};
    border-radius: 14px;
    padding: 18px;
    cursor: pointer;
    transition: border-color 0.18s ease, transform 0.18s ease, box-shadow 0.18s ease;
  }
  .card:hover {
    border-color: ${SPLASH_COLORS.blue};
    transform: translateY(-2px);
    box-shadow: 0 8px 24px rgba(43, 52, 145, 0.18);
  }
  .card .title {
    font-size: 17px; font-weight: 700; color: ${SPLASH_COLORS.navy};
    margin-bottom: 6px;
  }
  .card .price {
    font-size: 14px; color: ${SPLASH_COLORS.grayDark}; margin-bottom: 4px;
  }
  .card .price-amount {
    color: ${SPLASH_COLORS.blue}; font-weight: 700; font-size: 18px;
  }
  .card .ongoing {
    font-size: 13px; color: ${SPLASH_COLORS.grayDark};
  }
  .hint {
    margin-top: 18px; text-align: center;
    color: ${SPLASH_COLORS.grayDark}; font-size: 13px;
  }
`;

/**
 * Form-specific CSS — phone input, email input, terms display, submit
 * button. Brand colors via @splash/ui/tokens.
 */
export const FORM_CSS = `
  .container {
    max-width: 480px; width: 100%;
    background: white; border-radius: 24px;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.15);
    position: relative; z-index: 10;
    margin: auto 0;
  }
  .header {
    background: linear-gradient(135deg, ${SPLASH_COLORS.blue} 0%, ${SPLASH_COLORS.navy} 100%);
    color: white; padding: 28px 24px; text-align: center;
    border-radius: 24px 24px 0 0;
  }
  .header .logo { height: 44px; width: auto; margin-bottom: 12px; }
  .header h1 { font-size: 20px; font-weight: 700; }
  .package-info {
    padding: 22px 24px;
    background: ${SPLASH_COLORS.sudsyBlueSoft};
    text-align: center;
  }
  .package-name {
    font-size: 18px; font-weight: 700; color: ${SPLASH_COLORS.navy};
  }
  .pricing { font-size: 14px; color: ${SPLASH_COLORS.grayDark}; margin-top: 6px; }
  .pricing .amount { color: ${SPLASH_COLORS.blue}; font-weight: 700; }
  form { padding: 24px; }
  .field { margin-bottom: 14px; }
  .field label {
    display: block; font-size: 13px; font-weight: 600;
    color: ${SPLASH_COLORS.navy}; margin-bottom: 6px;
  }
  .field input {
    width: 100%; height: 44px; padding: 8px 12px;
    border: 1.5px solid ${SPLASH_COLORS.grayLight};
    border-radius: 8px; font-size: 16px;
    font-family: ${BRAND_FONT_FAMILY};
    color: ${SPLASH_COLORS.navy};
    transition: border-color 0.15s ease;
  }
  .field input:focus {
    outline: none; border-color: ${SPLASH_COLORS.blue};
    box-shadow: 0 0 0 3px rgba(43, 52, 145, 0.15);
  }
  .field input.error { border-color: ${SPLASH_COLORS.deny}; }
  .field-error {
    display: none; color: ${SPLASH_COLORS.deny};
    font-size: 12px; margin-top: 4px;
  }
  .field-error.show { display: block; }
  .terms {
    background: #f9fafb; border-radius: 8px;
    padding: 12px 14px; margin-bottom: 16px;
    max-height: 180px; overflow-y: auto;
    font-size: 12px; line-height: 1.5; color: ${SPLASH_COLORS.grayDark};
  }
  .terms-text { white-space: pre-wrap; }
  .agree-row {
    display: flex; align-items: flex-start; gap: 10px;
    margin-bottom: 18px; cursor: pointer;
  }
  .agree-row input[type="checkbox"] {
    width: 18px; height: 18px; flex-shrink: 0; margin-top: 2px;
    accent-color: ${SPLASH_COLORS.blue};
  }
  .agree-row span {
    font-size: 13px; color: ${SPLASH_COLORS.navy};
  }
  .submit-btn {
    width: 100%; height: 50px;
    border: none; border-radius: 10px;
    font-size: 16px; font-weight: 700;
    color: white; cursor: pointer;
    background: linear-gradient(135deg, ${SPLASH_COLORS.navy} 0%, ${SPLASH_COLORS.blue} 100%);
    transition: transform 0.1s ease, box-shadow 0.18s ease;
  }
  .submit-btn:hover:not(:disabled) {
    box-shadow: 0 8px 20px rgba(43, 52, 145, 0.3);
    transform: translateY(-1px);
  }
  .submit-btn:disabled {
    background: ${SPLASH_COLORS.grayLight};
    color: ${SPLASH_COLORS.grayDark};
    cursor: not-allowed;
  }
`;
