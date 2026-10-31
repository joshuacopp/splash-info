// Shared guard for post-auth redirect targets (?return= on /login, ?next= on
// /change-password and /mfa/enroll). Every page that navigates to a
// query-supplied target after sign-in MUST pass it through here: the forms
// call window.location.assign(target), so an unchecked value is both an open
// redirect (https://evil) and script execution (javascript:...) on this origin.

/**
 * Same-origin path allowlist — mirrors dashboard-worker's sanitizeRedirect
 * (REDIRECT_ALLOWED_PREFIXES) to keep client + server in sync.
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

export function sanitizeReturn(raw: string | undefined, fallback = "/admin/dashboard"): string {
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
