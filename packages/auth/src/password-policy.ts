// Shared password policy — the single source of truth for password strength.
//
// POLICY (Josh, 2026-08-13): 8+ characters with at least one lowercase
// letter, one uppercase letter, one digit, and one special (non-alphanumeric)
// character.
//
// This is deliberately centralized so every password-set path enforces the
// SAME rule and cannot drift:
//   • dashboard-worker  POST /api/forced-reset  (user chooses real password)
//   • @splash/auth      userCompleteForcedReset  (same path, lib layer)
//   • @splash/auth      adminResetPassword       (admin-set temp password)
//   • @splash/auth      adminCreateUser          (admin-set temp password)
//   • sysadmin-worker   reset-password / create-user handlers
//
// Client forms (apps/web) mirror the regex for UX only — the authoritative
// check is always server-side via assertValidPassword / isValidPassword.

/**
 * 8+ chars, requires lower + upper + digit + special. Anchored so it
 * validates the whole string. `[^A-Za-z0-9]` counts any non-alphanumeric
 * (incl. space) as the "special" class.
 */
export const PASSWORD_POLICY =
  /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,}$/;

export const PASSWORD_POLICY_MESSAGE =
  "Password must be at least 8 characters and include an uppercase letter, a lowercase letter, a number, and a special character.";

/** Non-throwing check. Returns true when `pw` satisfies the policy. */
export function isValidPassword(pw: string | null | undefined): boolean {
  return typeof pw === "string" && PASSWORD_POLICY.test(pw);
}

/**
 * Throwing check for library call sites that surface the error to the caller.
 * Throws Error(PASSWORD_POLICY_MESSAGE) when the password is non-compliant.
 */
export function assertValidPassword(pw: string | null | undefined): void {
  if (!isValidPassword(pw)) {
    throw new Error(PASSWORD_POLICY_MESSAGE);
  }
}
