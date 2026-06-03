"use client";

import {
  PASSWORD_MIN_LENGTH,
  hasNumber,
  hasSymbol,
  hasUppercase,
  isMinimumMet
} from "../_lib/password-rules";

export interface PasswordRequirementsProps {
  password: string;
}

export default function PasswordRequirements({ password }: PasswordRequirementsProps) {
  const empty = password.length === 0;
  const lengthOk = isMinimumMet(password);
  const upperOk = hasUppercase(password);
  const numberOk = hasNumber(password);
  const symbolOk = hasSymbol(password);

  const allOk = lengthOk && upperOk && numberOk && symbolOk;
  const onlyMinimum = lengthOk && !(upperOk && numberOk && symbolOk);

  if (allOk) {
    return (
      <p
        id="password-requirements"
        role="status"
        className="mt-2 text-sm font-semibold text-splash-success"
      >
        ✓ Strong password.
      </p>
    );
  }

  if (onlyMinimum) {
    return (
      <p
        id="password-requirements"
        role="status"
        className="mt-2 text-sm text-gray-dark"
      >
        ✓ Meets minimum length. Consider adding a number, an uppercase
        letter, or a symbol.
      </p>
    );
  }

  const rules: Array<{ key: string; label: string; met: boolean }> = [
    { key: "len", label: `At least ${PASSWORD_MIN_LENGTH} characters`, met: lengthOk },
    { key: "up", label: "At least one uppercase letter", met: upperOk },
    { key: "num", label: "At least one number", met: numberOk },
    { key: "sym", label: "At least one symbol", met: symbolOk }
  ];

  return (
    <ul
      id="password-requirements"
      role="status"
      aria-live="polite"
      className="mt-2 space-y-1 text-sm"
    >
      {rules.map((r) => {
        const className = r.met
          ? "text-splash-success/80 line-through transition-opacity duration-200"
          : empty
          ? "text-gray-dark/70"
          : "text-gray-dark/70";
        return (
          <li key={r.key} className={className}>
            <span aria-hidden="true" className="mr-1">·</span>
            {r.label}
          </li>
        );
      })}
    </ul>
  );
}
