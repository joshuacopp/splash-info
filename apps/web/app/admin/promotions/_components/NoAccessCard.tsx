// Brief 158a — no-access placeholder for /admin/promotions/* pages.
//
// Renders when:
//   reason === "signin"     — no session cookie
//   reason === "no-promo-role" — session present but `promoRole === null`
//   reason === "it-only"    — session has promoRole but page is IT-only
//                              and caller is marketing/ops
//
// Mirrors `apps/web/app/admin/forms/_components/NoAccessCard.tsx` (Brief 95).

import Link from "next/link";

interface Props {
  reason: "signin" | "no-promo-role" | "it-only";
  returnPath?: string;
}

export default function NoAccessCard({ reason, returnPath }: Props) {
  return (
    <section className="mx-auto w-full max-w-[720px] px-5 py-9">
      <div className="mb-6">
        <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-sudsy-blue">
          Internal Tools
        </p>
        <h1 className="text-2xl font-bold text-splash-navy">Promotions</h1>
      </div>

      <div className="rounded-splash-lg border-[1.5px] border-gray-light bg-white p-7 shadow-splash-card">
        {reason === "signin" && (
          <>
            <p className="mb-3 text-base font-semibold text-splash-navy">
              Sign in required.
            </p>
            <p className="mb-5 text-[0.9375rem] leading-relaxed text-splash-navy/80">
              Promotions access is restricted. Sign in to continue.
            </p>
            <Link
              href={`/login?return=${encodeURIComponent(returnPath ?? "/admin/promotions")}`}
              className="inline-flex items-center gap-1.5 rounded-splash-sm bg-splash-blue px-5 py-2.5 text-sm font-bold text-white shadow-splash-btn transition-colors hover:bg-splash-blue-dark"
            >
              Sign In
            </Link>
          </>
        )}
        {reason === "no-promo-role" && (
          <>
            <p className="mb-3 text-base font-semibold text-splash-navy">
              No promotions access.
            </p>
            <p className="mb-5 text-[0.9375rem] leading-relaxed text-splash-navy/80">
              The Promotions tool requires a promo role (super_admin, it,
              marketing, or ops). Contact a super_admin to request access.
            </p>
            <Link
              href="/admin/dashboard"
              className="inline-flex items-center gap-1.5 rounded-splash-sm bg-splash-blue px-5 py-2.5 text-sm font-bold text-white shadow-splash-btn transition-colors hover:bg-splash-blue-dark"
            >
              Back to Dashboard
            </Link>
          </>
        )}
        {reason === "it-only" && (
          <>
            <p className="mb-3 text-base font-semibold text-splash-navy">
              IT only.
            </p>
            <p className="mb-5 text-[0.9375rem] leading-relaxed text-splash-navy/80">
              This view is restricted to IT and super_admin. Try the
              promotions dashboard instead.
            </p>
            <Link
              href="/admin/promotions"
              className="inline-flex items-center gap-1.5 rounded-splash-sm bg-splash-blue px-5 py-2.5 text-sm font-bold text-white shadow-splash-btn transition-colors hover:bg-splash-blue-dark"
            >
              Back to Promotions
            </Link>
          </>
        )}
      </div>
    </section>
  );
}
