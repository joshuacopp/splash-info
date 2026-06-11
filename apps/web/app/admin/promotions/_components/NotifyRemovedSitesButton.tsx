// Brief 167 — sticky bottom-right "Notify removed sites" FAB + confirmation
// modal.
//
// Symmetric twin of Brief 164's `NotifyCompletedSitesButton`. Same shape,
// orange tint (to distinguish from the navy build-phase FAB), reads from
// the worker's removal-phase eligible-sites query (`is_removed = true AND
// removalNotifiedAt === null`).
//
// FAB stacking on the ticket page is handled by the parent — Brief 167
// chose to HIDE the build-phase FAB once status is `Removing` / `Ended`
// (the build phase is over by then), so only one FAB is visible at a
// time and no z-stack coordination is needed in this file.

"use client";

import { useEffect, useRef, useState } from "react";
import { ActionForm } from "../../_components/ActionForm";
import type { ActionResult } from "../../_components/ActionForm";
import { SubmitButton } from "../../_components/SubmitButton";
import { notifyRemovedSitesAction } from "../_actions/ticketActions";

const NOTE_MAX_LEN = 500;
const PREVIEW_LIMIT = 5;

interface Props {
  promoId: string;
  /** Eligible removed sites — `is_removed = true AND removalNotifiedAt ===
   *  null`. The ticket page derives this server-side so the FAB's disabled
   *  state is correct on first paint. */
  eligibleSites: string[];
}

