// Phone / small-tablet support for the Fields tab.
//
// Below the `lg` breakpoint the three-column builder (palette | canvas |
// inspector) cannot fit: the canvas -- the part being edited -- was squeezed
// into a strip a few characters wide and the page scrolled sideways. On a
// narrow screen the canvas takes the full width and the other two panels
// become bottom sheets.
//
// useIsWide decides which layout renders, rather than CSS hiding one of two
// mounted copies: the per-type Inspector components hold local state and
// effects (the approver picker migrates legacy shapes on mount), and two live
// copies of them would both run.

"use client";

import { useEffect, useState, type ReactNode } from "react";

const WIDE_QUERY = "(min-width: 1024px)";

/** True on desktop-width screens. Starts true so the server render and the
 *  first desktop paint are the unchanged three-column builder; a phone flips
 *  to the narrow layout right after mount. */
export function useIsWide(): boolean {
  const [wide, setWide] = useState(true);
  useEffect(() => {
    const mq = window.matchMedia(WIDE_QUERY);
    const update = () => setWide(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return wide;
}

interface SheetProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Label of the close button. */
  doneLabel?: string;
}

/** A panel that slides up from the bottom of the screen over a dimmed page. */
export function BottomSheet({ open, title, onClose, children, doneLabel = "Done" }: SheetProps) {
  // Stop the page behind from scrolling while the sheet is up, and let Escape
  // close it (hardware keyboards on tablets).
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end" role="dialog" aria-modal="true" aria-label={title}>
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-splash-navy/40"
      />
      <div className="relative flex max-h-[85vh] flex-col rounded-t-splash-lg bg-white shadow-2xl">
        <div className="flex items-center justify-between gap-3 border-b border-gray-light px-4 py-3">
          <p className="min-w-0 truncate text-base font-bold text-splash-navy">{title}</p>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-splash-sm bg-splash-blue px-4 py-1.5 text-sm font-bold text-white shadow-splash-btn"
          >
            {doneLabel}
          </button>
        </div>
        <div className="overflow-y-auto px-4 py-3 pb-[calc(1rem+env(safe-area-inset-bottom,0px))]">
          {children}
        </div>
      </div>
    </div>
  );
}
