"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { archiveFormAction, restoreFormAction } from "../actions";

interface Props {
  formId: string;
  status: "draft" | "published" | "archived";
}

// Archive / Restore control for a single form row.
//
// - published/draft → "Archive" (calls unpublish; hides the form from the
//   submissions index by default).
// - archived → "Restore" (calls republish back to published).
//
// Archiving is reversible, so we don't gate it behind a confirm dialog; the
// Restore button is right there if it was a misclick. Errors surface inline
// next to the button rather than as a toast (the list page has no toast host).
export default function ArchiveButton({ formId, status }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const isArchived = status === "archived";

  function run() {
    setError(null);
    startTransition(async () => {
      const res = isArchived
        ? await restoreFormAction(formId)
        : await archiveFormAction(formId);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={run}
        disabled={pending}
        className={`inline-flex items-center rounded-splash-sm border px-2 py-0.5 text-xs font-semibold transition disabled:opacity-50 ${
          isArchived
            ? "border-splash-success bg-white text-splash-success hover:bg-splash-success/5"
            : "border-gray-light bg-white text-splash-navy/70 hover:bg-gray-light/40"
        }`}
        aria-label={
          isArchived ? `Restore form ${formId}` : `Archive form ${formId}`
        }
      >
        {pending
          ? isArchived
            ? "Restoring…"
            : "Archiving…"
          : isArchived
            ? "Restore"
            : "Archive"}
      </button>
      {error && (
        <span
          role="alert"
          className="text-xs text-racecar-red"
          title={error}
        >
          Failed
        </span>
      )}
    </span>
  );
}
