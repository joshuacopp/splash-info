import Link from "next/link";

/** Shown instead of the tracker to anyone without the `it_issues` grant. */
export function BetaGate() {
  return (
    <section className="mx-auto w-full max-w-[640px] px-5 py-16 text-center">
      <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-sudsy-blue">Beta</p>
      <h1 className="mb-2 text-2xl font-bold text-splash-navy">IT Issue Tracker</h1>
      <p className="mb-5 text-splash-navy/70">
        The IT Issue Tracker is being tested with a few sites before it opens up. If your site should be part of the
        test, ask a super admin to give you access.
      </p>
      <Link href="/admin/dashboard" className="font-semibold text-splash-blue hover:underline">
        Back to the dashboard
      </Link>
    </section>
  );
}
