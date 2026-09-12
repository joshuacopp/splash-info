// Parts Directory (/admin/parts/directory) — the frequently-ordered parts
// shelf.
//
// Sibling to the interactive parts manuals at /admin/parts. The manuals answer
// "what is this part called and where does it sit on the machine"; this page
// answers "what do we order, from whom, and what does it cost". Different
// question, so a different surface rather than a tab on the manuals.
//
// The whole list is fetched server-side in one call and handed to the client
// component, which filters in memory — see _components/PartsDirectory for why.
// `force-dynamic` because the fetch forwards the caller's session cookie and
// the contents change whenever someone adds a part; a cached render would show
// a stale shelf and, worse, be shared across sessions.
//
// READ AUTH matches the manuals index: any authenticated session. Middleware
// gates /admin/*, the worker re-checks, and nothing here is per-location or
// per-role — `location_codes` on a row says which sites use the part, not who
// may see it.
//
// WRITE AUTH is narrower and is resolved here: `canEdit` is true only for a
// platform super_admin, which is byte-for-byte the predicate
// `isPartsAdmin` enforces in apps/workorders-worker/src/parts.ts. The UI has
// to agree with the worker or an admin gets 403s from buttons that looked
// enabled. Note `session.role`, NOT `session.dcRole` — the latter is the
// damage-claims workflow role and has nothing to do with parts.
//
// A failed getMe() collapses to null (the established
// `getMe().catch(() => null)` pattern from ../../sysadmin/page.tsx), which
// means the page degrades to READ-ONLY rather than erroring. That is the
// right failure: the shelf is still useful without the edit buttons.

import Link from "next/link";
import { fetchParts } from "./_lib/parts";
import { getMe } from "../../../_lib/me";
import { PartsDirectory } from "./_components/PartsDirectory";

export const dynamic = "force-dynamic";
export const metadata = { title: "Parts Directory" };

export default async function PartsDirectoryPage() {
  // In parallel: the directory itself (workorders-worker) and the session
  // (dashboard-worker). Two unrelated services, so there is no reason to pay
  // for them serially.
  const [result, session] = await Promise.all([
    fetchParts(),
    getMe().catch(() => null)
  ]);
  const canEdit = session?.role === "super_admin";

  return (
    <section className="mx-auto w-full max-w-[1100px] px-5 py-9">
      <div className="mb-2 flex flex-wrap items-center gap-3 text-sm">
        <Link
          href="/admin/dashboard/operations/mechanical"
          className="text-splash-blue hover:underline"
        >
          ← Mechanical
        </Link>
        <span aria-hidden="true" className="text-splash-navy/25">
          |
        </span>
        <Link href="/admin/parts" className="text-splash-blue hover:underline">
          Equipment Manuals
        </Link>
      </div>

      <div className="mb-6">
        <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-sudsy-blue">
          Equipment
        </p>
        <h1 className="text-2xl font-bold text-splash-navy">Parts Directory</h1>
        <p className="mt-1 text-sm text-splash-navy/70">
          The parts we order most, with the number to quote and where to get
          them. Search by part number, name, vendor, machine, or anything in
          the notes — multiple words narrow the list, so &ldquo;macneil
          bearing&rdquo; finds the bearing we buy from MacNeil. Filter by
          machine to see everything that comes off one piece of equipment. A
          part used on several machines is one entry and shows up under each of
          them.
        </p>
      </div>

      {result.kind === "unavailable" && (
        <p className="mb-5 rounded-splash-md border border-amber-300 bg-amber-50 px-3 py-2 text-amber-900">
          The parts directory isn&apos;t connected in this environment. Run the
          app with <code>wrangler dev</code> (or deploy) to reach it.
        </p>
      )}

      {result.kind === "denied" && (
        <p className="mb-5 rounded-splash-md border border-amber-300 bg-amber-50 px-3 py-2 text-amber-900">
          Your session isn&apos;t authorized to read the parts directory. Sign
          out and back in, and let IT know if it keeps happening.
        </p>
      )}

      {result.kind === "error" && (
        <p className="mb-5 rounded-splash-md border border-red-300 bg-red-50 px-3 py-2 text-red-900">
          Couldn&apos;t load the parts directory (error {result.status}). Try
          again in a moment.
        </p>
      )}

      {result.kind === "ok" && (
        <PartsDirectory
          parts={result.parts}
          equipment={result.equipment}
          canEdit={canEdit}
        />
      )}
    </section>
  );
}
