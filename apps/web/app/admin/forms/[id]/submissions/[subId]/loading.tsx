// Brief 131 — Next.js loading boundary for the submission detail page.
//
// Next renders this immediately on client-side nav to
// /admin/forms/[id]/submissions/[subId]; it stays visible until the
// server component's SSR fetches (submission + version schema + R2
// HEADs for signatures + form metadata) complete. Total cold load is
// ~5–10s in practice — without this boundary the operator sees a
// blank tab and wonders if the Review button registered.

export default function LoadingSubmissionDetail() {
  return (
    <section className="mx-auto w-full max-w-[820px] px-5 py-9">
      <div className="mb-2 h-4 w-32 animate-pulse rounded bg-gray-light" />

      <div className="mb-5 h-9 w-full animate-pulse rounded-splash-md bg-gray-light/70" />

      <div className="mb-5 flex flex-wrap items-baseline justify-between gap-3">
        <div className="space-y-2">
          <div className="h-3 w-24 animate-pulse rounded bg-gray-light" />
          <div className="h-7 w-64 animate-pulse rounded bg-gray-light" />
          <div className="h-4 w-48 animate-pulse rounded bg-gray-light/70" />
        </div>
        <div className="h-6 w-20 animate-pulse rounded-full bg-gray-light" />
      </div>

      <SkeletonBlock heading="Status & Splash Notes" rows={3} />
      <SkeletonBlock heading="Workflow" rows={4} />
      <SkeletonBlock heading="Form payload" rows={6} />
      <SkeletonBlock heading="Metadata" rows={5} />
    </section>
  );
}

function SkeletonBlock({
  heading,
  rows
}: {
  heading: string;
  rows: number;
}) {
  return (
    <section
      className="mb-6 rounded-md border border-gray-light bg-white p-5"
      aria-busy="true"
      aria-label={`${heading} (loading)`}
    >
      <div className="mb-3 h-5 w-40 animate-pulse rounded bg-gray-light" />
      <div className="space-y-2">
        {Array.from({ length: rows }).map((_, i) => (
          <div
            key={i}
            className="h-4 w-full animate-pulse rounded bg-gray-light/60"
            style={{ width: `${100 - ((i * 17) % 35)}%` }}
          />
        ))}
      </div>
    </section>
  );
}
