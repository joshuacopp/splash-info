// Brief 118 — Admin submissions index for custom-built forms.
//
// Top-level viewer that lists forms with a running submission count, drilling
// through to Brief 96's per-form submissions surface at
// /admin/forms/[id]/submissions. Lands when the dashboard Submissions-group
// "Forms" tile is clicked.
//
// As the form catalog grows the old card grid became unwieldy, so this now
// mirrors the /admin/forms table + filter pattern (audience, search) via a
// plain GET form (no client JS). Two submissions-specific differences from the
// builder list:
//   - Drafts are never shown (no public URL → can't accrue submissions).
//   - Archived forms are HIDDEN BY DEFAULT. A "Show archived" toggle
//     (?archived=1) brings them back so their historical submissions stay
//     reachable without cluttering the day-to-day view.
//
// Note: `/admin/forms/submissions` does not collide with the
// `/admin/forms/[id]` dynamic route — Next.js resolves static segments first.

import Link from "next/link";
import { getMe } from "../../../_lib/me";
import { listFormsAdmin, type FormListItem } from "../_lib/worker-fetch";
import NoAccessCard from "../_components/NoAccessCard";

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function readStringParam(raw: string | string[] | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;
  if (raw === "") return undefined;
  return raw;
}

export default async function FormsSubmissionsIndexPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const audience = readStringParam(sp.audience);
  const search = readStringParam(sp.search);
  const showArchived = readStringParam(sp.archived) === "1";

  const session = await getMe().catch(() => null);
  if (!session) {
    return <NoAccessCard reason="signin" returnPath="/admin/forms/submissions" />;
  }

  // Authorization is delegated to the worker (submissionGate): full admins see
  // every form, location admins see only their location-scoped forms with
  // per-site counts, everyone else gets a 403 → null → forbidden card below.
  // We intentionally do NOT gate on session.role here (mirrors the pricing
  // admin page) so location admins aren't blocked before the scoped fetch.
  let items: FormListItem[] | null = null;
  let fetchError: string | null = null;
  try {
    // Audience + search filter server-side; status is handled here so we can
    // apply the "published always, archived only when toggled, drafts never"
    // rule in one place.
    const res = await listFormsAdmin({
      search,
      audience: audience && audience !== "all" ? audience : undefined
    });
    if (res === null) {
      return <NoAccessCard reason="forbidden" />;
    }
    items = res.items
      .filter((f) => {
        if (f.status === "published") return true;
        if (f.status === "archived") return showArchived;
        return false; // drafts never appear on a submissions index
      })
      .sort((a, b) => {
        // Forms with submissions float to the top; ties break alphabetically.
        if (a.submissionCount !== b.submissionCount) {
          return b.submissionCount - a.submissionCount;
        }
        return a.title.localeCompare(b.title);
      });
  } catch (err) {
    fetchError = err instanceof Error ? err.message : String(err);
  }

  return (
    <section className="mx-auto w-full max-w-[1100px] px-5 py-9">
      <div className="mb-2 text-sm">
        <Link
          href="/admin/dashboard/submissions"
          className="text-splash-blue hover:underline"
        >
          ← Submissions
        </Link>
      </div>

      <div className="mb-5">
        <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-sudsy-blue">
          Custom Forms
        </p>
        <h1 className="text-2xl font-bold text-splash-navy">Form Submissions</h1>
        <p className="mt-1 text-sm text-splash-navy/70">
          View submissions to admin-built custom forms. Drill into any form
          to filter by date, edit status / notes, or export CSV.
        </p>
      </div>

      <form method="get" className="mb-5 flex flex-wrap items-end gap-3">
        <div>
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-splash-navy/70">
            Audience
          </label>
          <select
            name="audience"
            defaultValue={audience ?? "all"}
            className="rounded-splash-sm border border-gray-light bg-white px-3 py-1.5 text-sm text-splash-navy"
          >
            <option value="all">All</option>
            <option value="public">Public</option>
            <option value="internal">Internal</option>
            <option value="link-only">Link-only</option>
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-splash-navy/70">
            Search
          </label>
          <input
            type="text"
            name="search"
            defaultValue={search ?? ""}
            placeholder="Title or slug substring"
            className="w-64 rounded-splash-sm border border-gray-light bg-white px-3 py-1.5 text-sm text-splash-navy"
          />
        </div>
        <label className="mb-1 inline-flex cursor-pointer items-center gap-2 py-1.5 text-sm text-splash-navy/80">
          <input
            type="checkbox"
            name="archived"
            value="1"
            defaultChecked={showArchived}
            className="h-4 w-4 rounded border-gray-light text-splash-blue"
          />
          Show archived
        </label>
        <button
          type="submit"
          className="inline-flex items-center rounded-splash-sm border border-splash-blue bg-white px-4 py-1.5 text-sm font-bold text-splash-blue hover:bg-splash-blue/5"
        >
          Filter
        </button>
      </form>

      {fetchError && (
        <p className="mb-5 rounded-splash-md border border-racecar-red bg-white px-3 py-2 text-racecar-red">
          Failed to load forms: {fetchError}
        </p>
      )}

      {items && items.length === 0 && (
        <div className="rounded-splash-md border border-gray-light bg-white px-4 py-6 text-center italic text-splash-navy/60">
          No forms match these filters.
          {!showArchived && " Archived forms are hidden — enable “Show archived” to include them."}
        </div>
      )}

      {items && items.length > 0 && <SubmissionsTable items={items} />}
    </section>
  );
}

