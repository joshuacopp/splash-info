"use client";

// Submit button + full-screen "Saving…" overlay for the three greeter
// submission forms.
//
// THE PROBLEM THIS SOLVES: every one of these forms posts to a server action
// that writes through performance-worker and then redirects. That round trip
// runs ~10 seconds on a cold worker. Until now the only visible effect was the
// LocationPicker clearing itself (it remounts on the action's re-render), so
// the screen looked like it had eaten the submission and done nothing. People
// hit Save twice.
//
// WHY useFormStatus AND NOT LOCAL STATE: two of the three forms
// (site-wide numbers, goals) are server components — they have no state to
// hold an `isSaving` flag, and rewriting them as client components to get one
// would drag the whole field set into the client bundle. useFormStatus reads
// the pending state of the nearest <form> ancestor from React itself, so a
// small client button dropped inside a server-rendered form is all that's
// needed. This is also why the component must be rendered INSIDE the <form>
// element and not beside it — outside, the hook always reports false.
//
// WHY THE OVERLAY IS FIXED, NOT INLINE: the forms live in a scrollable modal
// (SubmitPanels) and the button sits at the bottom of a long field set. On a
// phone the button is usually off-screen by the time someone taps it — an
// inline spinner would be invisible at exactly the moment it matters. z-[60]
// clears the modal's z-50.
//
// WHY IT'S PORTALLED TO document.body: SubmitPanels keeps every panel mounted
// and hides the inactive ones with `hidden`. Escape closes the modal, and it
// does NOT cancel an in-flight submission — so without the portal, hitting
// Escape mid-save would put `display:none` on an ancestor and take the overlay
// with it, landing us right back on the blank-screen problem. Portalled out,
// the overlay is a sibling of the modal and survives it.
//
// NO SUCCESS/ERROR STATE HERE ON PURPOSE: the action redirects on success and
// re-renders with a banner on failure. Either way the overlay disappears
// because `pending` goes false. There is nothing for this component to clean
// up, and nothing it needs to know about the outcome.

import type { ReactNode } from "react";
import { createPortal, useFormStatus } from "react-dom";
import { ASSETS } from "@splash/storage-r2/assets";

const BTN_CLS =
  "inline-flex items-center gap-2 rounded-splash-sm bg-splash-blue px-5 py-2.5 text-sm font-bold text-white shadow-splash-btn transition-colors hover:bg-splash-blue-dark disabled:cursor-not-allowed disabled:opacity-70 disabled:hover:bg-splash-blue";

export function SavingButton({
  children,
  savingLabel = "Saving…"
}: {
  /** Idle button text. */
  children: ReactNode;
  /** Button text while the action is in flight. */
  savingLabel?: string;
}) {
  const { pending } = useFormStatus();

  return (
    <>
      {/* Disabled while pending — the double-submit this replaces was the
          actual reported symptom, not just a cosmetic gap. */}
      <button type="submit" disabled={pending} className={BTN_CLS}>
        {pending ? <Spinner className="h-4 w-4 border-2" /> : null}
        {pending ? savingLabel : children}
      </button>

      {pending ? <SavingOverlay /> : null}
    </>
  );
}

function SavingOverlay() {
  // `pending` is false on the server and stays false until the user submits,
  // so document always exists by the time this renders. The guard is belt and
  // braces against a future caller rendering it unconditionally.
  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex flex-col items-center justify-center gap-5 bg-splash-navy/80 backdrop-blur-sm"
      // Announced, but not focus-trapped: nothing in here is interactive and
      // the whole thing is gone in a few seconds.
      role="status"
      aria-live="polite"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={ASSETS.logoWhite}
        alt=""
        aria-hidden="true"
        className="h-14 w-auto"
      />
      <Spinner className="h-10 w-10 border-4" />
      <p className="text-sm font-semibold text-white">Saving…</p>
      <p className="max-w-xs px-6 text-center text-xs text-white/70">
        This can take a few seconds. Don&rsquo;t close the page.
      </p>
    </div>,
    document.body
  );
}

// Ring spinner: a full border with one side made transparent, spun. Cheaper
// than an SVG and it inherits currentColor, so the same component works on the
// blue button and on the navy overlay.
function Spinner({ className = "" }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block animate-spin rounded-full border-current border-r-transparent align-[-0.125em] ${className}`}
    />
  );
}
