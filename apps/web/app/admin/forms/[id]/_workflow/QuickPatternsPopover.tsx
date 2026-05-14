// Brief 127 — Quick patterns popover.
//
// Below the workflow stages, alongside "+ Add step", a smaller "Quick
// patterns…" button opens a popover with one-click templates. Each
// pattern inserts email-step entries into the workflow at the
// appropriate position; the operator then edits / accepts / discards
// before publishing.

"use client";

import { useEffect, useRef, useState } from "react";

import type { QuickPattern } from "../_builder/reducer";

interface Props {
  onApply: (pattern: QuickPattern) => void;
}

const PATTERNS: ReadonlyArray<{
  id: QuickPattern;
  label: string;
  description: string;
}> = [
  {
    id: "email_submitter_on_outcome",
    label: "Email submitter on outcome",
    description:
      "Inserts an email step right before each outcome, sending to the form submitter."
  },
  {
    id: "email_approver_when_assigned",
    label: "Email approver when assigned",
    description:
      "Inserts an email step right before each approval step, sending to that step's approver."
  },
  {
    id: "email_rm_on_submission",
    label: "Email RM on submission",
    description:
      "Adds an email step right after the form is submitted, sending to the picked location's RM."
  },
  {
    id: "email_specific_person_on_submission",
    label: "Email a specific person on submission",
    description: "Adds an email step with an empty recipient — you pick who."
  },
  {
    id: "email_submitter_on_approve_and_deny",
    label: "Email submitter on approve + deny",
    description:
      "Wires the approval step's Approve action through an approval-email step (PDF attached) → Approved outcome, and its Deny action through a denial-email step → Denied outcome. Both emails go to the form submitter."
  }
];

export default function QuickPatternsPopover({ onApply }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

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
    <div className="relative inline-block" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center rounded-splash-md border border-splash-navy/30 bg-white px-3 py-1.5 text-xs font-semibold text-splash-navy hover:bg-splash-navy/5"
      >
        Quick patterns…
      </button>
      {open && (
        <div
          role="menu"
          className="absolute left-0 z-20 mt-1 w-96 rounded-splash-md border border-gray-light bg-white p-1 shadow-lg"
        >
          {PATTERNS.map((p) => (
            <button
              key={p.id}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onApply(p.id);
              }}
              className="block w-full rounded-splash-sm px-3 py-2 text-left text-sm hover:bg-amber-50"
            >
              <span className="block font-semibold text-splash-navy">
                {p.label}
              </span>
              <span className="block text-xs text-splash-navy/60">
                {p.description}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
