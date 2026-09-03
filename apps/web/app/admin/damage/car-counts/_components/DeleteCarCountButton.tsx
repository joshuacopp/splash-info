"use client";

// Per-row delete on the car-counts table.
//
// A CLIENT ISLAND BECAUSE THE CONFIRM HAS TO HAPPEN HERE. A server action can't
// prompt, and adding an "are you sure" round trip on the server would cost ~20
// seconds under OpenNext for a question the browser can ask for free. So the
// confirmation is a window.confirm() in an onClick, and preventDefault on the
// click stops the form action from ever being dispatched. Same shape as the
// greeters DeleteGoalButton.
//
// PENDING STATE VIA useFormStatus, same as SavingButton and for the same reason
// (the table is server-rendered). The button just goes quiet and disables so it
// can't be double-clicked into a second POST for an id that is already gone.

import { useFormStatus } from "react-dom";

export function DeleteCarCountButton({ confirmText }: { confirmText: string }) {
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
      {pending ? "Deleting…" : "Delete"}
    </button>
  );
}
