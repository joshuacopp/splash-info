// Super-admin-only hard-delete card for /admin/damage/[id]. Rendered by the
// detail page ONLY when session.dcRole === "super_admin"; the worker
// re-gates on super_admin for both endpoints as defense in depth.
//
// Two-step, type-to-confirm flow (client island — deliberately NOT the shared
// <ActionForm>/useActionState path, because we drive our own preview→confirm
// sequence and a client-side router.push on success):
//
//   1. "Delete this claim…" → calls purgePreviewAction to fetch the blast
//      radius (D1 row counts + R2 object count) so the operator confirms
//      against real numbers, not a guess.
//   2. Confirm panel shows the counts and requires the operator to type the
//      exact claim id. The Delete button stays disabled until it matches.
//   3. Delete → purgeClaimAction. On success the claim no longer exists, so
//      we router.push back to the claims list (staying on the detail URL
//      would render a 404 card).
//
// This is irreversible: the worker hard-deletes claim_photos, claim_activity,
// the claims row, and every associated R2 object. There is no recycle bin.

"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  purgeClaimAction,
  purgePreviewAction,
  type PurgeCounts
} from "../[id]/actions";

type Phase = "idle" | "confirm";

export function DangerZoneCard({ claimId }: { claimId: string }) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("idle");
  const [counts, setCounts] = useState<PurgeCounts | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function openConfirm() {
    setError(null);
    startTransition(async () => {
      const result = await purgePreviewAction(claimId);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setCounts(result.counts);
      setConfirmText("");
      setPhase("confirm");
    });
  }

  function cancel() {
    setPhase("idle");
    setCounts(null);
    setConfirmText("");
    setError(null);
  }

  function runDelete() {
    setError(null);
    startTransition(async () => {
      const result = await purgeClaimAction(claimId, confirmText);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      // Claim is gone — leave the (now-dead) detail URL for the list.
      router.push("/admin/damage");
      router.refresh();
    });
  }

  const confirmMatches = confirmText.trim() === claimId;

  return (
    <div className="mb-6 rounded-splash-lg border-2 border-splash-deny/40 bg-splash-deny/5 p-6 shadow-splash-card">
      <h2 className="mb-1 text-lg font-bold text-splash-deny">Danger zone</h2>
      <p className="mb-4 text-xs text-splash-navy/70">
        Super admin only. Permanently deletes this claim and everything tied to
        it &mdash; all photos and documents, the full activity history, and
        every stored file. This cannot be undone.
      </p>

      {error ? (
        <div
          role="alert"
          className="mb-4 rounded-splash-md border border-splash-deny/40 bg-splash-deny/10 px-4 py-3 text-sm font-medium text-splash-deny"
        >
          {error}
        </div>
      ) : null}

      {phase === "idle" ? (
        <button
          type="button"
          onClick={openConfirm}
          disabled={isPending}
          className={
            isPending
              ? "inline-flex cursor-wait items-center gap-1.5 rounded-splash-sm bg-splash-deny/50 px-5 py-2.5 text-sm font-bold text-white"
              : "inline-flex items-center gap-1.5 rounded-splash-sm border border-splash-deny bg-white px-5 py-2.5 text-sm font-bold text-splash-deny shadow-splash-btn transition-colors hover:bg-splash-deny hover:text-white"
          }
        >
          {isPending ? "Loading…" : "Delete this claim…"}
        </button>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="rounded-splash-md border border-splash-deny/30 bg-white p-4 text-sm text-splash-navy">
            <div className="mb-2 font-bold text-splash-deny">
              This will permanently delete:
            </div>
            <ul className="ml-4 list-disc space-y-1 text-splash-navy/80">
              <li>
                The claim record{" "}
                <span className="font-mono text-xs">({claimId})</span>
              </li>
              <li>
                {counts?.claim_photos ?? 0} photo/document row
                {counts?.claim_photos === 1 ? "" : "s"}
              </li>
              <li>
                {counts?.claim_activity ?? 0} activity-log entr
                {counts?.claim_activity === 1 ? "y" : "ies"}
              </li>
              <li>
                {counts?.r2_objects ?? 0} stored file
                {counts?.r2_objects === 1 ? "" : "s"} in R2
              </li>
            </ul>
          </div>

          <label className="flex flex-col gap-1">
            <span className="text-xs font-semibold uppercase tracking-wider text-splash-navy/70">
              Type the claim id to confirm
            </span>
            <input
              type="text"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={claimId}
              autoComplete="off"
              spellCheck={false}
              className="w-full rounded-splash-sm border border-gray-light bg-white px-3 py-2 font-mono text-sm text-splash-navy focus:border-splash-deny focus:outline-none sm:max-w-[420px]"
            />
          </label>

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <button
              type="button"
              onClick={runDelete}
              disabled={!confirmMatches || isPending}
              className={
                confirmMatches && !isPending
                  ? "inline-flex items-center gap-1.5 rounded-splash-sm bg-splash-deny px-5 py-2.5 text-sm font-bold text-white shadow-splash-btn transition-colors hover:bg-splash-deny/90"
                  : "inline-flex cursor-not-allowed items-center gap-1.5 rounded-splash-sm bg-splash-navy/20 px-5 py-2.5 text-sm font-bold text-splash-navy/50"
              }
            >
              {isPending ? "Deleting…" : "Permanently delete claim"}
            </button>
            <button
              type="button"
              onClick={cancel}
              disabled={isPending}
              className="rounded-splash-sm border border-gray-light bg-white px-4 py-2.5 text-sm font-semibold text-splash-navy hover:bg-sudsy-blue-soft"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