export default function NotifyRemovedSitesButton({
  promoId,
  eligibleSites
}: Props) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [lastResult, setLastResult] = useState<ActionResult | null>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);

  const eligibleCount = eligibleSites.length;
  const disabled = eligibleCount === 0;

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  function onOpen() {
    if (disabled) return;
    setLastResult(null);
    setNote("");
    setOpen(true);
  }

  function handleResult(result: ActionResult) {
    setLastResult(result);
    if (result.ok) {
      setOpen(false);
    }
  }

  const preview = eligibleSites.slice(0, PREVIEW_LIMIT);
  const remainder = eligibleCount - preview.length;

  return (
    <>
      {/* Sticky FAB */}
      <div className="fixed bottom-6 right-6 z-50 flex flex-col items-end gap-2">
        {lastResult?.ok ? (
          <div
            role="status"
            className="max-w-sm rounded-splash-lg border border-emerald-200 bg-white px-4 py-3 text-sm font-medium text-splash-navy shadow-splash-card"
          >
            <span className="font-bold text-emerald-700">✓</span>{" "}
            {lastResult.message ?? "Notified."}
            {(() => {
              const data = (lastResult as { data?: unknown }).data as
                | {
                    failedLocations?: string[];
                  }
                | undefined;
              if (data?.failedLocations && data.failedLocations.length > 0) {
                return (
                  <p
                    role="alert"
                    className="mt-2 rounded-splash-sm border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-900"
                  >
                    Failed: {data.failedLocations.join(", ")}. Retry by
                    clicking the button again.
                  </p>
                );
              }
              return null;
            })()}
          </div>
        ) : null}
        {lastResult && !lastResult.ok ? (
          <div
            role="alert"
            className="max-w-sm rounded-splash-lg border border-splash-deny/40 bg-splash-deny/10 px-4 py-3 text-sm font-medium text-splash-deny shadow-splash-card"
          >
            {lastResult.error}
          </div>
        ) : null}

        <button
          type="button"
          onClick={onOpen}
          disabled={disabled}
          title={
            disabled
              ? "No new sites to notify — mark a site removed first"
              : "Only sites marked removed and not yet notified will receive an email."
          }
          aria-label="Notify removed sites"
          className={
            "inline-flex items-center gap-2 rounded-full px-5 py-3 text-sm font-bold shadow-splash-card transition-all " +
            (disabled
              ? "cursor-not-allowed border border-gray-light bg-white text-splash-navy/40"
              : "bg-orange-600 text-white hover:bg-orange-700")
          }
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
            <path d="M13.73 21a2 2 0 0 1-3.46 0" />
          </svg>
          <span>
            Notify removed sites
            {eligibleCount > 0 ? (
              <span className="ml-1 rounded-full bg-white/20 px-1.5 py-0.5 text-[0.6875rem]">
                {eligibleCount}
              </span>
            ) : null}
          </span>
        </button>
      </div>

      {/* Confirmation modal */}
      {open ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Notify removed sites"
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 px-4 py-6"
          onClick={() => setOpen(false)}
        >
          <div
            className="w-full max-w-lg rounded-splash-lg bg-white p-6 shadow-splash-card"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-bold text-splash-navy">
                Notify removed sites
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

            <p className="mb-3 text-sm text-splash-navy/70">
              Only sites marked removed and not yet notified will receive an
              email. By default we email the site address on file — opt in
              below to also include the Regional Manager / Regional Director.
            </p>

            <div className="mb-4 rounded-splash-sm border border-gray-light bg-gray-50 px-3 py-2 text-sm">
              <p className="font-bold text-splash-navy">
                {eligibleCount} eligible{" "}
                {eligibleCount === 1 ? "site" : "sites"}
              </p>
              <p className="mt-1 font-mono text-[0.8125rem] text-splash-navy/80">
                {preview.join(", ")}
                {remainder > 0 ? (
                  <span className="text-splash-navy/55">
                    {" "}
                    and {remainder} more
                  </span>
                ) : null}
              </p>
            </div>

            <ActionForm
              action={notifyRemovedSitesAction}
              onResult={handleResult}
              resetOnSuccess={false}
              className="space-y-4"
            >
              <input type="hidden" name="promoId" value={promoId} />
              <div>
                <label
                  htmlFor="notify-removed-note"
                  className="mb-1 block text-sm font-semibold text-splash-navy"
                >
                  Optional note{" "}
                  <span className="font-normal text-splash-navy/55">
                    (prepends to each email)
                  </span>
                </label>
                <textarea
                  id="notify-removed-note"
                  ref={noteRef}
                  name="note"
                  rows={3}
                  maxLength={NOTE_MAX_LEN}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="e.g. The kiosk should return to its previous pricing tomorrow morning."
                  className="w-full rounded-splash-sm border border-gray-light bg-white px-3 py-2 text-sm focus:border-splash-blue focus:outline-none"
                />
                <p className="mt-1 text-right text-xs text-splash-navy/55">
                  {note.length} / {NOTE_MAX_LEN}
                </p>
              </div>

              {/* Brief 166-style RM/RD opt-in. Default OFF. */}
              <fieldset className="space-y-1.5">
                <legend className="mb-1 block text-sm font-semibold text-splash-navy">
                  Also notify{" "}
                  <span className="font-normal text-splash-navy/55">
                    (optional)
                  </span>
                </legend>
                <label className="flex items-center gap-2 text-sm text-splash-navy">
                  <input
                    type="checkbox"
                    name="includeRm"
                    className="h-4 w-4"
                  />
                  <span>Also notify Regional Manager</span>
                </label>
                <label className="flex items-center gap-2 text-sm text-splash-navy">
                  <input
                    type="checkbox"
                    name="includeRd"
                    className="h-4 w-4"
                  />
                  <span>Also notify Regional Director</span>
                </label>
              </fieldset>

              <div className="flex items-center justify-end gap-3 border-t border-gray-light pt-3">
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="rounded-splash-sm border border-gray-light bg-white px-4 py-2 text-sm font-bold text-splash-navy hover:bg-gray-100"
                >
                  Cancel
                </button>
                <SubmitButton
                  pendingText="Notifying…"
                  className="rounded-splash-sm bg-orange-600 px-4 py-2 text-sm font-bold text-white shadow-splash-card hover:bg-orange-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Notify {eligibleCount}{" "}
                  {eligibleCount === 1 ? "site" : "sites"}
                </SubmitButton>
              </div>
            </ActionForm>
          </div>
        </div>
      ) : null}
    </>
  );
}
