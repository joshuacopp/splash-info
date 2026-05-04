// Centralized worker-URL resolution.
//
// Each NEXT_PUBLIC_*_WORKER_URL is the absolute base URL of the corresponding
// Cloudflare Worker, OR empty/unset for same-origin (post-cutover production).
// See apps/web/.env.example for the full contract.
//
// All client + server fetches use these helpers so the cutover from
// cross-origin (workers.dev) → same-origin (splashcarwashes.info) is one
// env-var flip instead of a code search.

const DASHBOARD_BASE = process.env.NEXT_PUBLIC_DASHBOARD_WORKER_URL ?? "";
const SIGNUP_BASE = process.env.NEXT_PUBLIC_SIGNUP_WORKER_URL ?? "";
const PERFORMANCE_BASE = process.env.NEXT_PUBLIC_PERFORMANCE_WORKER_URL ?? "";
const SYSADMIN_BASE = process.env.NEXT_PUBLIC_SYSADMIN_WORKER_URL ?? "";
const DAMAGE_BASE = process.env.NEXT_PUBLIC_DAMAGE_WORKER_URL ?? "";

function withPath(base: string, path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  // Empty base → relative URL (same-origin). Non-empty → absolute.
  return `${base}${normalized}`;
}

export function dashboardUrl(path: string): string {
  return withPath(DASHBOARD_BASE, path);
}
export function signupUrl(path: string): string {
  return withPath(SIGNUP_BASE, path);
}
export function performanceUrl(path: string): string {
  return withPath(PERFORMANCE_BASE, path);
}
export function sysadminUrl(path: string): string {
  return withPath(SYSADMIN_BASE, path);
}
export function damageUrl(path: string): string {
  return withPath(DAMAGE_BASE, path);
}
