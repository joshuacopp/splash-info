"use client";

// "View as user" -- start impersonating someone. super_admin only, like the
// rest of this page; the worker re-checks (super_admin, aal2, target not a
// super_admin) and authenticate() re-checks all of it on every later request.
//
// Posts straight to /sysadmin/api/impersonation/start rather than through a
// server action: the response sets the sb-impersonate cookie, and a cookie
// set on a service-binding response never reaches the browser. Same-origin in
// production; the browser supplies Origin for the worker's CSRF gate.
//
// Default mode is VIEW. Act mode can be chosen here or switched to later from
// the banner, and needs a reason either way (the start reason covers it here).

import { useState } from "react";
import { FieldLabel, inputClass, submitClass } from "./OperationCard";
import { UserPicker } from "./UserPicker";

export function ViewAsCard() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/sysadmin/api/impersonation/start", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: fd.get("user_id"),
          mode: fd.get("mode"),
          reason: fd.get("reason")
        })
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => null)) as { error?: string } | null;
        setError(j?.error ?? `Couldn't start (${r.status}).`);
        return;
      }
      // Full navigation: every server render must re-run as the target.
      window.location.assign("/admin/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't start.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div>
        <FieldLabel htmlFor="view-as-user" helper="Search by email">
          User
        </FieldLabel>
        <UserPicker name="user_id" inputId="view-as-user" required />
      </div>

      <fieldset>
        <legend className="mb-1 text-xs font-semibold uppercase tracking-wider text-splash-navy/70">
          Mode
        </legend>
        <label className="flex items-start gap-2 text-sm text-splash-navy">
          <input type="radio" name="mode" value="view" defaultChecked className="mt-1" />
          <span>
            <strong>View only</strong> &mdash; see exactly what they see. Every save, submit
            and approve is refused.
          </span>
        </label>
        <label className="mt-1 flex items-start gap-2 text-sm text-splash-navy">
          <input type="radio" name="mode" value="act" className="mt-1" />
          <span>
            <strong>Act as them</strong> &mdash; changes are made and recorded{" "}
            <em>under their name</em>, including any emails they trigger. Each request is
            logged against you.
          </span>
        </label>
      </fieldset>

      <div>
        <FieldLabel htmlFor="view-as-reason" helper="Required, kept in the audit log">
          Reason
        </FieldLabel>
        <input
          id="view-as-reason"
          name="reason"
          required
          maxLength={500}
          autoComplete="off"
          className={inputClass}
          placeholder="e.g. Bill can't see Vestal's claims"
        />
      </div>

      <p className="text-[0.6875rem] text-splash-navy/55">
        Lasts one hour. Needs a two-factor sign-in. Super admins can&rsquo;t be viewed as.
        The person is not notified; every start, mode change and stop is in the activity
        log below.
      </p>

      <button type="submit" disabled={busy} className={submitClass}>
        {busy ? "Starting…" : "View as user"}
      </button>
      {error ? (
        <p
          role="alert"
          className="rounded-splash-sm border border-splash-deny/40 bg-splash-deny/10 px-3 py-2 text-sm font-medium text-splash-deny"
        >
          {error}
        </p>
      ) : null}
    </form>
  );
}
