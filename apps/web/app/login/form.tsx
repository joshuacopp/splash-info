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

import { useEffect, useRef, useState, type FormEvent } from "react";
import PasswordInput from "../_components/PasswordInput";

// Minimal typing for the Turnstile global injected by the CF script.
interface TurnstileApi {
  render: (
    el: HTMLElement,
    opts: {
      sitekey: string;
      callback: (token: string) => void;
      "error-callback"?: () => void;
      "expired-callback"?: () => void;
    }
  ) => string;
  reset: (widgetId?: string) => void;
}
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const TURNSTILE_SRC =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

// Load the Turnstile script once, shared across renders.
let turnstileScriptPromise: Promise<void> | null = null;
function loadTurnstileScript(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (window.turnstile) return Promise.resolve();
  if (turnstileScriptPromise) return turnstileScriptPromise;
  turnstileScriptPromise = new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = TURNSTILE_SRC;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("turnstile_script_failed"));
    document.head.appendChild(s);
  });
  return turnstileScriptPromise;
}

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
  /** Public Turnstile site key. When absent, the widget is skipped (dev). */
  turnstileSiteKey?: string;
}

export function LoginForm({ returnPath, turnstileSiteKey }: LoginFormProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  // MFA step-up state. When the worker's /api/login returns mfa_required, we
  // switch the form to a 6-digit code entry that posts /api/login/mfa. mfaNext
  // is the server-sanitized redirect target to hand back on success.
  const [mfaMode, setMfaMode] = useState(false);
  const [mfaNext, setMfaNext] = useState<string>(returnPath);
  const [code, setCode] = useState("");
  const widgetRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string | null>(null);

  // Render the Turnstile widget once the script + container are ready.
  useEffect(() => {
    if (!turnstileSiteKey || !widgetRef.current) return;
    let cancelled = false;
    loadTurnstileScript()
      .then(() => {
        if (cancelled || !window.turnstile || !widgetRef.current) return;
        // Guard against React strict-mode double-invoke rendering twice.
        if (widgetIdRef.current) return;
        widgetIdRef.current = window.turnstile.render(widgetRef.current, {
          sitekey: turnstileSiteKey,
          callback: (token) => setTurnstileToken(token),
          "error-callback": () => setTurnstileToken(null),
          "expired-callback": () => setTurnstileToken(null)
        });
      })
      .catch(() => {
        // Script failed to load — surface a soft error; user can retry.
        if (!cancelled) setError("Couldn't load the anti-abuse check. Refresh and try again.");
      });
    return () => {
      cancelled = true;
    };
  }, [turnstileSiteKey]);

  const resetTurnstile = () => {
    setTurnstileToken(null);
    if (window.turnstile && widgetIdRef.current) {
      window.turnstile.reset(widgetIdRef.current);
    }
  };

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);

    if (!email.trim() || !password) {
      setError("Email and password are required.");
      return;
    }

    if (turnstileSiteKey && !turnstileToken) {
      setError("Please complete the anti-abuse check.");
      return;
    }

    setSubmitting(true);
    try {
      const body = new URLSearchParams();
      body.set("email", email.trim());
      body.set("password", password);
      body.set("redirect", returnPath);
      if (turnstileToken) body.set("cf-turnstile-response", turnstileToken);

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
      // MFA-gated login: the worker returns a 200 JSON { mfa_required, next }
      // instead of a 302. A normal success is always a followed redirect
      // (r.redirected), so a 200 that did NOT redirect is the MFA signal.
      if (r.ok && !r.redirected) {
        const data = (await r.json().catch(() => null)) as
          | { mfa_required?: boolean; next?: string }
          | null;
        if (data?.mfa_required) {
          setMfaNext(data.next ?? returnPath);
          setMfaMode(true);
          setCode("");
          setSubmitting(false);
          return;
        }
      }

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

      // Any non-success path consumes the single-use Turnstile token, so
      // reset the widget before the user retries.
      if (r.status === 401) {
        resetTurnstile();
        setError("Invalid email or password");
        setSubmitting(false);
        return;
      }
      if (r.status === 429) {
        resetTurnstile();
        setError("Too many attempts. Please wait a few minutes and try again.");
        setSubmitting(false);
        return;
      }
      if (r.status === 403) {
        resetTurnstile();
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? "Your account doesn't have access yet. Contact your administrator.");
        setSubmitting(false);
        return;
      }
      resetTurnstile();
      setError("Something went wrong, try again");
      setSubmitting(false);
    } catch {
      resetTurnstile();
      setError("Something went wrong, try again");
      setSubmitting(false);
    }
  };

  const onSubmitMfa = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);

    const trimmed = code.trim();
    if (!/^\d{6}$/.test(trimmed)) {
      setError("Enter the 6-digit code from your authenticator app.");
      return;
    }

    setSubmitting(true);
    try {
      const body = new URLSearchParams();
      body.set("code", trimmed);
      body.set("next", mfaNext);

      const r = await fetch("/api/login/mfa", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        credentials: "include"
      });

      if (r.ok) {
        const data = (await r.json().catch(() => null)) as { redirect?: string } | null;
        window.location.href = data?.redirect ?? mfaNext;
        return;
      }

      if (r.status === 401) {
        // AAL1 session expired before the code was entered — restart login.
        setError("Your session expired. Please sign in again.");
        setMfaMode(false);
        setPassword("");
        setSubmitting(false);
        resetTurnstile();
        return;
      }
      if (r.status === 429) {
        setError("Too many attempts. Please wait a few minutes and try again.");
        setSubmitting(false);
        return;
      }
      // 400 (bad/expired code) and anything else — re-prompt for the code.
      setError("Invalid or expired code. Please try again.");
      setCode("");
      setSubmitting(false);
    } catch {
      setError("Something went wrong, try again");
      setSubmitting(false);
    }
  };

  if (mfaMode) {
    return (
      <section className="mx-auto my-16 max-w-md px-6 text-splash-navy">
        <h1 className="mb-2 text-2xl font-bold">Two-Factor Authentication</h1>
        <p className="mb-6 text-sm text-gray-dark">
          Enter the 6-digit code from your authenticator app to finish signing in.
        </p>
        <form onSubmit={onSubmitMfa}>
          <label className="mb-4 block">
            <span className="mb-1 block text-sm font-semibold">Authentication code</span>
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="\d{6}"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              required
              autoFocus
              placeholder="123456"
              className="block h-10 w-full rounded-splash-sm border-[1.5px] border-gray-light px-3 text-base tracking-[0.3em] outline-none focus:border-splash-blue focus:ring-2 focus:ring-sudsy-blue/30"
            />
          </label>
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
            {submitting ? "Verifying…" : "Verify"}
          </button>
        </form>
      </section>
    );
  }

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
        {turnstileSiteKey ? (
          <div ref={widgetRef} className="mb-4 min-h-[65px]" aria-label="Anti-abuse check" />
        ) : null}
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
