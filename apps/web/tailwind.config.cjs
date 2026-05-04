// Tailwind config for apps/web. Extends the shared base from @splash/config.
// Brand-color values in tailwind.base.cjs are placeholders today and will be
// replaced with real Splash brand tokens during Step 5 (extracted from the
// inline <style> blocks in legacy/*.js).

const base = require("@splash/config/tailwind.base.cjs");

/** @type {import('tailwindcss').Config} */
module.exports = {
  ...base,
  content: [
    "./app/**/*.{ts,tsx,js,jsx,mdx}",
    "./components/**/*.{ts,tsx,js,jsx,mdx}",
    // Pull in shared @splash/ui components once the package is populated.
    "../../packages/ui/src/**/*.{ts,tsx,js,jsx}"
  ]
};
