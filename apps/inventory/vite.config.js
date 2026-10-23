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
  // ONE React in the bundle. The repo installs hoisted (node-linker=hoisted)
  // and apps/web needs React 19 at the root, so this app's React 18 lives in
  // apps/inventory/node_modules. Without dedupe, a dependency installed at the
  // root (@dnd-kit) imports the ROOT React 19 while the app renders with 18,
  // and hooks fail with "Cannot read properties of null (reading 'useContext')".
  resolve: { dedupe: ["react", "react-dom"] },
  build: {
    outDir: "dist",
    emptyOutDir: true
  }
});
