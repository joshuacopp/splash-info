// Brand color + size constants — TS-side mirror of
// packages/config/tailwind.base.cjs. Use these when you need the raw values
// (e.g., for inline styles, canvas, or non-Tailwind contexts).

export const SPLASH_COLORS = {
  blue: "#2b3491",
  blueDark: "#20276e",
  navy: "#1c164e",
  sudsyBlue: "#3dbeee",
  sudsyBlueSoft: "#d6f1fb",
  cream: "#f5eedd",
  yellow: "#f1c61e",
  racecarRed: "#dc3e26",
  grayLight: "#dbdbdb",
  grayDark: "#3a3f47",
  white: "#ffffff",
  // Signup-modal accent colors
  success: "#059669",
  deny: "#dc2626",
  warn: "#f59e0b",
  monitor: "#ea580c"
} as const;

export const SPLASH_RADII = {
  sm: "6px",
  md: "10px",
  lg: "16px"
} as const;

export const SPLASH_SHADOWS = {
  card: "0 10px 30px rgba(28, 22, 78, 0.18)",
  cardHover: "0 14px 40px rgba(28, 22, 78, 0.28)",
  btn: "0 4px 12px rgba(43, 52, 145, 0.25)"
} as const;

export const BRAND_FONT_FAMILY =
  "'Asap', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

export const BRAND_BACKGROUND_GRADIENT =
  "linear-gradient(160deg, #2b3491 0%, #1c164e 100%)";
