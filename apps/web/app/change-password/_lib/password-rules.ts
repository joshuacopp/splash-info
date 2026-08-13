export const PASSWORD_MIN_LENGTH = 8;

export function isMinimumMet(password: string): boolean {
  return password.length >= PASSWORD_MIN_LENGTH;
}

export function hasLowercase(password: string): boolean {
  return /[a-z]/.test(password);
}

export function hasUppercase(password: string): boolean {
  return /[A-Z]/.test(password);
}

export function hasNumber(password: string): boolean {
  return /[0-9]/.test(password);
}

export function hasSymbol(password: string): boolean {
  return /[^a-zA-Z0-9]/.test(password);
}

// Full server policy mirror: 8+ chars with lower + upper + number + symbol.
// Keep in lockstep with @splash/auth PASSWORD_POLICY — the worker re-checks
// and rejects with PASSWORD_POLICY_MESSAGE, so gating submit on this avoids
// a client-"valid" / server-reject mismatch.
export function isPolicyMet(password: string): boolean {
  return (
    isMinimumMet(password) &&
    hasLowercase(password) &&
    hasUppercase(password) &&
    hasNumber(password) &&
    hasSymbol(password)
  );
}

export const PASSWORD_POLICY_MESSAGE =
  "Password must be at least 8 characters and include an uppercase letter, a lowercase letter, a number, and a special character.";
