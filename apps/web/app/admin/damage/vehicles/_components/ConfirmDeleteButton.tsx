"use client";

// Delete button with a browser confirm, for server-rendered <RedirectForm>s.
// Same shape as ../../car-counts/_components/DeleteCarCountButton.tsx, with a
// label so it fits both "Delete entry" and a small "Remove" under a thumbnail.

import { useFormStatus } from "react-dom";

export function ConfirmDeleteButton({
  confirmText,
  label = "Delete"
}: {
  confirmText: string;
  label?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-splash-sm border border-splash-deny/40 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-splash-deny transition-colors hover:bg-splash-deny/10 disabled:cursor-not-allowed disabled:opacity-60"
      onClick={(e) => {
        if (!window.confirm(confirmText)) e.preventDefault();
      }}
    >
      {pending ? "Deleting…" : label}
    </button>
  );
}
