// Shared client submit button that displays a pending state via React 19's
// useFormStatus(). Pairs with <ActionForm> (or any server-action <form>)
// to give operators visible feedback that the form is being submitted —
// prevents the "nothing's happening, click again" multi-submit risk.
//
// Usage: replace any bare <button type="submit"> inside an ActionForm with
// <SubmitButton>Create form</SubmitButton>. Pass `pendingText` to customize
// the label shown while submitting (defaults to "Working…").

"use client";

import type { ReactNode } from "react";
import { useFormStatus } from "react-dom";

interface SubmitButtonProps {
  children: ReactNode;
  pendingText?: string;
  className?: string;
  /**
   * Additional disabled gate ORed with the form-status pending flag. Use
   * for client-side guards (e.g. "file exceeds size limit") that should
   * keep the button disabled even when no submit is in flight.
   */
  disabled?: boolean;
}

export function SubmitButton({
  children,
  pendingText = "Working…",
  className,
  disabled
}: SubmitButtonProps) {
  const { pending } = useFormStatus();
  const isDisabled = pending || Boolean(disabled);
  return (
    <button
      type="submit"
      disabled={isDisabled}
      aria-busy={pending}
      className={className}
    >
      {pending ? (
        <span className="inline-flex items-center gap-2">
          <Spinner />
          <span>{pendingText}</span>
        </span>
      ) : (
        children
      )}
    </button>
  );
}

function Spinner() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      className="animate-spin"
      aria-hidden="true"
    >
      <circle
        cx="12"
        cy="12"
        r="9"
        stroke="currentColor"
        strokeWidth="3"
        strokeOpacity="0.3"
      />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}
