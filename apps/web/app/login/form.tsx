"use client";

// Login form — POSTs to dashboard-worker's /api/login.
//
// Wire format: application/x-www-form-urlencoded with `email`, `password`,
// and `redirect` fields (matches dashboard-worker's readForm helper).
//
// Response handling:
//   - r.ok || r.redirected:
//        - if r.url contains "/change-password" → forced-reset path, navigate
//          to apps/web's /change-password?required=true&next=<returnPath>
//        - else → success, navigate to returnPath
//   - r.status === 401: bad creds → inline error matching the worker's
//                                    "Invalid email or password" wording
//   - 403: rare "no_permissions_assigned" path → inline error
//   - 5xx / network: generic "Something went wrong, try again"
//
// credentials: "include" ensures the Set-Cookie response is honored
// (mandatory cross-origin in dev; harmless same-origin post-cutover).

import { useState, type FormEvent } from "react";
import PasswordInput from "../_components/PasswordInput";

// Login posts to /api/login as a same-origin path. In production, apps/web
// and dashboard-worker share splashcarwashes.info so the browser sends the
// POST directly to the worker. In dev, apps/web/next.config.mjs rewrites
// transparently proxy /api/login -> NEXT_PUBLIC_DASHBOARD_WORKER_URL/api/login,
// which means the Set-Cookie response lands on localhost origin and the
// session cookie is usable for subsequent /admin/* navigation. No more
// cross-origin cookie wall in dev.

export interface LoginFormProps {
  /** Sanitized same-origin path the user came from (defaults to /admin/dashboard). */
  returnPath: string;
}

export function LoginForm({ returnPath }: LoginFormProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);

    if (!email.trim() || !password) {
      setError("Email and password are required.");
      return;
    }

    setSubmitting(true);
    try {
      const body = new URLSearchParams();
      body.set("email", email.trim());
      body.set("password", password);
      body.set("redirect", returnPath);

      const r = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        credentials: "include"
      });

      // Success path: dashboard-worker returns 302 (followed transparently
      // by fetch). r.redirected → true; r.url ends with the worker's
      // Location header target. We detect must_change_password by URL
      // suffix rather than parsing Location, which is opaque cross-origin.
      if (r.ok || r.redirected) {
        if (r.url.includes("/change-password")) {
          // Forced-reset path. The worker's redirect target carries
          // `?required=true&next=<safeNext>`. We re-emit that on apps/web's
          // own /change-password page (which lives at the same path under
          // apps/web post-cutover; in dev it's where the user lands after
          // the bare cross-origin follow).
          window.location.href = `/change-password?required=true&next=${encodeURIComponent(returnPath)}`;
          return;
        }
        window.location.href = returnPath;
        return;
      }

      if (r.status === 401) {
        setError("Invalid email or password");
        setSubmitting(false);
        return;
      }
      if (r.status === 403) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? "Your account doesn't have access yet. Contact your administrator.");
        setSubmitting(false);
        return;
      }
      setError("Something went wrong, try again");
      setSubmitting(false);
    } catch {
      setError("Something went wrong, try again");
      setSubmitting(false);
    }
  };

  return (
    <section className="mx-auto my-16 max-w-md px-6 text-splash-navy">
      <h1 className="mb-2 text-2xl font-bold">Sign In</h1>
      <p className="mb-6 text-sm text-gray-dark">
        Sign in with your Splash account to continue.
      </p>
      <form onSubmit={onSubmit}>
        <label className="mb-3 block">
          <span className="mb-1 block text-sm font-semibold">Email</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoFocus
            autoComplete="email"
            placeholder="your.name@splashcarwashes.com"
            className="block h-10 w-full rounded-splash-sm border-[1.5px] border-gray-light px-3 text-base outline-none focus:border-splash-blue focus:ring-2 focus:ring-sudsy-blue/30"
          />
        </label>
        <div className="mb-4">
          <label htmlFor="login-password" className="mb-1 block text-sm font-semibold">
            Password
          </label>
          <PasswordInput
            id="login-password"
            value={password}
            onChange={setPassword}
            required
            autoComplete="current-password"
          />
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
          disabled={submitting}
          className="h-11 w-full rounded-splash-sm bg-splash-blue font-bold text-white shadow-splash-btn transition-colors hover:bg-splash-blue-dark disabled:cursor-wait disabled:opacity-70"
        >
          {submitting ? "Signing in…" : "Sign In"}
        </button>
      </form>
    </section>
  );
}
