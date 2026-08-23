"use client";

// The per-row Void / Restore submit button on the two day tables.
//
// A CLIENT ISLAND FOR THE SAME REASON AS DeleteGoalButton: a server action can't
// prompt, and an "are you sure" round trip on the server would cost ~20 seconds
// under OpenNext for a question the browser asks for free. The confirm lives in
// an onClick, and preventDefault stops the form action from being dispatched.
//
// Generalised rather than copied from DeleteGoalButton because the two verbs
// here are opposites and must not read alike: striking a day out is destructive
// enough to warrant a red button and a sentence explaining what disappears,
// while putting one back is the undo and gets neither.
//
// `confirmText` is OPTIONAL, and its absence is the whole difference between the
// two. Restore is reversible by clicking Void again, so prompting for it would
// train people to dismiss the prompt that matters.
//
// Pending state via useFormStatus, same as SavingButton: the tables are
// server-rendered, so there is no local submitting flag to hang this on. The
// button disables while in flight so a double-click can't post the same id
// twice — harmless server-side (both endpoints guard on the current state) but
// it would produce a second confusing banner.

import { useFormStatus } from "react-dom";

const TONE_CLS: Record<"deny" | "quiet", string> = {
  deny: "border-splash-deny/40 text-splash-deny hover:bg-splash-deny/10",
  quiet:
    "border-splash-blue/40 text-splash-blue hover:bg-splash-blue/10"
};

export function RowActionButton({
  label,
  pendingLabel,
  confirmText,
  tone = "deny"
}: {
  label: string;
  pendingLabel: string;
  /** Omit for a reversible action — see the note above. */
  confirmText?: string;
  tone?: "deny" | "quiet";
}) {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      disabled={pending}
      className={`rounded-splash-sm border px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${TONE_CLS[tone]}`}
      onClick={(e) => {
        if (confirmText && !window.confirm(confirmText)) e.preventDefault();
      }}
    >
      {pending ? pendingLabel : label}
    </button>
  );
}
