// /sds — per-site SDS binder index.
//
// TOP-LEVEL, not under /admin/*, for the same reason /action-items and
// /workorders are: the audience is sites and RMs, not administrators. Access is
// the same email-on-locations answer those pages use, resolved by the WORKER --
// there is no role check here, because a second implementation of "who is
// responsible for this site" drifts from the first and the drift is silent.
//
// WHAT THIS IS. OSHA's HazCom standard (29 CFR 1910.1200(e)(1)(i)) requires a
// list of the hazardous chemicals known to be present, identified the way they
// are identified on their safety data sheets. This is that list, and the
// printed version goes in the front of the binder as its table of contents.
//
// WHAT IT IS NOT. The standard also wants a written programme, training,
// labelling, and the sheets themselves accessible in the work area. This is the
// index, not the binder and not the programme. Nothing here should be read as
// saying a site is compliant.

import Link from "next/link";

import { getMe } from "../_lib/me";
import { listSds, listSdsCandidates } from "./_lib/worker-fetch";
import SdsTable from "./_components/SdsTable";
import AddChemical from "./_components/AddChemical";
import ReviewStamp from "./_components/ReviewStamp";

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <section className="mx-auto w-full max-w-[1000px] px-5 py-9">{children}</section>
  );
}

export default async function SdsPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const requested = one(sp.location);
  const showRemoved = one(sp.removed) === "1";

  const session = await getMe().catch(() => null);
  if (!session) {
    return (
      <Shell>
        <p className="text-sm text-splash-navy/70">
          <Link href="/login?next=/sds" className="text-splash-blue underline">
            Sign in
          </Link>{" "}
          to see your site&rsquo;s SDS index.
        </p>
      </Shell>
    );
  }

  let resp: Awaited<ReturnType<typeof listSds>>;
  let loadError: string | null = null;
  try {
    resp = await listSds({ includeInactive: showRemoved });
  } catch (err) {
    resp = null;
    loadError = err instanceof Error ? err.message : String(err);
  }
  if (loadError) {
    return (
      <Shell>
        <p className="rounded-splash-md border border-racecar-red/30 bg-racecar-red/5 p-4 text-sm text-splash-navy">
          The SDS index couldn&rsquo;t be loaded. This is a fault, not a
          permissions problem &mdash; your access is fine.
          <span className="mt-2 block font-mono text-xs text-splash-navy/60">
            {loadError}
          </span>
        </p>
      </Shell>
    );
  }
  // null is the worker refusing outright, which is a different thing from an
  // empty list and deserves a different sentence.
  if (resp === null) {
    return (
      <Shell>
        <p className="text-sm text-splash-navy/70">
          The SDS index is shown to the people listed as a site, Regional Manager
          or Regional Director contact for a location. Your address isn&rsquo;t on
          any location right now, so there&rsquo;s nothing here.
        </p>
      </Shell>
    );
  }

  // Every site the caller can reach, not only those with entries: a site with
  // no list is the one most worth opening, and omitting it reads as done.
  const siteCodes = [
    ...new Set([...resp.locations, ...resp.items.map((i) => i.location_code)])
  ].sort();
  const activeSite =
    requested && siteCodes.includes(requested)
      ? requested
      : siteCodes.length === 1
        ? siteCodes[0]!
        : null;

  /** Prefer the site's display name; fall back to the code rather than blank,
   *  because a picker entry with no label is unclickable in practice. */
  const nameFor = (code: string) => resp.site_names?.[code] ?? code;

  const countFor = (code: string) =>
    resp.items.filter((i) => i.location_code === code && i.is_active).length;

  if (!activeSite) {
    return (
      <Shell>
        <Header />
        <p className="mb-4 text-sm text-splash-navy/70">
          {resp.scope === "all"
            ? `Pick a site to see its chemical list (${siteCodes.length} sites).`
            : "Pick a site to see its chemical list."}
        </p>
        <ul className="grid gap-2 sm:grid-cols-2">
          {siteCodes.map((code) => (
            <li key={code}>
              <Link
                href={`/sds?location=${encodeURIComponent(code)}`}
                className="flex items-center justify-between rounded-splash-md border border-gray-light bg-white px-4 py-3 text-sm font-semibold text-splash-navy hover:border-splash-navy/30"
              >
                {nameFor(code)}
                <span className="text-xs font-normal text-splash-navy/60">
                  {countFor(code)} listed
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </Shell>
    );
  }

  const items = resp.items.filter((i) => i.location_code === activeSite);
  const review = resp.reviews.find((r) => r.location_code === activeSite);
  // The worker re-checks every write; this only decides whether to offer the
  // controls. Admins have an empty `locations` list by design, hence the
  // scope test rather than a membership test alone.
  const canEdit = resp.scope === "all" || resp.locations.includes(activeSite);
  const candidates = canEdit ? await listSdsCandidates(activeSite) : [];
  const removedCount = items.filter((i) => !i.is_active).length;

  return (
    <Shell>
      <Header />

      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-splash-navy">{nameFor(activeSite)}</h2>
          <div className="mt-1">
            <ReviewStamp
              locationCode={activeSite}
              lastReviewedAt={review?.last_reviewed_at ?? null}
              lastReviewedBy={review?.last_reviewed_by ?? null}
              canEdit={canEdit}
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          {siteCodes.length > 1 ? (
            <Link href="/sds" className="text-splash-blue underline">
              All sites
            </Link>
          ) : null}
          <Link
            href={`/sds?location=${encodeURIComponent(activeSite)}&removed=${showRemoved ? "0" : "1"}`}
            className="text-splash-blue underline"
          >
            {showRemoved ? "Hide" : "Show"} removed
            {removedCount > 0 && !showRemoved ? ` (${removedCount})` : ""}
          </Link>
          {/* Opens the PDF inline so it can be printed straight from the
              browser -- a download step between "open" and "print" is friction
              on the one action this page exists for. */}
          {/* Two prints, because they answer different questions: the index
              alone is the cover page, the binder is the whole thing to refile
              after a revision. */}
          <a
            href={`/forms/api/sds/binder.pdf?location=${encodeURIComponent(activeSite)}`}
            target="_blank"
            rel="noreferrer"
            className="rounded-splash-sm bg-splash-navy px-3 py-1.5 text-xs font-bold text-white"
          >
            Print full binder
          </a>
          <a
            href={`/forms/api/sds/print.pdf?location=${encodeURIComponent(activeSite)}`}
            target="_blank"
            rel="noreferrer"
            className="rounded-splash-sm bg-splash-navy px-3 py-1.5 text-xs font-bold text-white"
          >
            Print index only
          </a>
        </div>
      </div>

      <SdsTable
        items={items}
        canEdit={canEdit}
        usage={resp.catalog_usage ?? {}}
        canVerify={resp.scope === "all"}
      />

      {canEdit ? (
        <AddChemical locationCode={activeSite} candidates={candidates} />
      ) : null}
    </Shell>
  );
}

function Header() {
  return (
    <div className="mb-5">
      <h1 className="text-2xl font-bold text-splash-navy">SDS Binder Index</h1>
      <p className="mt-1 text-sm text-splash-navy/70">
        The hazardous chemicals on site, listed the way their safety data sheets
        identify them. Print it for the front of the binder.
      </p>
    </div>
  );
}
