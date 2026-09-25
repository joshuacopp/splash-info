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

import { cookies, headers } from "next/headers";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { LoginForm } from "./form";

// Force dynamic rendering so the TURNSTILE_SITE_KEY read below runs at REQUEST
// time against the deployed worker's env — not at build time, where
// getCloudflareContext has no bindings and the key would resolve undefined
// (baking a widget-less page into the static output). Every other server
// component in apps/web that reads runtime env via getCloudflareContext
// declares this same flag; /login was the lone exception and it regressed the
// Turnstile widget in production. `await searchParams` alone did not reliably
// opt the route out of prerendering under OpenNext.
export const dynamic = "force-dynamic";

/** Mirrors middleware.ts. Duplicated rather than imported because @splash/auth
 *  is not safe to pull into this path (Edge-runtime constraint documented in
 *  CLAUDE.md), and one string is a smaller liability than that import. */
const ACCESS_TOKEN_COOKIE = "sb-access-token";

interface PageProps {
  searchParams: Promise<{ return?: string }>;
}

export default async function LoginPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const returnPath = sanitizeReturn(params.return);
  const turnstileSiteKey = await readTurnstileSiteKey();
  // A caller arriving here may not be logged out at all -- they may be half way
  // through an MFA login. /api/login sets aal1 cookies BEFORE the code prompt,
  // so leaving that prompt keeps a valid session that every gated page refuses,
  // which sends them back here, where the password step succeeds and sets
  // another aal1 cookie. That is the loop. Asking first lets us open on the
  // code step and end it.
  const needsStepUp = await readNeedsStepUp();
  return (
    <LoginForm
      returnPath={returnPath}
      turnstileSiteKey={turnstileSiteKey}
      startInMfaMode={needsStepUp}
    />
  );
}

/**
 * Ask dashboard-worker whether this request's cookie is a half-finished MFA
 * login. Service binding first, URL fallback for `next dev` (Brief 17).
 *
 * Fail-soft to false: an unanswerable question must land the caller on the
 * normal password form, which is the pre-existing behaviour. Getting this wrong
 * in the other direction would show a code prompt to someone who has no
 * session and no factor, and they would have nothing to type.
 */
async function readNeedsStepUp(): Promise<boolean> {
  const jar = await cookies();
  // Only ask when there is actually a session cookie to ask about. Testing for
  // the access token rather than "any cookie at all" keeps a first-time visitor
  // -- who arrives carrying analytics or Cloudflare cookies -- off this path
  // entirely, so the normal login render costs no extra round trip.
  if (!jar.get(ACCESS_TOKEN_COOKIE)) return false;
  const cookieHeader = jar.toString();
  try {
    const { env } = await getCloudflareContext({ async: true });
    const binding = (env as { DASHBOARD_WORKER?: { fetch: (r: Request) => Promise<Response> } })
      .DASHBOARD_WORKER;
    if (binding) {
      const res = await binding.fetch(
        new Request("https://internal/api/mfa/status", {
          headers: { Cookie: cookieHeader }
        })
      );
      return await parseNeedsStepUp(res);
    }
  } catch {
    // Not in the Workers runtime; fall through to the URL path.
  }
  try {
    const base = process.env.NEXT_PUBLIC_DASHBOARD_WORKER_URL;
    const headerStore = await headers();
    const host = headerStore.get("host") ?? "localhost:3000";
    const proto = headerStore.get("x-forwarded-proto") ?? "https";
    const url = base ? `${base}/api/mfa/status` : `${proto}://${host}/api/mfa/status`;
    const res = await fetch(url, {
      headers: { Cookie: cookieHeader },
      cache: "no-store"
    });
    return await parseNeedsStepUp(res);
  } catch {
    return false;
  }
}

async function parseNeedsStepUp(res: Response): Promise<boolean> {
  if (!res.ok) return false;
  const data = (await res.json().catch(() => null)) as { needsStepUp?: boolean } | null;
  return data?.needsStepUp === true;
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
 * (REDIRECT_ALLOWED_PREFIXES) to keep client + server in sync. Defends against
 * open-redirect attacks where an attacker links to /login?return=https://evil.com.
 *
 * This used to accept ANY same-origin path while the worker accepted only three
 * prefixes, so an off-allowlist return (e.g. /schedule) looked like it worked
 * right up until the worker quietly rewrote it to "/" and dumped the user on
 * the public homepage. Falling back to the dashboard here makes the mismatch
 * visible instead of silent. If you add a prefix, add it in BOTH places.
 */
const RETURN_ALLOWED_PREFIXES = [
  "/admin",
  "/manage",
  "/pertrack",
  "/inventory",
  "/workorders",
  "/schedule",
  "/forms"
];

function sanitizeReturn(raw: string | undefined): string {
  const fallback = "/admin/dashboard";
  if (!raw) return fallback;
  if (!raw.startsWith("/")) return fallback;
  if (raw.startsWith("//")) return fallback; // protocol-relative — reject
  for (const prefix of RETURN_ALLOWED_PREFIXES) {
    if (raw === prefix || raw.startsWith(prefix + "/") || raw.startsWith(prefix + "?")) {
      return raw;
    }
  }
  return fallback;
}
