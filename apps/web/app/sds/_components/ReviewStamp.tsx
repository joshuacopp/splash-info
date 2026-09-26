"use client";

// "Mark reviewed" — records that somebody checked this list against the binder
// today.
//
// It exists because the Safety Center checklist asks "Current SDS Binder
// Available", and without a date that question has no evidence behind it. The
// stamp is also printed on the index, so a binder cover page cannot be mistaken
// for a current one when it is three years stale.

import { useTransition, useState } from "react";
import { useRouter } from "next/navigation";

import { markReviewedAction } from "../actions";

export default function ReviewStamp({
  locationCode,
  lastReviewedAt,
  lastReviewedBy,
  canEdit
}: {
  locationCode: string;
  lastReviewedAt: string | null;
  lastReviewedBy: string | null;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const when = lastReviewedAt
    ? new Date(lastReviewedAt).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric"
      })
    : null;

  return (
    <div className="flex flex-wrap items-center gap-3 text-sm">
      <span className="text-splash-navy/70">
        {when ? (
          <>
            Last reviewed <span className="font-semibold">{when}</span>
            {lastReviewedBy ? ` by ${lastReviewedBy}` : ""}
          </>
        ) : (
          "Not yet marked reviewed"
        )}
      </span>
      {canEdit ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            setError(null);
            startTransition(async () => {
              const res = await markReviewedAction(locationCode);
              if (!res.ok) setError(res.error);
              router.refresh();
            });
          }}
          className="rounded-splash-sm border border-splash-navy/30 px-2.5 py-1 text-xs font-semibold text-splash-navy hover:bg-splash-navy/5 disabled:opacity-50"
        >
          {pending ? "Saving…" : "Mark reviewed today"}
        </button>
      ) : null}
      {error ? (
        <span role="alert" className="text-xs text-racecar-red">
          {error}
        </span>
      ) : null}
    </div>
  );
}
