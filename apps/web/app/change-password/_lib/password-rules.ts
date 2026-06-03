export const PASSWORD_MIN_LENGTH = 8;

export function isMinimumMet(password: string): boolean {
  return password.length >= PASSWORD_MIN_LENGTH;
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
