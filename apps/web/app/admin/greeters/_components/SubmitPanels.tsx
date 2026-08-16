"use client";

// Button row -> modal, replacing the three stacked write cards that used to sit
// at the bottom of the page.
//
// The forms are still SERVER components. They arrive as ReactNode props and are
// only ever hidden/shown here, so nothing about them gets pulled into the
// client bundle — the greeter form is a client component on its own merits (its
// people dropdown is chained to the location), but the site-day and goal forms
// stay server-rendered. Rebuilding them as client components to live in a modal
// would have been the expensive way to do this.
//
// WHY MOUNTED-BUT-HIDDEN, not conditionally rendered: a `{open && <form/>}`
// would remount each form every time it's opened, wiping half-typed input if
// someone closes the modal to go re-read a number off the page. The panels are
// rendered once and toggled with CSS, so state survives.
//
// Submission navigates away (the server action redirects), so there is no
// "close the modal on success" path to get wrong.

import { useCallback, useEffect, useState, type ReactNode } from "react";

export interface SubmitPanel {
  key: string;
  /** Button text. Short — these sit in a row. */
  label: string;
  /** Modal heading. */
  title: string;
  /** One or two sentences under the heading. */
  description: string;
  form: ReactNode;
}

export function SubmitPanels({ panels }: { panels: SubmitPanel[] }) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const close = useCallback(() => setOpenKey(null), []);

  // Escape closes. Bound on document rather than the dialog so it works before
  // anything inside has been focused.
  useEffect(() => {
    if (!openKey) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [openKey, close]);

  // Stop the page behind the modal from scrolling under it.
  useEffect(() => {
    if (!openKey) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [openKey]);

  const active = panels.find((p) => p.key === openKey) ?? null;

  return (
    <>
      <div className="mb-6 rounded-splash-lg border border-gray-light bg-white p-5 shadow-splash-card">
        <h2 className="mb-1 text-lg font-bold text-splash-navy">Add data</h2>
        <p className="mb-4 text-xs text-splash-navy/60">
          Everything you can log from this page. Re-submitting the same day
          updates that row rather than adding a second one.
        </p>
        <div className="flex flex-wrap gap-3">
          {panels.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => setOpenKey(p.key)}
              className="inline-flex items-center gap-1.5 rounded-splash-sm bg-splash-blue px-5 py-2.5 text-sm font-bold text-white shadow-splash-btn transition-colors hover:bg-splash-blue-dark"
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* Backdrop. Rendered only while something is open so it can't swallow
          clicks on the page underneath. */}
      {active ? (
        <div
          className="fixed inset-0 z-40 bg-splash-navy/40"
          onClick={close}
          aria-hidden="true"
        />
      ) : null}

      {/* Every panel stays mounted; only the active one is visible. */}
      {panels.map((p) => {
        const isOpen = p.key === openKey;
        return (
          <div
            key={p.key}
            role="dialog"
            aria-modal="true"
            aria-label={p.title}
            aria-hidden={!isOpen}
            className={
              isOpen
                ? "fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:p-8"
                : "hidden"
            }
          >
            <div
              className="w-full max-w-[900px] rounded-splash-lg border border-gray-light bg-white p-6 shadow-splash-card"
              // The backdrop closes on click; without this, a click that starts
              // inside the card and ends on the backdrop would close it too.
              onClick={(e) => e.stopPropagation()}
            >
              <div className="mb-4 flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-lg font-bold text-splash-navy">
                    {p.title}
                  </h2>
                  <p className="mt-1 text-xs text-splash-navy/60">
                    {p.description}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={close}
                  aria-label="Close"
                  className="-mt-1 shrink-0 rounded-splash-sm px-2 py-1 text-2xl leading-none text-splash-navy/50 transition-colors hover:bg-splash-navy/5 hover:text-splash-navy"
                >
                  &times;
                </button>
              </div>
              {p.form}
            </div>
          </div>
        );
      })}
    </>
  );
}
