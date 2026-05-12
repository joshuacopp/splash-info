// Brief 109 — JotForm admin no-access card.
//
// Renders on the index page when a caller lacks admin-tier access
// (super_admin role OR dcRole admin/super_admin). Mirrors the
// /admin/forms NoAccessCard (Brief 95). Per-form URLs at
// /admin/jotform/{form_id} are still navigable for RM / RD / GM users
// — the worker scopes their rows automatically via
// accessibleSiteNumbersForSession (Brief 107).

import Link from "next/link";

interface Props {
  reason: "signin" | "forbidden";
  returnPath?: string;
}

export default function NoAccessCard({ reason, returnPath }: Props) {
  return (
    <section className="mx-auto w-full max-w-[720px] px-5 py-9">
      <div className="mb-6">
        <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-sudsy-blue">
          Internal Tools
        </p>
        <h1 className="text-2xl font-bold text-splash-navy">JotForm</h1>
      </div>

      <div className="rounded-splash-lg border-[1.5px] border-gray-light bg-white p-7 shadow-splash-card">
        {reason === "signin" ? (
          <>
            <p className="mb-3 text-base font-semibold text-splash-navy">
              Sign in required.
            </p>
            <p className="mb-5 text-[0.9375rem] leading-relaxed text-splash-navy/80">
              JotForm submissions are restricted. Sign in to continue.
            </p>
            <Link
              href={`/login?return=${encodeURIComponent(returnPath ?? "/admin/jotform")}`}
              className="inline-flex items-center gap-1.5 rounded-splash-sm bg-splash-blue px-5 py-2.5 text-sm font-bold text-white shadow-splash-btn transition-colors hover:bg-splash-blue-dark"
            >
              Sign In
            </Link>
          </>
        ) : (
          <>
            <p className="mb-3 text-base font-semibold text-splash-navy">
              Access denied.
            </p>
            <p className="mb-5 text-[0.9375rem] leading-relaxed text-splash-navy/80">
              The JotForm index requires super_admin or admin. RM / RD / GM
              users can still open a per-form view by direct link — your
              submissions are scoped automatically. Contact a super_admin if
              you need broader access.
            </p>
            <Link
              href="/admin/dashboard"
              className="inline-flex items-center gap-1.5 rounded-splash-sm bg-splash-blue px-5 py-2.5 text-sm font-bold text-white shadow-splash-btn transition-colors hover:bg-splash-blue-dark"
            >
              Back to Dashboard
            </Link>
          </>
        )}
      </div>
    </section>
  );
}
