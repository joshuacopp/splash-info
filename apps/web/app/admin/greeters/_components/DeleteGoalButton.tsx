"use client";

// The per-row delete on BOTH set-a-target tables: goal windows and monthly
// targets. Kept as one component under its original name rather than forked or
// renamed — it takes nothing but a sentence, so a MonthlyTargetDeleteButton
// would be a byte-identical copy, and the two tables sit one above the other
// where a difference in the button would read as a difference in the action.
//
// A CLIENT ISLAND BECAUSE THE CONFIRM HAS TO HAPPEN HERE. A server action can't
// prompt, and adding an "are you sure" round trip on the server would cost ~20
// seconds under OpenNext for a question the browser can ask for free. So the
// confirmation is a window.confirm() in an onClick, and preventDefault on the
// click stops the form action from ever being dispatched.
//
// NEITHER DELETE IS COSMETIC, which is why the prompt spells out what is being
// removed rather than saying "Delete this?". Both goals and monthly targets are
// snapshotted onto every day as it is submitted, so removing one rewrites the
// days already inside it — a goal window re-grades them against whatever is
// left underneath, a monthly target leaves their labor and revenue percentages
// blank. The caller passes the sentence, because only the caller knows which of
// those two things is about to happen; this component only guarantees it is
// read.
//
// PENDING STATE VIA useFormStatus, same as SavingButton and for the same reason
// (the table is server-rendered). No full-screen overlay here though: a delete
// is one small row, and blanking the whole page for it would be louder than the
// action deserves. The button just goes quiet and disables so it can't be
// double-clicked into a second POST for an id that is already gone.

import { useFormStatus } from "react-dom";

export function DeleteGoalButton({ confirmText }: { confirmText: string }) {
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
