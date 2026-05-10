// Brief 95 — Forms admin no-access card.
//
// Renders when a caller hits /admin/forms/* without
// session.role === "super_admin" OR session.dcRole === "admin"|"super_admin".
// Same posture as fleet (Brief 83).

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
        <h1 className="text-2xl font-bold text-splash-navy">Forms</h1>
      </div>

      <div className="rounded-splash-lg border-[1.5px] border-gray-light bg-white p-7 shadow-splash-card">
        {reason === "signin" ? (
          <>
            <p className="mb-3 text-base font-semibold text-splash-navy">
              Sign in required.
            </p>
            <p className="mb-5 text-[0.9375rem] leading-relaxed text-splash-navy/80">
              Form builder access is restricted. Sign in to continue.
            </p>
            <Link
              href={`/login?return=${encodeURIComponent(returnPath ?? "/admin/forms")}`}
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
              Form builder access requires super_admin or admin. Contact a
              super_admin if you need access.
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
