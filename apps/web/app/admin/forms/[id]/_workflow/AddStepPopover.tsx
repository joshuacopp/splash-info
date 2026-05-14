// Brief 127 — "+ Add step" choice popover.
//
// Replaces Brief 125's single "+ Add approval step" button with a
// 2-choice popover: Approval step (existing) or Email step (new).
// Once an option is picked, the popover closes and the relevant
// dispatch fires.

"use client";

import { useEffect, useRef, useState } from "react";

interface Props {
  onAddApprovalStep: () => void;
  onAddEmailStep: () => void;
}

export default function AddStepPopover({
  onAddApprovalStep,
  onAddEmailStep
}: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  // Close on outside click + Escape.
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="block w-full rounded-splash-md border border-dashed border-splash-navy/60 py-3 text-sm font-semibold text-splash-navy/80 hover:bg-splash-navy/5"
      >
        + Add step
      </button>
      {open && (
        <div
          role="menu"
          className="absolute left-1/2 z-20 mt-1 w-80 -translate-x-1/2 rounded-splash-md border border-gray-light bg-white p-1 shadow-lg"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onAddApprovalStep();
            }}
            className="block w-full rounded-splash-sm px-3 py-2 text-left text-sm hover:bg-splash-blue/5"
          >
            <span className="block font-semibold text-splash-navy">
              Approval step
            </span>
            <span className="block text-xs text-splash-navy/60">
              Someone reviews and picks an action (Approve / Deny / …).
            </span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onAddEmailStep();
            }}
            className="block w-full rounded-splash-sm px-3 py-2 text-left text-sm hover:bg-amber-50"
          >
            <span className="block font-semibold text-splash-navy">
              Email step
            </span>
            <span className="block text-xs text-splash-navy/60">
              Send an email and move on automatically.
            </span>
          </button>
        </div>
      )}
    </div>
  );
}