function SubmissionsTable({ items }: { items: FormListItem[] }) {
  return (
    <div className="overflow-x-auto rounded-splash-md border border-gray-light">
      <table className="w-full border-collapse text-sm">
        <thead className="bg-sudsy-blue-soft/40 text-left text-xs uppercase tracking-wide text-splash-navy/70">
          <tr>
            <th className="px-3 py-2 font-semibold">Title</th>
            <th className="px-3 py-2 font-semibold">Slug</th>
            <th className="px-3 py-2 font-semibold">Status</th>
            <th className="px-3 py-2 font-semibold">Audience</th>
            <th className="px-3 py-2 font-semibold">Submissions</th>
            <th className="px-3 py-2 font-semibold">Last edited</th>
            <th className="px-3 py-2 font-semibold">View</th>
          </tr>
        </thead>
        <tbody>
          {items.map((f) => (
            <tr
              key={f.id}
              className="border-t border-gray-light hover:bg-sudsy-blue-soft/20"
            >
              <td className="px-3 py-2 align-top">
                <Link
                  href={`/admin/forms/${encodeURIComponent(f.id)}/submissions`}
                  className="font-semibold text-splash-blue hover:underline"
                >
                  {f.title || (
                    <span className="italic text-splash-navy/50">untitled</span>
                  )}
                </Link>
              </td>
              <td className="px-3 py-2 align-top font-mono text-xs text-splash-navy/70">
                {f.slug}
              </td>
              <td className="px-3 py-2 align-top">
                <StatusPill status={f.status} />
              </td>
              <td className="px-3 py-2 align-top capitalize text-splash-navy/80">
                {f.audience}
              </td>
              <td className="px-3 py-2 align-top text-splash-navy/80">
                {f.submissionCount.toLocaleString()}
              </td>
              <td className="px-3 py-2 align-top text-splash-navy/70">
                <span title={f.lastEditedAt}>
                  {new Date(f.lastEditedAt).toLocaleString()}
                </span>
              </td>
              <td className="px-3 py-2 align-top">
                <Link
                  href={`/admin/forms/${encodeURIComponent(f.id)}/submissions`}
                  className="inline-flex items-center rounded-splash-sm border border-splash-blue bg-white px-2 py-0.5 text-xs font-semibold text-splash-blue hover:bg-splash-blue/5"
                >
                  View →
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StatusPill({ status }: { status: FormListItem["status"] }) {
  const cls =
    status === "published"
      ? "bg-splash-success/15 text-splash-success"
      : status === "archived"
        ? "bg-gray-light text-splash-navy/70"
        : "bg-amber-100 text-amber-800";
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-bold ${cls}`}
    >
      {status}
    </span>
  );
}
