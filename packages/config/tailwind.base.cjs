// Shared Tailwind base for the Next.js app and the @splash/ui package.
// Brand tokens extracted verbatim from the inline <style> blocks in
// legacy/dashboard.js:200-227 (the canonical token set — performancetracker.js
// and signupworker.js use the same hex values).

module.exports = {
  theme: {
    extend: {
      colors: {
        // Splash brand palette
        "splash-blue": "#2b3491",
        "splash-blue-dark": "#20276e",
        "splash-navy": "#1c164e",
        "sudsy-blue": "#3dbeee",
        "sudsy-blue-soft": "#d6f1fb",
        cream: "#f5eedd",
        yellow: "#f1c61e",
        "racecar-red": "#dc3e26",
        "gray-light": "#dbdbdb",
        "gray-dark": "#3a3f47",

        // Signup-modal palette (legacy/signupworker.js inline tokens)
        "splash-success": "#059669",
        "splash-deny": "#dc2626",
        "splash-warn": "#f59e0b",
        "splash-monitor": "#ea580c"
      },
      fontFamily: {
        // Brand body font — Google Fonts Asap, weights 400/500/600/700/800.
        // Consumers must include the link tag (or use @splash/ui's
        // <BrandFontLinks /> in Next.js head).
        splash: ['"Asap"', "system-ui", "-apple-system", '"Segoe UI"', "Roboto", "sans-serif"]
      },
      boxShadow: {
        "splash-card": "0 10px 30px rgba(28, 22, 78, 0.18)",
        "splash-card-hover": "0 14px 40px rgba(28, 22, 78, 0.28)",
        "splash-btn": "0 4px 12px rgba(43, 52, 145, 0.25)"
      },
      borderRadius: {
        "splash-sm": "6px",
        "splash-md": "10px",
        "splash-lg": "16px"
      }
    }
  },
  plugins: []
};
