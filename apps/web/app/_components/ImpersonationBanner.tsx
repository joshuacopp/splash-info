"use client";

// The "you are viewing as someone else" bar. Renders on EVERY page while a
// super_admin is impersonating -- not just admin pages -- because the target
// usually cannot reach /admin/sysadmin, so this is the only Stop button.
//
// Amber in view mode, red in act mode. Act mode is the one where clicking a
// button changes real records under the TARGET's name, so it must be
// impossible to forget you are in it.
//
// Talks straight to /sysadmin/api/impersonation/* (same origin, cookie and
// Origin header sent by the browser), then hard-reloads: every server render
// has to re-run against the new identity, which router.refresh() would leave
// half-done in client state.

import { useState } from "react";
import type { ImpersonationInfo } from "@splash/types/session";

export function ImpersonationBanner({
  impersonation,
  targetEmail
}: {
  impersonation: ImpersonationInfo;
  targetEmail: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [askingReason, setAskingReason] = useState(false);
  const [reason, setReason] = useState("");
  const acting = impersonation.mode === "act";
  const until = new Date(impersonation.expiresAt).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit"
  });

  async function post(path: string, body?: unknown): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(path, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body ?? {})
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => null)) as { error?: string } | null;
        setError(j?.error ?? `Request failed (${r.status}).`);
        return false;
      }
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    if (await post("/sysadmin/api/impersonation/stop")) {
      window.location.assign("/admin/sysadmin");
    }
  }

  async function switchMode(mode: "view" | "act") {
    const ok = await post("/sysadmin/api/impersonation/mode", {
      mode,
      reason: mode === "act" ? reason : "Back to view only"
    });
    if (ok) window.location.reload();
  }

  return (
    <div
      role="alert"
      className={`flex w-full flex-wrap items-center justify-center gap-x-3 gap-y-2 px-6 py-2 text-sm ${
        acting ? "bg-red-600 text-white" : "bg-amber-200 text-amber-950"
      }`}
    >
      <span className="font-semibold">
        {acting ? "Acting as " : "Viewing as "}
        {targetEmail}
      </span>
      <span className={acting ? "text-white/85" : "text-amber-900/80"}>
        {acting
          ? "— changes you make are recorded as them."
          : "— view only; nothing you click can change anything."}{" "}
        Ends {until}.
      </span>

      {askingReason ? (
        <span className="flex flex-wrap items-center gap-2">
          <input
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={500}
            placeholder="Why do you need to act as them?"
            className="h-8 w-64 rounded-splash-sm border border-amber-900/30 bg-white px-2 text-sm text-splash-navy"
          />
          <button
            type="button"
            disabled={busy || reason.trim().length === 0}
            onClick={() => switchMode("act")}
            className="h-8 rounded-splash-sm bg-red-600 px-3 text-sm font-semibold text-white disabled:opacity-50"
          >
            Start acting
          </button>
          <button
            type="button"
            onClick={() => setAskingReason(false)}
            className="text-xs underline underline-offset-2"
          >
            Cancel
          </button>
        </span>
      ) : acting ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => switchMode("view")}
          className="h-8 rounded-splash-sm border border-white/60 px-3 text-sm font-semibold text-white hover:bg-white/10 disabled:opacity-50"
        >
          Back to view only
        </button>
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={() => setAskingReason(true)}
          className="h-8 rounded-splash-sm border border-amber-900/40 px-3 text-sm font-semibold hover:bg-amber-100 disabled:opacity-50"
        >
          Act as them…
        </button>
      )}

      <button
        type="button"
        disabled={busy}
        onClick={stop}
        className={`h-8 rounded-splash-sm px-3 text-sm font-bold disabled:opacity-50 ${
          acting ? "bg-white text-red-700" : "bg-amber-950 text-amber-50"
        }`}
      >
        Stop
      </button>

      {error ? (
        <span className={`w-full text-center text-xs ${acting ? "text-white" : "text-red-700"}`}>
          {error}
        </span>
      ) : null}
    </div>
  );
}
