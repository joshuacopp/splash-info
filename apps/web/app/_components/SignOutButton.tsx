"use client";

// "Sign Out" button — POSTs to dashboard-worker:/api/logout and navigates
// to /login on success.
//
// Per Brief 2: this is the primary logout path, going straight to the
// worker that owns the auth contract. The /logout route in apps/web exists
// for the legacy /admin/logout 308 redirect target, not as the button's
// destination.
//
// Error handling:
//   - 200 / redirect → navigate to /login
//   - non-2xx        → show inline error, don't navigate (the user can
//                      retry or pick a different exit)
//   - network error  → same as non-2xx
//
// credentials: "include" matches the login + change-password flows — needed
// cross-origin in dev so the cookie gets attached to the worker call;
// harmless same-origin in production.

import { useState } from "react";

// Sign Out posts to /api/logout as a same-origin path. Production: apps/web
// and dashboard-worker share splashcarwashes.info. Dev: apps/web/next.config.mjs
// rewrites proxy /api/logout -> dashboard-worker's workers.dev URL. Either
// way the Set-Cookie clear lands on the same origin the cookie was set on.

export function SignOutButton() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    setError(null);
    setBusy(true);
    try {
      const r = await fetch("/api/logout", {
        method: "POST",
        credentials: "include"
      });
      if (r.ok || r.redirected) {
        window.location.href = "/login";
        return;
      }
      setError(`Sign out failed (${r.status})`);
      setBusy(false);
    } catch {
      setError("Sign out failed");
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-3">
      {error ? (
        <span
          role="alert"
          className="text-sm font-medium text-yellow"
          aria-live="polite"
        >
          {error}
        </span>
      ) : null}
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        className="rounded-splash-sm bg-white/15 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-white/25 disabled:cursor-wait disabled:opacity-70"
      >
        {busy ? "Signing out…" : "Sign Out"}
      </button>
    </div>
  );
}
