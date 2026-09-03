"use client";

// Submit button for the car-count entry form.
//
// WHY useFormStatus AND NOT LOCAL STATE: the form is server-rendered, so it has
// no state to hold an `isSaving` flag. useFormStatus reads the pending state of
// the nearest <form> ancestor from React itself, so a small client button
// dropped inside a server-rendered form is all that's needed. It must be
// rendered INSIDE the <form> element — outside, the hook always reports false.
//
// Disabled while pending so it can't be double-clicked into a second POST.

import type { ReactNode } from "react";
import { useFormStatus } from "react-dom";

const BTN_CLS =
  "inline-flex items-center gap-2 rounded-splash-sm bg-splash-blue px-5 py-2.5 text-sm font-bold text-white shadow-splash-btn transition-colors hover:bg-splash-blue-dark disabled:cursor-not-allowed disabled:opacity-70 disabled:hover:bg-splash-blue";

export function SaveCarCountButton({ children }: { children: ReactNode }) {
  const { pending } = useFormStatus();

  return (
    <button type="submit" disabled={pending} className={BTN_CLS}>
      {pending ? "Saving…" : children}
    </button>
  );
}
