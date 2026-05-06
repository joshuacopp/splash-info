"use client";

// Error boundary for /admin/*. Catches uncaught exceptions thrown from
// server actions or client components and renders a sensible recovery
// UI instead of Next's bare client-exception fallback. (Brief 31.)
//
// Specifically handles UnrecognizedActionError (server-action ID
// mismatch from a stale tab post-redeploy) with a "Reload" CTA. The
// root-cause fix is the stable NEXT_SERVER_ACTIONS_ENCRYPTION_KEY
// build-time env var; this boundary catches the residual edge cases
// (action source code changes, tabs opened before the key was first
// set, etc.).

import { useEffect } from "react";

export default function AdminError({
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
    console.error("[admin error boundary]", error);
    if (isStaleAction) {
      const idMatch = error.message.match(/Server Action "([^"]+)"/);
      if (idMatch) {
        console.warn(
          "[admin error boundary] stale server-action id:",
          idMatch[1]
        );
      }
    }
  }, [error, isStaleAction]);

  if (isStaleAction) {
    return (
      <section className="mx-auto w-full max-w-[640px] px-5 py-12">
        <h1 className="mb-2 text-xl font-bold text-splash-navy">
          App was updated
        </h1>
        <p className="mb-5 text-sm text-splash-navy/70">
          This page was loaded before the latest deploy. Reload to pick
          up the new version — your last action wasn&apos;t saved.
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
        Something went wrong
      </h1>
      <p className="mb-5 text-sm text-splash-navy/70">
        {error.message || "An unexpected error occurred."}
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
