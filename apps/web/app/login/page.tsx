// /login — apps/web entry point for obtaining an sb-access-token cookie.
//
// Server component reads the optional `?return=<path>` query param and hands
// it to the client form. Form posts to dashboard-worker's POST /api/login,
// which on success returns 302 with Set-Cookie + Location pointing at the
// safeNext target. On 401 (bad creds) or 403 (no permissions) the form
// stays in place and shows an inline error.
//
// `?return` flow: middleware injects this when redirecting an unauthenticated
// user away from a gated page (e.g. /admin/pricing → /login?return=/admin/pricing).
// On successful login the form sends `redirect=<return>` to the worker, which
// sanitizes it and 302s back. If the user has must_change_password, the
// worker overrides Location to /change-password?required=true&next=<return>
// — the form detects that path in the response and routes to apps/web's
// /change-password page.

import { getCloudflareContext } from "@opennextjs/cloudflare";
import { LoginForm } from "./form";

interface PageProps {
  searchParams: Promise<{ return?: string }>;
}

export default async function LoginPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const returnPath = sanitizeReturn(params.return);
  const turnstileSiteKey = await readTurnstileSiteKey();
  return <LoginForm returnPath={returnPath} turnstileSiteKey={turnstileSiteKey} />;
}

/**
 * Public Turnstile site key, read at RUNTIME from the worker's env — the same
 * "Variables and secrets" panel the sibling workers use. Set it as a plain
 * Text var named TURNSTILE_SITE_KEY, mirroring fleet-inquiry-worker.
 *
 * Read via getCloudflareContext rather than process.env.NEXT_PUBLIC_* so the
 * value comes from the deployed worker's bindings, not build-time inlining —
 * consistent with how every other runtime value in apps/web is read, and it
 * lets the key rotate without a rebuild.
 *
 * Fail-soft: when unset (local dev, or getCloudflareContext unavailable
 * outside the worker runtime) the form renders no widget and login works
 * unguarded — mirrors the dashboard-worker's posture when TURNSTILE_SECRET_KEY
 * is unbound.
 */
async function readTurnstileSiteKey(): Promise<string | undefined> {
  try {
    const { env } = await getCloudflareContext({ async: true });
    return (env as { TURNSTILE_SITE_KEY?: string }).TURNSTILE_SITE_KEY;
  } catch {
    return undefined;
  }
}

/**
 * Same-origin path allowlist — mirrors dashboard-worker's sanitizeRedirect
 * to keep client + server in sync. Defends against open-redirect attacks
 * where an attacker links to /login?return=https://evil.com.
 */
function sanitizeReturn(raw: string | undefined): string {
  if (!raw) return "/admin/dashboard";
  if (!raw.startsWith("/")) return "/admin/dashboard";
  if (raw.startsWith("//")) return "/admin/dashboard"; // protocol-relative — reject
  return raw;
}
