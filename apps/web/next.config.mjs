// Next.js config for apps/web. Deployed to Cloudflare Workers via
// @opennextjs/cloudflare (the supported successor to @cloudflare/next-on-pages).
//
// Build-time env vars consumed implicitly by Next during `next build`:
//   - NEXT_SERVER_ACTIONS_ENCRYPTION_KEY (Brief 31) — stable key that
//     deterministically hashes server-action IDs. Without it, IDs
//     regenerate every build, so redeploys white-page any open tab on
//     form submit (UnrecognizedActionError). Set as a CF Workers Builds
//     BUILD-TIME env var on splash-web; documented in apps/web/.env.example.
//     Don't rotate without coordination.

import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

initOpenNextCloudflareForDev();

// Dev rewrite map. Keep in sync with the NEXT_PUBLIC_*_WORKER_URL names in
// apps/web/.env.example. When set in .env.local, these env vars cause
// localhost dev to transparently proxy worker API paths to the workers.dev
// URLs - which means the browser sees everything as localhost:3001 origin
// and cookies (login, /api/me, etc.) work natively for end-to-end UI testing
// without the cross-origin SameSite=Lax wall.
//
// In production (post-cutover) the env vars are unset / empty and these
// rewrites no-op, since apps/web and the workers all share splashcarwashes.info
// and Cloudflare's edge handles the per-path routing via wrangler.toml routes.
const REWRITE_TARGETS = [
  // dashboard-worker: SSO + /api/me
  { source: "/api/login",        envVar: "NEXT_PUBLIC_DASHBOARD_WORKER_URL" },
  { source: "/api/login/mfa",    envVar: "NEXT_PUBLIC_DASHBOARD_WORKER_URL" },
  { source: "/api/logout",       envVar: "NEXT_PUBLIC_DASHBOARD_WORKER_URL" },
  { source: "/api/forced-reset", envVar: "NEXT_PUBLIC_DASHBOARD_WORKER_URL" },
  { source: "/api/me",           envVar: "NEXT_PUBLIC_DASHBOARD_WORKER_URL" },
  { source: "/api/mfa/:path*",   envVar: "NEXT_PUBLIC_DASHBOARD_WORKER_URL" },
  { source: "/api/refresh",      envVar: "NEXT_PUBLIC_DASHBOARD_WORKER_URL" },

  // signup-worker: customer signup + /admin/api/* pricing JSON
  { source: "/admin/api/:path*",       envVar: "NEXT_PUBLIC_SIGNUP_WORKER_URL" },
  { source: "/api/submit-signup",      envVar: "NEXT_PUBLIC_SIGNUP_WORKER_URL" },
  // /signup/*, /q/*, /join/* customer routes stay on signup-worker per
  // decision 8 (signup-worker owns customer rendering); apps/web doesn't
  // proxy those.

  // damage-worker: claims manager + /claims-api/* photo serving
  { source: "/manage/api/:path*",  envVar: "NEXT_PUBLIC_DAMAGE_WORKER_URL" },
  { source: "/claims-api/:path*",  envVar: "NEXT_PUBLIC_DAMAGE_WORKER_URL" },

  // performance-worker
  { source: "/pertrack/:path*", envVar: "NEXT_PUBLIC_PERFORMANCE_WORKER_URL" },

  // sysadmin-worker
  { source: "/sysadmin/api/:path*", envVar: "NEXT_PUBLIC_SYSADMIN_WORKER_URL" },

  // workorders-worker (Brief 70)
  { source: "/workorders/api/:path*", envVar: "NEXT_PUBLIC_WORKORDERS_WORKER_URL" }
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Workspace packages we author in this monorepo. Next.js needs to transpile
  // their TS sources because they ship as .ts files (no prebuild step).
  transpilePackages: ["@splash/storage-r2", "@splash/types", "@splash/ui"],
  reactStrictMode: true,

  // Server actions default body limit is 1 MB. Promo material uploads
  // (Brief 156) and any future multipart server-action surfaces (claims,
  // forms) need significantly more headroom. Promo cap is 50 MB on the
  // worker side; this matches with a little overhead for the multipart
  // boundary and other form fields.
  experimental: {
    serverActions: {
      bodySizeLimit: "55mb"
    }
  },

  async rewrites() {
    // Build the rewrite list. Skip entries whose env var isn't set (production
    // same-origin won't have NEXT_PUBLIC_*_WORKER_URL set, so the rewrites
    // collapse to an empty array and Next.js routes natively).
    const rewrites = [];
    for (const entry of REWRITE_TARGETS) {
      const base = process.env[entry.envVar];
      if (!base) continue;
      rewrites.push({
        source: entry.source,
        destination: `${base}${entry.source.replace(":path*", ":path*")}`
      });
    }
    return rewrites;
  }
};

export default nextConfig;
