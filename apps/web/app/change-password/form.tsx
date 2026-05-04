"use client";

// Client form for /change-password. POSTs to dashboard-worker's
// /api/forced-reset (same-origin post-cutover; cross-origin via the
// NEXT_PUBLIC_DASHBOARD_WORKER_URL env var in dev).
//
// Validates client-side (length + match) before submitting. Worker re-checks
// server-side, so client validation is UX, not security.

import { useState, type FormEvent } from "react";

// Forced-reset posts to /api/forced-reset as a same-origin path. Production:
// apps/web and dashboard-worker share splashcarwashes.info. Dev: apps/web's
// next.config.mjs rewrites proxy /api/forced-reset -> dashboard-worker's
// workers.dev URL.

const DEFAULT_AUTHED_LANDING = "/admin/dashboard";

export interface ChangePasswordFormProps {
  /** Set when the user is on the forced-reset path (must_change_password === true). */
  required: boolean;
  /** Sanitized redirect target the worker computed at login time. */
  next: string;
}

export function ChangePasswordForm({ required, next }: ChangePasswordFormProps) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);

    if (password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match");
      return;
    }

    setSubmitting(true);
    try {
      // x-www-form-urlencoded matches the dashboard-worker's readForm
      // primary content-type branch (same as /api/login).
      const body = new URLSearchParams();
      body.set("new_password", password);
      body.set("confirm_password", confirm);
      body.set("next", next || DEFAULT_AUTHED_LANDING);

      const r = await fetch("/api/forced-reset", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        credentials: "include"
      });

      // The worker returns 302 on success; fetch follows transparently.
      // We always navigate to the apps/web destination ourselves rather
      // than r.url so cross-origin dev (r.url ends on workers.dev) still
      // lands at the right apps/web path.
      if (r.ok || r.redirected) {
        window.location.href = next || DEFAULT_AUTHED_LANDING;
        return;
      }
      if (r.status === 401) {
        // Cookie expired between login and this submit — bounce to /login
        // with the change-password URL preserved as the return target.
        const requiredFlag = required ? "true" : "false";
        const cpUrl = `/change-password?required=${requiredFlag}&next=${encodeURIComponent(next || DEFAULT_AUTHED_LANDING)}`;
        window.location.href = `/login?return=${encodeURIComponent(cpUrl)}`;
        return;
      }
      const errBody = (await r.json().catch(() => ({}))) as { error?: string };
      setError(errBody.error ?? `Reset failed (${r.status})`);
      setSubmitting(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      setSubmitting(false);
    }
  };

  return (
    <section style={{ padding: 24, maxWidth: 480, margin: "60px auto", color: "#1c164e" }}>
      <h1 style={{ marginBottom: 8 }}>Change Password</h1>
      {required ? (
        <p style={{ color: "#dc2626", marginTop: 0, marginBottom: 16 }}>
          Your account requires a password change before continuing.
        </p>
      ) : (
        <p style={{ color: "#6b7280", marginTop: 0, marginBottom: 16 }}>
          Enter a new password for your account.
        </p>
      )}
      <form onSubmit={onSubmit}>
        <label style={{ display: "block", marginBottom: 12 }}>
          <span style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>New Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
            autoFocus
            autoComplete="new-password"
            style={{ width: "100%", padding: "8px 12px", height: 40, border: "1.5px solid #dbdbdb", borderRadius: 6 }}
          />
        </label>
        <label style={{ display: "block", marginBottom: 16 }}>
          <span style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>Confirm Password</span>
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
            minLength={8}
            autoComplete="new-password"
            style={{ width: "100%", padding: "8px 12px", height: 40, border: "1.5px solid #dbdbdb", borderRadius: 6 }}
          />
        </label>
        {error ? (
          <p role="alert" style={{ color: "#dc2626", marginTop: 0, marginBottom: 12 }}>
            {error}
          </p>
        ) : null}
        <button
          type="submit"
          disabled={submitting}
          style={{
            width: "100%",
            height: 44,
            background: "#2b3491",
            color: "white",
            border: "none",
            borderRadius: 6,
            fontWeight: 700,
            cursor: submitting ? "wait" : "pointer"
          }}
        >
          {submitting ? "Updating…" : "Change Password"}
        </button>
      </form>
    </section>
  );
}
