"use client";

// Segment-level error boundary for /admin/forms/*. Sits below the global
// /admin/error.tsx (Brief 31) and provides forms-aware copy. Catches
// throws from any forms page (list / new / builder / submissions /
// versions) — most likely sources are SSR worker fetch failures or
// server-action ID mismatches after a deploy. (Brief 98.)

import { useEffect } from "react";

export default function FormsError({
  error,
  reset
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const isStaleAction =
    typeof error.message === "string" &&
    error.message.includes("Server Action") &&
    error.message.includes("was not found on the server");

  useEffect(() => {
    console.error("[forms error boundary]", error);
  }, [error]);

  if (isStaleAction) {
    return (
      <section className="mx-auto w-full max-w-[640px] px-5 py-12">
        <h1 className="mb-2 text-xl font-bold text-splash-navy">
          App was updated
        </h1>
        <p className="mb-5 text-sm text-splash-navy/70">
          The form builder got out of sync with the server (this can
          happen after a deploy). Reload to pick up the new version —
          your last action wasn&apos;t saved.
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="inline-flex items-center gap-1.5 rounded-splash-sm bg-splash-blue px-5 py-2.5 text-sm font-bold text-white shadow-splash-btn hover:bg-splash-blue-dark"
        >
          Reload
        </button>
      </section>
    );
  }

  return (
    <section className="mx-auto w-full max-w-[640px] px-5 py-12">
      <h1 className="mb-2 text-xl font-bold text-splash-deny">
        Couldn&apos;t load form builder
      </h1>
      <p className="mb-5 text-sm text-splash-navy/70">
        Something went wrong loading this page. Try again — if it keeps
        happening, check the worker logs.
        {error.digest ? (
          <span className="mt-2 block font-mono text-xs text-splash-navy/50">
            digest: {error.digest}
          </span>
        ) : null}
      </p>
      <button
        type="button"
        onClick={() => reset()}
        className="inline-flex items-center gap-1.5 rounded-splash-sm bg-splash-blue px-5 py-2.5 text-sm font-bold text-white shadow-splash-btn hover:bg-splash-blue-dark"
      >
        Try again
      </button>
    </section>
  );
}
