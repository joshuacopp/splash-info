// Brief 148 — SCORM Builder no-access card. Sibling of /admin/forms's
// NoAccessCard, retitled so the unauthorized state surfaces the right
// product name. Same visual posture as the forms variant.

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
          Training
        </p>
        <h1 className="text-2xl font-bold text-splash-navy">SCORM Package Builder</h1>
      </div>

      <div className="rounded-splash-lg border-[1.5px] border-gray-light bg-white p-7 shadow-splash-card">
        {reason === "signin" ? (
          <>
            <p className="mb-3 text-base font-semibold text-splash-navy">
              Sign in required.
            </p>
            <p className="mb-5 text-[0.9375rem] leading-relaxed text-splash-navy/80">
              SCORM Package Builder access is restricted. Sign in to continue.
            </p>
            <Link
              href={`/login?return=${encodeURIComponent(returnPath ?? "/admin/scorm-builder")}`}
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
              SCORM Package Builder access requires super_admin or admin. Contact a
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
