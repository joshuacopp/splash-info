// Brief 109 / Brief 151 — JotForm admin sign-in card.
//
// Renders on every /admin/jotform/* page when the caller is unauthenticated.
// Brief 151 widened all three jotform routes to any-session (the index,
// the per-form list, and the per-submission detail), so the prior
// admin-tier "forbidden" branch became unreachable and was removed.
// Per-row scoping is enforced server-side via
// accessibleSiteNumbersForSession (Brief 107) — a signed-in user with no
// matching locations sees a friendly empty-state on the index instead
// of this card.

import Link from "next/link";

interface Props {
  returnPath?: string;
}

export default function NoAccessCard({ returnPath }: Props) {
  return (
    <section className="mx-auto w-full max-w-[720px] px-5 py-9">
      <div className="mb-6">
        <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-sudsy-blue">
          Internal Tools
        </p>
        <h1 className="text-2xl font-bold text-splash-navy">JotForm</h1>
      </div>

      <div className="rounded-splash-lg border-[1.5px] border-gray-light bg-white p-7 shadow-splash-card">
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
      </div>
    </section>
  );
}
