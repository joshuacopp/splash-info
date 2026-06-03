// Canonical email validation for the Splash MaxPass monorepo.
//
// Brief 152 introduced this module to close the bug class where the loose
// `[^@\s]+@[^@\s]+\.[^@\s]+` pattern lets RFC-invalid local-part shapes
// (trailing dot, leading dot, consecutive dots) reach Supabase, then
// Power Automate / Exchange Online rejects the recipient at send time.
// Symptom: ErrorInvalidRecipients (400) on `name.@domain.com`-shaped
// addresses, ~22 PA send-failures across two days on the maxpass signup
// confirmation-email flow.
//
// Any customer-facing email input (signup, damage claim, fleet inquiry,
// custom forms) MUST use this helper at both client-side validation AND
// server-side submit. The exported regex source is also embedded into the
// inline `<script>` tags of worker-rendered HTML forms — see EMAIL_REGEX_SOURCE
// below.

/**
 * Pragmatic email validation. Rejects the RFC-invalid shapes the loose
 * `[^@]+@[^@]+\.[^@]+` regex lets through:
 *   - leading dot in local-part: ".name@domain.com"
 *   - trailing dot in local-part: "name.@domain.com"
 *   - consecutive dots in local-part: "na..me@domain.com"
 *   - leading/trailing dot or hyphen in domain
 *   - missing TLD or TLD shorter than 2 chars
 *
 * This is NOT a full RFC-5321 validator (that includes quoted local-parts,
 * IP-literal domains, internationalized addresses). It IS a strict-enough
 * filter for the addresses Office 365's Send Email V2 connector accepts via
 * recipient resolution, which is what's been failing.
 *
 * Sanity check (mirrored by Brief 152's Definition of done):
 *   isValidEmail("name@domain.com")        // true
 *   isValidEmail("a@b.co")                 // true  (single-char local-part)
 *   isValidEmail("first.last@domain.com")  // true
 *   isValidEmail("name+tag@domain.com")    // true
 *   isValidEmail("na_me@domain.com")       // true
 *   isValidEmail("name@sub.domain.com")    // true
 *   isValidEmail("name.@domain.com")       // false (trailing dot in local)
 *   isValidEmail(".name@domain.com")       // false (leading dot in local)
 *   isValidEmail("na..me@domain.com")      // false (consecutive dots)
 *   isValidEmail("name@.domain.com")       // false (leading dot in domain)
 *   isValidEmail("name@domain")            // false (no TLD)
 *   isValidEmail("name@domain.c")          // false (TLD < 2 chars)
 */
export function isValidEmail(s: string | null | undefined): boolean {
  if (!s) return false;
  const trimmed = String(s).trim();
  if (trimmed.length === 0 || trimmed.length > 254) return false;
  return EMAIL_REGEX.test(trimmed);
}

/**
 * The canonical regex source. Exported as a string so worker-rendered HTML
 * forms can embed it inside an inline `<script>` tag without needing to
 * serialize a function across the worker → browser boundary.
 *
 * Call sites that re-use this string inside a template literal MUST mark
 * the spot with "DO NOT EDIT — must match isValidEmail in
 * @splash/types/email-validate" so future executors don't drift.
 *
 * Structure:
 *   - Local-part first character: alphanumeric (rejects leading dot).
 *   - Local-part body: alphanumeric / `_` / `+` / `-`, OR a dot ONLY when
 *     followed by another local-part character (lookahead `(?=[A-Za-z0-9_+-])`)
 *     — this single rule simultaneously rejects trailing dots (lookahead
 *     fails when next char is `@`) and consecutive dots (lookahead fails
 *     when next char is `.`).
 *   - Local-part allows zero body characters, so single-character local
 *     parts like `a@b.co` validate.
 *   - Domain: one or more dot-separated labels of alphanumeric (with
 *     optional internal hyphens), followed by a TLD of 2+ alpha chars.
 */
export const EMAIL_REGEX_SOURCE =
  "^[A-Za-z0-9](?:[A-Za-z0-9_+-]|\\.(?=[A-Za-z0-9_+-]))*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\\.)+[A-Za-z]{2,}$";

export const EMAIL_REGEX = new RegExp(EMAIL_REGEX_SOURCE);
