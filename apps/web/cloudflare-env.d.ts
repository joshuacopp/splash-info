// Brief 17 — declaration-merge the 5 worker service bindings into the
// global CloudflareEnv interface declared by @opennextjs/cloudflare. The
// opennext package's cloudflare-context.d.ts already declares the base
// CloudflareEnv shape (ASSETS, IMAGES, NEXTJS_ENV, cache bindings, ...).
// We extend it here rather than redeclaring so the opennext-managed fields
// remain typed and we don't fight the upstream definition.
//
// Each binding corresponds to a `[[services]]` block in apps/web/wrangler.toml
// — keep names in sync with the `binding = "..."` field there.
//
// Fetcher is defined by @cloudflare/workers-types, transitively pulled in
// by @opennextjs/cloudflare.

/// <reference types="@cloudflare/workers-types" />

declare global {
  interface CloudflareEnv {
    DASHBOARD_WORKER: Fetcher;
    SIGNUP_WORKER: Fetcher;
    PERFORMANCE_WORKER: Fetcher;
    SYSADMIN_WORKER: Fetcher;
    DAMAGE_WORKER: Fetcher;
    WORKORDERS_WORKER: Fetcher;
    FLEET_INQUIRY_WORKER: Fetcher;
    FORMS_WORKER: Fetcher;
  }
}

export {};
