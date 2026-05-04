// /admin/sysadmin gate cards. Two render variants:
//
//   reason="signin"    — caller has no session (or worker returned 401/403).
//                        Renders a Sign In button targeting /login?return=...
//                        so the user lands back here after auth.
//
//   reason="forbidden" — caller IS authenticated but session.role !== super_admin.
//                        No Sign In button (signing in won't change the role).
//                        Renders explanatory text only.
//
// Brief 7's gate has two distinct shapes; the Brief 11 pricing pages have
// one shape each (Sign In only). Per Brief 7 §scope.4, this component is
// scoped to /admin/sysadmin — don't refactor the existing damage/pricing
// no-access cards onto it.

import Link from "next/link";

interface NoAccessCardProps {
  reason: "signin" | "forbidden";
  /** Required for reason="signin"; ignored for "forbidden". */
  returnPath?: string;
}

export function NoAccessCard({ reason, returnPath }: NoAccessCardProps) {
  return (
    <section className="mx-auto w-full max-w-[720px] px-5 py-9">
      <div className="mb-6">
        <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-sudsy-blue">
          Internal Tools
        </p>
        <h1 className="text-2xl font-bold text-splash-navy">System Admin</h1>
      </div>

      <div className="rounded-splash-lg border-[1.5px] border-gray-light bg-white p-7 shadow-splash-card">
        {reason === "signin" ? (
          <>
            <p className="mb-3 text-base font-semibold text-splash-navy">
              Sign in required.
            </p>
            <p className="mb-5 text-[0.9375rem] leading-relaxed text-splash-navy/80">
              Sysadmin operations are restricted to super-admins. Sign in to
              continue.
            </p>
            <Link
              href={`/login?return=${encodeURIComponent(
                returnPath ?? "/admin/sysadmin"
              )}`}
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
              Sysadmin operations are super-admin only. Contact a super-admin
              if you need access.
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
