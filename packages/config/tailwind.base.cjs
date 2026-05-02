// Shared Tailwind base for the Next.js app and the @splash/ui package.
// Splash brand tokens (gradients, blue, success/deny/warn/monitor colors)
// will be added here after we extract them from the existing worker files.
module.exports = {
  theme: {
    extend: {
      colors: {
        // Placeholders — will be replaced in Step 5 with actual Splash brand values
        "splash-blue": "#1e40af",
        "splash-success": "#047857",
        "splash-deny": "#dc2626",
        "splash-warn": "#f59e0b",
        "splash-monitor": "#ea580c"
      }
    }
  },
  plugins: []
};
