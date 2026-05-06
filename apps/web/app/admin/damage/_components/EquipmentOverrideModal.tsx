// Brief 43 — pre-flight modal that asks GM/RM/admin/super_admin "Was this
// damage equipment related?" when they approve a claim into one of the two
// active-repair branches and the employee left equipment_related=0.
//
// Pattern (per brief Phase 2.4): the modal does NOT replace the form's
// submission path. It's a pre-flight gate that adds two hidden inputs
// (`override_equipment_related` and, on yes, `override_equipment_piece`)
// to the existing transition form, then re-submits via form.requestSubmit().
// Server action `transitionAction` already forwards every form field to
// the worker's /transition endpoint via damagePostForm — no plumbing change
// needed beyond having the hidden fields in the form at submit time.
//
// The component renders BOTH the submit button and the modal so the click
// handler on the button can stop the form's default submit, open the modal,
// and on confirm dispatch the actual submission. The button styling matches
// the disabled/enabled treatment used by the original TransitionForm so the
// two paths render identically.
//
// Brief 45 — the modal's `<div role="dialog">…</div>` is rendered through
// `createPortal(…, document.body)` instead of inline. The submit button
// stays in place inside the parent transition `<form>` (so
// `submitButton.form` keeps resolving to the right form on requestSubmit),
// but the modal's own `<form onSubmit={handleConfirm}>` would otherwise
// nest inside the parent transition `<form>` in the live DOM. Nested
// forms are invalid HTML and the browser's recovery is non-deterministic;
// in practice the inner submit handler interfered with React 19's
// `useActionState` dispatch ~4/5 of the time, causing the transition POST
// to silently no-op. Portaling the dialog to `document.body` puts the
// modal's form outside the parent form, so the requestSubmit() path runs
// cleanly every time. Future modals rendered inside parent forms should
// portal-by-default to avoid recreating this gotcha. Do not "simplify"
// this back into the inline conditional — it will reintroduce the bug.
//
// Equipment-piece options are hard-forked from the public claim form's
// EQUIPMENT_CHOICES at apps/damage-worker/src/render/claim-form.ts:18.
// Worker is the canonical source — keep this list in sync. The list is
// short (6 items) and rarely changes; the alternative (a shared constant
// in @splash/types) was weighed against the cross-package complexity and
// rejected per the brief's "executor's call" guidance.

"use client";

import { useState, useRef, useEffect, type FormEvent } from "react";
import { createPortal } from "react-dom";

/** SOURCE OF TRUTH: apps/damage-worker/src/render/claim-form.ts:18
 *  EQUIPMENT_CHOICES. Adding/removing options requires a coordinated edit
 *  in both files. */
const EQUIPMENT_PIECE_OPTIONS = [
  "Top Brush",
  "Side Wraps",
  "Conveyor",
  "Dryer",
  "Wheel Blaster",
  "Other"
] as const;

interface Props {
  /** Submit-button label — matches the original TransitionForm. */
  label: string;
  /** Whether the click should actually submit (mirrors the dcRole gate). */
  enabled: boolean;
  /** Toggle that turns this from a plain submit button into a modal-gated
   *  one. Set true ONLY when the target transition is one of the two
   *  active-repair statuses AND the loaded claim has equipment_related === 0. */
  modalEnabled: boolean;
  /** Human-readable transition label rendered inside the modal copy. */
  transitionLabel: string;
}

