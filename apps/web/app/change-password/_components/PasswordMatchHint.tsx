"use client";

export interface PasswordMatchHintProps {
  password: string;
  confirm: string;
}

export default function PasswordMatchHint({ password, confirm }: PasswordMatchHintProps) {
  if (confirm.length === 0) return null;

  if (confirm !== password) {
    return (
      <p
        role="status"
        aria-live="polite"
        className="mt-2 text-sm font-semibold text-splash-deny"
      >
        Passwords don't match
      </p>
    );
  }

  return (
    <p
      role="status"
      aria-live="polite"
      className="mt-2 text-sm font-semibold text-splash-success"
    >
      ✓ Good to go!
    </p>
  );
}
