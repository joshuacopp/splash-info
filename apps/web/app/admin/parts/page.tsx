// Parts (/admin/parts) — index of interactive parts manuals.
//
// The list is derived from the parts bucket itself (see _lib/manuals), so this
// page needs no change when a manual is added — dropping the .html in R2 is
// enough. Auth posture: any authenticated session; middleware gates /admin/*,
// and nothing here is per-location or per-role.

import Link from "next/link";
import {
  listManuals,
  PartsBindingUnavailable,
  type PartsManual
} from "./_lib/manuals";

export const dynamic = "force-dynamic";
export const metadata = { title: "Equipment Manuals" };

export default async function PartsIndexPage() {
  let manuals: PartsManual[];
  let unavailable = false;
  try {
    manuals = await listManuals();
  } catch (err) {
    if (!(err instanceof PartsBindingUnavailable)) throw err;
    manuals = [];
    unavailable = true;
  }

  return (
    <section className="mx-auto w-full max-w-[1100px] px-5 py-9">
      <div className="mb-2 text-sm">
        <Link
          href="/admin/dashboard/operations/mechanical"
          className="text-splash-blue hover:underline"
        >
          ← Mechanical
        </Link>
      </div>

      <div className="mb-6">
        <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-sudsy-blue">
          Reference
        </p>
        <h1 className="text-2xl font-bold text-splash-navy">Equipment Manuals</h1>
        <p className="mt-1 text-sm text-splash-navy/70">
          Interactive parts and maintenance manuals. Search by part number or
          description, or click a numbered callout on the exploded view to pull
          up the part.
        </p>
      </div>

      <Link
        href="/admin/parts/directory"
        className="mb-6 flex items-center justify-between gap-4 rounded-splash-md border-[1.5px] border-splash-blue/40 bg-sudsy-blue-soft/40 px-4 py-3.5 transition hover:border-splash-blue"
      >
        <div>
          <p className="mb-0.5 text-xs font-semibold uppercase tracking-[0.18em] text-sudsy-blue">
            Equipment
          </p>
          <h2 className="text-base font-bold text-splash-navy">
            Parts Directory
          </h2>
          <p className="mt-0.5 text-sm text-splash-navy/70">
            The parts we order most — part number, vendor, cost, and a photo.
            Search across every machine at once.
          </p>
        </div>
        <span
          aria-hidden="true"
          className="shrink-0 text-xl font-bold text-splash-blue"
        >
          →
        </span>
      </Link>

      {unavailable && (
        <p className="mb-5 rounded-splash-md border border-amber-300 bg-amber-50 px-3 py-2 text-amber-900">
          Parts storage isn&apos;t connected in this environment. Run the app
          with <code>wrangler dev</code> (or deploy) to reach the manuals.
        </p>
      )}

      {!unavailable && manuals.length === 0 && (
        <div className="rounded-splash-md border border-gray-light bg-white px-4 py-8 text-center italic text-splash-navy/60">
          No manuals published yet.
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        {manuals.map((manual) => (
          <Link
            key={manual.slug}
            href={`/admin/parts/${manual.slug}`}
            className="block overflow-hidden rounded-splash-md border-[1.5px] border-splash-navy/15 bg-white shadow-splash-card transition hover:border-splash-blue/50"
          >
            <div className="border-b border-splash-navy/10 bg-splash-navy/5 px-4 py-2.5">
              {manual.model && (
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-sudsy-blue">
                  {manual.model}
                </p>
              )}
              <h2 className="text-base font-bold text-splash-navy">
                {manual.title}
              </h2>
            </div>
            {manual.description && (
              <p className="px-4 py-3 text-sm text-splash-navy/70">
                {manual.description}
              </p>
            )}
          </Link>
        ))}
      </div>
    </section>
  );
}
