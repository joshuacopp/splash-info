// Controlled phone input with auto-format `(XXX)XXX-XXXX` (no space after
// closing paren — matches legacy/signupworker.js:2709-2721).
//
// Caller pattern (controlled):
//   const [phone, setPhone] = useState("");
//   <PhoneInput value={phone} onChange={setPhone} />
//
// `value` and `onChange` carry the FORMATTED string. Use digitsOnly() to
// strip back to the 10-digit storage form when posting to the API.

import { useCallback, type ChangeEvent, type CSSProperties, type FocusEvent } from "react";
import { SPLASH_COLORS, SPLASH_RADII } from "./tokens";

/**
 * Format a digit run as `(XXX)XXX-XXXX`. Caps at 10 digits; partial inputs
 * format progressively as digits are typed. Returns "" for empty input.
 */
export function formatPhone(input: string): string {
  let digits = (input ?? "").replace(/\D/g, "");
  if (digits.length > 10) digits = digits.slice(0, 10);
  if (digits.length === 0) return "";
  let out = "(" + digits.substring(0, 3);
  if (digits.length >= 4) out += ")" + digits.substring(3, 6);
  if (digits.length >= 7) out += "-" + digits.substring(6, 10);
  return out;
}

/** Strip non-digits — what the API stores in `phone`. */
export function digitsOnly(input: string): string {
  return (input ?? "").replace(/\D/g, "");
}

/** True when the input has exactly 10 digits. */
export function isValidPhone(input: string): boolean {
  return digitsOnly(input).length === 10;
}

export interface PhoneInputProps {
  /** Current formatted value, e.g. "(607)768-5674". */
  value: string;
  /** Receives the new formatted value on every keystroke. */
  onChange: (formatted: string) => void;
  /** Marks the input as visually invalid (red border). Caller decides when. */
  error?: boolean;
  id?: string;
  name?: string;
  placeholder?: string;
  required?: boolean;
  autoFocus?: boolean;
  onBlur?: (e: FocusEvent<HTMLInputElement>) => void;
  className?: string;
  style?: CSSProperties;
}

const baseStyle: CSSProperties = {
  width: "100%",
  height: 42,
  padding: "8px 14px",
  fontSize: "0.9375rem",
  color: SPLASH_COLORS.navy,
  background: SPLASH_COLORS.white,
  border: `1.5px solid ${SPLASH_COLORS.grayLight}`,
  borderRadius: SPLASH_RADII.sm,
  boxSizing: "border-box",
  outline: "none"
};

const errorStyle: CSSProperties = {
  borderColor: SPLASH_COLORS.deny,
  boxShadow: "0 0 0 3px rgba(220, 38, 38, 0.15)"
};

export function PhoneInput({
  value,
  onChange,
  error,
  id,
  name,
  placeholder = "(555)555-5555",
  required,
  autoFocus,
  onBlur,
  className,
  style
}: PhoneInputProps) {
  const handle = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      onChange(formatPhone(e.target.value));
    },
    [onChange]
  );

  return (
    <input
      type="tel"
      inputMode="numeric"
      autoComplete="tel-national"
      maxLength={13}
      id={id}
      name={name}
      placeholder={placeholder}
      required={required}
      autoFocus={autoFocus}
      value={value}
      onChange={handle}
      onBlur={onBlur}
      className={className}
      style={{ ...baseStyle, ...(error ? errorStyle : {}), ...(style ?? {}) }}
    />
  );
}
