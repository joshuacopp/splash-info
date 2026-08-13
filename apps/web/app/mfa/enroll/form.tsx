"use client";

// Client form for /mfa/enroll. Two-phase:
//
//   Phase 1 (start): POST /api/mfa/enroll → creates an UNVERIFIED factor and
//     returns { factorId, qrCode (inline SVG), secret, uri }. We render the QR
//     for the user to scan (or the base32 secret for manual entry).
//   Phase 2 (confirm): user types the 6-digit code their app shows; POST
//     /api/mfa/enroll/verify { factor_id, code } → GoTrue activates the factor
//     and returns a new AAL2 token pair, which the worker sets as cookies. On
//     success we navigate to `next`.
//
// Same-origin in prod (apps/web + dashboard-worker share splashcarwashes.info);
// dev proxies /api/mfa/* to the worker via next.config.mjs rewrites.
//
// The "Start" button is explicit rather than auto-firing on mount: each enroll
// call creates a new unverified factor, and GoTrue caps at 10 per user, so we
// avoid piling up throwaway factors on stray page loads/refreshes.

import { useState, type FormEvent } from "react";

const CODE_LENGTH = 6;

export interface EnrollMfaFormProps {
  /** Where to land after the factor is verified. */
  next: string;
}

interface EnrollData {
  factorId: string;
  /** Inline SVG markup for the QR — render directly. */
  qrCode: string;
  /** Base32 seed for manual entry when a camera isn't available. */
  secret: string;
  uri: string;
}

export function EnrollMfaForm({ next }: EnrollMfaFormProps) {
  const [enroll, setEnroll] = useState<EnrollData | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [verifying, setVerifying] = useState(false);

  const codeValid = /^\d{6}$/.test(code);

  const startEnrollment = async () => {
    setError(null);
    setStarting(true);
    try {
      const r = await fetch("/api/mfa/enroll", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "",
        credentials: "include"
      });
      if (r.status === 401) {
        window.location.assign(`/login?return=${encodeURIComponent("/mfa/enroll")}`);
        return;
      }
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { error?: string };
        setError(b.error ?? `Could not start setup (${r.status})`);
        setStarting(false);
        return;
      }
      const data = (await r.json()) as EnrollData;
      setEnroll(data);
      setStarting(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      setStarting(false);
    }
  };

  const onConfirm = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    if (!enroll || !codeValid) {
      setError("Enter the 6-digit code from your authenticator app.");
      return;
    }

    setVerifying(true);
    try {
      const body = new URLSearchParams();
      body.set("factor_id", enroll.factorId);
      body.set("code", code);

      const r = await fetch("/api/mfa/enroll/verify", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        credentials: "include"
      });

      if (r.ok) {
        // Full navigation (not router.push) so the freshly-Set-Cookie'd AAL2
        // session commits before the next request — same reason as the
        // change-password flow's window.location.assign.
        window.location.assign(next);
        return;
      }
      if (r.status === 401) {
        window.location.assign(`/login?return=${encodeURIComponent("/mfa/enroll")}`);
        return;
      }
      const b = (await r.json().catch(() => ({}))) as { error?: string };
      setError(b.error ?? `Verification failed (${r.status})`);
      setVerifying(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      setVerifying(false);
    }
  };

  return (
    <section className="mx-auto my-16 max-w-md px-6 text-splash-navy">
      <h1 className="mb-2 text-2xl font-bold">Set Up Two-Factor Authentication</h1>
      <p className="mt-0 mb-4 text-sm text-gray-dark">
        Add a second layer of protection with an authenticator app (Google
        Authenticator, 1Password, Authy, etc.).
      </p>

      {!enroll ? (
        <>
          <p className="mb-4 text-sm text-gray-dark">
            Click below to generate a QR code, then scan it with your
            authenticator app.
          </p>
          {error ? (
            <p
              role="alert"
              className="mb-3 rounded-splash-sm border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-splash-deny"
            >
              {error}
            </p>
          ) : null}
          <button
            type="button"
            onClick={startEnrollment}
            disabled={starting}
            className="h-11 w-full rounded-splash-sm bg-splash-blue font-bold text-white shadow-splash-btn transition-colors hover:bg-splash-blue-dark disabled:cursor-not-allowed disabled:opacity-60"
          >
            {starting ? "Generating…" : "Set Up Authenticator"}
          </button>
        </>
      ) : (
        <>
          <ol className="mb-4 list-decimal space-y-1 pl-5 text-sm text-gray-dark">
            <li>Scan the QR code with your authenticator app.</li>
            <li>Enter the 6-digit code it shows to confirm.</li>
          </ol>

          {/* White background + generous padding = the QR "quiet zone" the
              spec requires for reliable scanning. GoTrue returns inline SVG. */}
          <div
            className="mx-auto mb-3 flex h-72 w-72 items-center justify-center rounded-splash-sm border border-gray-200 bg-white p-4 [&>svg]:h-full [&>svg]:w-full [&>svg]:[shape-rendering:crispEdges]"
            aria-label="Authenticator QR code"
            dangerouslySetInnerHTML={{ __html: enroll.qrCode }}
          />

          <details className="mb-4 text-sm text-gray-dark">
            <summary className="cursor-pointer select-none font-semibold">
              Can&apos;t scan? Enter the key manually
            </summary>
            <code className="mt-2 block break-all rounded-splash-sm bg-gray-50 px-3 py-2 font-mono text-xs">
              {enroll.secret}
            </code>
          </details>

          <form onSubmit={onConfirm}>
            <label htmlFor="totp-code" className="mb-1 block text-sm font-semibold">
              6-Digit Code
            </label>
            <input
              id="totp-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              maxLength={CODE_LENGTH}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              className="mb-3 h-11 w-full rounded-splash-sm border border-gray-300 px-3 text-center text-lg tracking-[0.5em] focus:border-splash-blue focus:outline-none"
              placeholder="000000"
            />
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
              disabled={verifying || !codeValid}
              className="h-11 w-full rounded-splash-sm bg-splash-blue font-bold text-white shadow-splash-btn transition-colors hover:bg-splash-blue-dark disabled:cursor-not-allowed disabled:opacity-60"
            >
              {verifying ? "Verifying…" : "Confirm & Enable"}
            </button>
          </form>
        </>
      )}
    </section>
  );
}
