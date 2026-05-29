// Brief 145 — request-origin-based admin URL helper.
//
// Resolve the apps/web origin for building admin links inside outbound
// webhook payloads (Brief 32 customer email, Brief 42/43 MaintainX WO
// description, Brief 101 manage-page note/transition notification,
// Brief 102 internal new-claim notification). Operators click these
// links from email — workers.dev origins MUST get rewritten to
// production because workers.dev does not host the apps/web admin UI.
// staging.splashcarwashes.info passes through so staging-test claims
// link to staging apps/web (where the D1 row actually exists).
//
// Mirrors apps/forms-worker/src/submit/webhook.ts `inferAdminBase`,
// widened slightly to take the inbound Request directly (rather than
// pre-extracted origin string) so callers don't all have to repeat
// the URL parse.

interface AppsWebBaseEnv {
  APPS_WEB_BASE_URL?: string;
}

/**
 * Resolve the apps/web origin for building admin links inside
 * outbound webhook payloads. Operators click these from email, so
 * workers.dev origins MUST get rewritten to production. The staging
 * hostname is preserved so staging-test claims link to staging
 * apps/web (where the claim row actually exists).
 *
 * Pass `null` (e.g., from the scheduled handler that has no inbound
 * request) to fall straight through to env.APPS_WEB_BASE_URL.
 */
export function resolveAdminBase(
  request: Request | null,
  env: AppsWebBaseEnv
): string {
  if (request) {
    try {
      const url = new URL(request.url);
      // workers.dev → production fallback. workers.dev does not host
      // the apps/web admin UI; an email link there is a dead end.
      if (url.hostname.endsWith(".workers.dev")) {
        return env.APPS_WEB_BASE_URL ?? "https://splashcarwashes.info";
      }
      // splashcarwashes.info AND staging.splashcarwashes.info pass through.
      if (url.hostname.endsWith("splashcarwashes.info")) {
        return `${url.protocol}//${url.hostname}`;
      }
    } catch {
      // fall through to env fallback
    }
  }
  return env.APPS_WEB_BASE_URL ?? "https://splashcarwashes.info";
}
