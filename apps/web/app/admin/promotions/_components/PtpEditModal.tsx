// Brief 158b — Purpose / Tools / Process edit modal.
//
// Pre-populates from the current promo.ptp (or empty if PTP hasn't been
// built yet). Single Save button; client-side empty submit is allowed
// (the worker treats empty strings as cleared values).

"use client";

import { useEffect, useState } from "react";
import { ActionForm } from "../../_components/ActionForm";
import type { ActionResult } from "../../_components/ActionForm";
import { SubmitButton } from "../../_components/SubmitButton";
import { putPtpAction } from "../_actions/ptpActions";
import type { PromoPtp } from "../_lib/types";

interface Props {
  promoId: string;
  ptp: PromoPtp | null;
  triggerLabel?: string;
}

export default function PtpEditModal({
  promoId,
  ptp,
  triggerLabel
}: Props) {
  const [open, setOpen] = useState(false);

  const defaultLabel = ptp ? "Edit PTP" : "+ Build PTP";
  const label = triggerLabel ?? defaultLabel;

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  function handleResult(result: ActionResult) {
    if (result.ok) setOpen(false);
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-splash-sm border border-splash-blue bg-white px-3 py-1.5 text-xs font-bold text-splash-blue hover:bg-splash-blue/5"
      >
        {label}
      </button>
    );
  }

  return (
    <>
      <button
        type="button"
        className="rounded-splash-sm border border-splash-blue bg-splash-blue/5 px-3 py-1.5 text-xs font-bold text-splash-blue"
      >
        {label}
      </button>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Edit Purpose / Tools / Process"
        className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 px-4 py-6"
        onClick={() => setOpen(false)}
      >
        <div
          className="w-full max-w-2xl rounded-splash-lg bg-white p-6 shadow-splash-card"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-bold text-splash-navy">
              Purpose · Tools · Process
            </h2>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-splash-sm px-2 py-1 text-splash-navy/70 hover:bg-gray-100"
              aria-label="Close"
            >
              ×
            </button>
          </div>
          <ActionForm
            action={putPtpAction}
            onResult={handleResult}
            resetOnSuccess={false}
            className="space-y-4"
          >
            <input type="hidden" name="promoId" value={promoId} />
            <PtpField
              name="purpose"
              label="Purpose"
              hint="Why are we running this promo?"
              defaultValue={ptp?.purpose ?? ""}
            />
            <PtpField
              name="tools"
              label="Tools"
              hint="What systems / assets does it touch?"
              defaultValue={ptp?.tools ?? ""}
            />
            <PtpField
              name="process"
              label="Process"
              hint="Step-by-step build + rollout."
              defaultValue={ptp?.process ?? ""}
            />
            <div className="flex items-center justify-end gap-3 border-t border-gray-light pt-3">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-splash-sm border border-gray-light bg-white px-4 py-2 text-sm font-bold text-splash-navy hover:bg-gray-100"
              >
                Cancel
              </button>
              <SubmitButton
                pendingText="Saving…"
                className="rounded-splash-sm bg-splash-blue px-4 py-2 text-sm font-bold text-white shadow-splash-card hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-70"
              >
                Save
              </SubmitButton>
            </div>
          </ActionForm>
        </div>
      </div>
    </>
  );
}

function PtpField({
  name,
  label,
  hint,
  defaultValue
}: {
  name: string;
  label: string;
  hint: string;
  defaultValue: string;
}) {
  return (
    <div>
      <label className="mb-1 block text-sm font-semibold text-splash-navy">
        {label}
      </label>
      <textarea
        name={name}
        rows={4}
        defaultValue={defaultValue}
        maxLength={10000}
        className="w-full rounded-splash-sm border border-gray-light bg-white px-3 py-2 text-sm focus:border-splash-blue focus:outline-none"
      />
      <p className="mt-1 text-xs text-splash-navy/55">{hint}</p>
    </div>
  );
}