export function EquipmentOverrideSubmit({
  label,
  enabled,
  modalEnabled,
  transitionLabel
}: Props) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<"no" | "yes">("no");
  const [piece, setPiece] = useState<string>("");

  // ESC closes the modal without submitting. Click-outside also closes
  // (kept consistent with v1 ModalShell semantics — destructive actions
  // cancel rather than commit on outside dismiss).
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open]);

  const submitButtonClass = enabled
    ? "inline-flex items-center gap-1.5 rounded-splash-sm bg-splash-blue px-5 py-2.5 text-sm font-bold text-white shadow-splash-btn transition-colors hover:bg-splash-blue-dark"
    : "inline-flex cursor-not-allowed items-center gap-1.5 rounded-splash-sm bg-splash-navy/20 px-5 py-2.5 text-sm font-bold text-splash-navy/50";

  function handleClick(e: React.MouseEvent<HTMLButtonElement>) {
    if (!modalEnabled || !enabled) return; // let the form submit normally
    e.preventDefault();
    setChoice("no");
    setPiece("");
    setOpen(true);
  }

  function handleConfirm(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const submitButton = buttonRef.current;
    const form = submitButton?.form;
    if (!submitButton || !form) {
      setOpen(false);
      return;
    }

    if (choice === "yes" && !piece) {
      // The native required attr on <select> normally catches this; defensive.
      return;
    }

    // Append hidden inputs into the parent transition form. They become
    // part of FormData when requestSubmit() fires below. We name them
    // with the `override_` prefix so they're grep-able and distinct from
    // the form-time equipment_related / equipment_piece fields the public
    // claim form posts.
    appendHiddenInput(form, "override_equipment_related", choice);
    if (choice === "yes") {
      appendHiddenInput(form, "override_equipment_piece", piece);
    }

    setOpen(false);
    // requestSubmit() walks the form's submit pipeline including React 19's
    // <ActionForm> useActionState dispatch. Validates required fields the
    // same way a user click would.
    form.requestSubmit(submitButton);
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="submit"
        disabled={!enabled}
        onClick={handleClick}
        className={submitButtonClass}
      >
        {label}
      </button>
      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              role="dialog"
              aria-modal="true"
              aria-label="Equipment-related override"
              className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 p-4"
              onClick={() => setOpen(false)}
            >
          <form
            onSubmit={handleConfirm}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-[480px] rounded-splash-lg bg-white p-6 shadow-splash-card"
          >
            <h3 className="mb-3 text-lg font-bold text-splash-navy">
              Was this damage equipment related?
            </h3>
            <p className="mb-4 text-sm text-splash-navy/80">
              You&rsquo;re approving this claim into{" "}
              <span className="font-semibold">{transitionLabel}</span>. The
              employee marked it equipment_related = no, but you can override
              that here. If you say <span className="font-semibold">Yes</span>,
              a MaintainX work order will be created and assigned to
              maintenance.
            </p>

            <fieldset className="mb-4">
              <legend className="sr-only">Equipment related?</legend>
              <div className="flex gap-2">
                <label
                  className={
                    choice === "no"
                      ? "flex flex-1 cursor-pointer items-center justify-center rounded-splash-sm border-2 border-splash-blue bg-splash-blue/10 px-4 py-3 text-sm font-bold text-splash-navy"
                      : "flex flex-1 cursor-pointer items-center justify-center rounded-splash-sm border border-gray-light bg-white px-4 py-3 text-sm font-semibold text-splash-navy/70 hover:border-splash-blue/50"
                  }
                >
                  <input
                    type="radio"
                    name="modal_choice"
                    value="no"
                    checked={choice === "no"}
                    onChange={() => setChoice("no")}
                    className="sr-only"
                  />
                  No
                </label>
                <label
                  className={
                    choice === "yes"
                      ? "flex flex-1 cursor-pointer items-center justify-center rounded-splash-sm border-2 border-splash-blue bg-splash-blue/10 px-4 py-3 text-sm font-bold text-splash-navy"
                      : "flex flex-1 cursor-pointer items-center justify-center rounded-splash-sm border border-gray-light bg-white px-4 py-3 text-sm font-semibold text-splash-navy/70 hover:border-splash-blue/50"
                  }
                >
                  <input
                    type="radio"
                    name="modal_choice"
                    value="yes"
                    checked={choice === "yes"}
                    onChange={() => setChoice("yes")}
                    className="sr-only"
                  />
                  Yes
                </label>
              </div>
            </fieldset>

            {choice === "yes" ? (
              <label className="mb-4 flex flex-col gap-1">
                <span className="text-xs font-semibold uppercase tracking-wider text-splash-navy/70">
                  Equipment piece
                </span>
                <select
                  required
                  value={piece}
                  onChange={(e) => setPiece(e.target.value)}
                  className="w-full rounded-splash-sm border border-gray-light bg-white px-3 py-2 text-sm text-splash-navy focus:border-splash-blue focus:outline-none"
                >
                  <option value="" disabled>
                    Select equipment&hellip;
                  </option>
                  {EQUIPMENT_PIECE_OPTIONS.map((opt) => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-splash-sm border border-gray-light bg-white px-4 py-2 text-sm font-semibold text-splash-navy hover:bg-sudsy-blue-soft"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="rounded-splash-sm bg-splash-blue px-4 py-2 text-sm font-bold text-white shadow-splash-btn hover:bg-splash-blue-dark"
              >
                Confirm &mdash; {transitionLabel}
              </button>
            </div>
          </form>
            </div>,
            document.body
          )
        : null}
    </>
  );
}

function appendHiddenInput(form: HTMLFormElement, name: string, value: string) {
  // Reuse an existing hidden input with the same name if the operator
  // re-opened the modal after a previous confirm — keeps the form free of
  // duplicate fields after multiple cycles. The browser's FormData
  // constructor would dedupe by appending all values, which the worker
  // would then read as the LAST value; safer to update in place.
  const existing = form.querySelector<HTMLInputElement>(
    `input[type="hidden"][name="${CSS.escape(name)}"]`
  );
  if (existing) {
    existing.value = value;
    return;
  }
  const node = document.createElement("input");
  node.type = "hidden";
  node.name = name;
  node.value = value;
  form.appendChild(node);
}
