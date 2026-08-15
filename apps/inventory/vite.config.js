import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The SPA is served by the worker (worker/index.ts) via Cloudflare Static
// Assets. Browser URLs live under splashcarwashes.info/inventory/*, so `base`
// is /inventory/ — that makes Vite emit asset URLs like
// /inventory/assets/index-xxxx.js and sets the <script>/<link> hrefs
// accordingly. The worker strips the /inventory prefix before handing the
// request to env.ASSETS.fetch(), so the asset store itself is laid out at the
// root of dist/ (index.html at dist/index.html, assets at dist/assets/*).
export default defineConfig({
  base: "/inventory/",
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true
  }
});
