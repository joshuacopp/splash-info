// Brief 128 — client-side submit button with a confirmation prompt.
//
// Used in the Abandon action of the email-queue detail page. The parent is
// a server component, so the click handler that invokes window.confirm()
// has to live in a client island.

"use client";

interface Props {
  label: string;
  confirmText: string;
  className?: string;
}

export function ConfirmSubmitButton({ label, confirmText, className }: Props) {
  return (
    <button
      type="submit"
      className={className}
      onClick={(e) => {
        if (!window.confirm(confirmText)) {
          e.preventDefault();
        }
      }}
    >
      {label}
    </button>
  );
}
