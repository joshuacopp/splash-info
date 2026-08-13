"use client";

// Client form for /change-password. POSTs to dashboard-worker's
// /api/forced-reset (same-origin post-cutover; cross-origin via the
// NEXT_PUBLIC_DASHBOARD_WORKER_URL env var in dev).
//
// Validates client-side (length + match) before submitting. Worker re-checks
// server-side, so client validation is UX, not security.

import { useState, type FormEvent } from "react";
import PasswordInput from "../_components/PasswordInput";
import PasswordRequirements from "./_components/PasswordRequirements";
import PasswordMatchHint from "./_components/PasswordMatchHint";
import { isPolicyMet, PASSWORD_POLICY_MESSAGE } from "./_lib/password-rules";

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
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const meetsPolicy = isPolicyMet(password);
  const matches = password === confirmPassword;
  const submitDisabled = submitting || !meetsPolicy || !matches;

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);

    if (!meetsPolicy) {
      setError(PASSWORD_POLICY_MESSAGE);
      return;
    }
    if (!matches) {
      setError("Passwords do not match");
      return;
    }

    setSubmitting(true);
    try {
      // x-www-form-urlencoded matches the dashboard-worker's readForm
      // primary content-type branch (same as /api/login).
      const body = new URLSearchParams();
      body.set("new_password", password);
      body.set("confirm_password", confirmPassword);
      body.set("next", next || DEFAULT_AUTHED_LANDING);

      const r = await fetch("/api/forced-reset", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        credentials: "include"
      });

      // The worker returns 302 on success; fetch follows transparently and
      // the worker attaches fresh Set-Cookie headers (Brief 147) so the
      // browser commits the new sb-access-token / sb-refresh-token before
      // we navigate. We always navigate to the apps/web destination
      // ourselves rather than r.url so cross-origin dev (r.url ends on
      // workers.dev) still lands at the right apps/web path.
      //
      // window.location.assign (vs router.push) forces a full browser
      // navigation — Safari iOS only commits the freshly-Set-Cookie'd
      // session to subsequent requests on a real navigation boundary,
      // not on a client-side route transition.
      if (r.ok || r.redirected) {
        window.location.assign(next || DEFAULT_AUTHED_LANDING);
        return;
      }
      if (r.status === 401) {
        // Cookie expired between login and this submit — bounce to /login
        // with the change-password URL preserved as the return target.
        const requiredFlag = required ? "true" : "false";
        const cpUrl = `/change-password?required=${requiredFlag}&next=${encodeURIComponent(next || DEFAULT_AUTHED_LANDING)}`;
        window.location.assign(`/login?return=${encodeURIComponent(cpUrl)}`);
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
    <section className="mx-auto my-16 max-w-md px-6 text-splash-navy">
      <h1 className="mb-2 text-2xl font-bold">Change Password</h1>
      {required ? (
        <p className="mt-0 mb-4 text-sm text-splash-deny">
          Your account requires a password change before continuing.
        </p>
      ) : (
        <p className="mt-0 mb-4 text-sm text-gray-dark">
          Enter a new password for your account.
        </p>
      )}
      <form onSubmit={onSubmit}>
        <div className="mb-3">
          <label htmlFor="new-password" className="mb-1 block text-sm font-semibold">
            New Password
          </label>
          <PasswordInput
            id="new-password"
            value={password}
            onChange={setPassword}
            required
            autoFocus
            autoComplete="new-password"
            describedBy="password-requirements"
          />
          <PasswordRequirements password={password} />
        </div>
        <div className="mb-4">
          <label htmlFor="confirm-password" className="mb-1 block text-sm font-semibold">
            Confirm Password
          </label>
          <PasswordInput
            id="confirm-password"
            value={confirmPassword}
            onChange={setConfirmPassword}
            required
            autoComplete="new-password"
          />
          <PasswordMatchHint password={password} confirm={confirmPassword} />
        </div>
        {error ? (
          <p
            role="alert"
            className="mb-3 rounded-splash-sm border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-splash-deny"
          >
            {error}
          </p>
        ) : null}
        <button
          type="submit"
          disabled={submitDisabled}
          className="h-11 w-full rounded-splash-sm bg-splash-blue font-bold text-white shadow-splash-btn transition-colors hover:bg-splash-blue-dark disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting ? "Updating…" : "Change Password"}
        </button>
      </form>
    </section>
  );
}
