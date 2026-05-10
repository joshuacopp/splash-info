// Brief 96 — version history page (`/admin/forms/[id]/versions`).
//
// Audit-trail table. Columns: Version | Status | Published at | Published by
// | Field count | Submission count. No diff renderer at v1 (planning
// Decision 7 — deferred to a future brief).

import Link from "next/link";

import { getMe } from "../../../../_lib/me";
import { getFormAdmin, listVersionsAdmin, type VersionListItem } from "../../_lib/worker-fetch";
import FormsAdminTabs from "../../_components/FormsAdminTabs";
import NoAccessCard from "../../_components/NoAccessCard";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

function formatAbsolute(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

export default async function VersionsPage({ params }: PageProps) {
  const { id } = await params;

  const session = await getMe().catch(() => null);
  if (!session) {
    return (
      <NoAccessCard
        reason="signin"
        returnPath={`/admin/forms/${encodeURIComponent(id)}/versions`}
      />
    );
  }
  const allowed =
    session.role === "super_admin" ||
    session.dcRole === "admin" ||
    session.dcRole === "super_admin";
  if (!allowed) {
    return <NoAccessCard reason="forbidden" />;
  }

  const form = await getFormAdmin(id);
  if (!form) {
    return (
      <section className="mx-auto w-full max-w-[820px] px-5 py-9">
        <FormsAdminTabs formId={id} />
        <p className="text-racecar-red">Form not found.</p>
      </section>
    );
  }

  let listResp: Awaited<ReturnType<typeof listVersionsAdmin>> = null;
  let fetchError: string | null = null;
  try {
    listResp = await listVersionsAdmin(id);
  } catch (err) {
    fetchError = err instanceof Error ? err.message : String(err);
  }

  return (
    <section className="mx-auto w-full max-w-[820px] px-5 py-9">
      <div className="mb-2 text-sm">
        <Link href="/admin/forms" className="text-splash-blue hover:underline">
          ← All forms
        </Link>
      </div>

      <FormsAdminTabs formId={id} />

      <div className="mb-5">
        <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-sudsy-blue">
          Versions
        </p>
        <h1 className="text-2xl font-bold text-splash-navy">{form.form.title}</h1>
        <p className="mt-1 text-sm text-splash-navy/70">
          Audit trail of every draft + published version. Diff view deferred
          to v2.
        </p>
      </div>

      {fetchError && (
        <p className="mb-5 rounded-splash-md border border-racecar-red bg-white px-3 py-2 text-racecar-red">
          Failed to load versions: {fetchError}
        </p>
      )}

      {listResp && <VersionsTable items={listResp.items} />}
    </section>
  );
}

function VersionsTable({ items }: { items: VersionListItem[] }) {
  if (items.length === 0) {
    return (
      <div className="rounded-splash-md border border-gray-light bg-white px-4 py-6 text-center italic text-splash-navy/60">
        No versions yet.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-splash-md border border-gray-light">
      <table className="w-full border-collapse text-sm">
        <thead className="bg-sudsy-blue-soft/40 text-left text-xs uppercase tracking-wide text-splash-navy/70">
          <tr>
            <th className="px-3 py-2 font-semibold">Version</th>
            <th className="px-3 py-2 font-semibold">Status</th>
            <th className="px-3 py-2 font-semibold">Published at</th>
            <th className="px-3 py-2 font-semibold">Published by</th>
            <th className="px-3 py-2 font-semibold">Fields</th>
            <th className="px-3 py-2 font-semibold">Submissions</th>
          </tr>
        </thead>
        <tbody>
          {items.map((v) => (
            <tr key={v.id} className="border-t border-gray-light">
              <td className="px-3 py-2 align-top font-mono text-splash-navy">
                v{v.version_number}
              </td>
              <td className="px-3 py-2 align-top">
                {v.is_draft ? (
                  <span className="inline-flex items-center rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-bold text-amber-800">
                    Draft
                  </span>
                ) : (
                  <span className="inline-flex items-center rounded-full bg-splash-success/15 px-2.5 py-0.5 text-xs font-bold text-splash-success">
                    Published
                  </span>
                )}
              </td>
              <td className="px-3 py-2 align-top text-splash-navy/80">
                {formatAbsolute(v.published_at)}
              </td>
              <td className="px-3 py-2 align-top">
                {v.published_by ? (
                  <code className="text-xs text-splash-navy/70">
                    {v.published_by}
                  </code>
                ) : (
                  <span className="text-splash-navy/40">—</span>
                )}
              </td>
              <td className="px-3 py-2 align-top text-splash-navy/80">
                {v.field_count}
              </td>
              <td className="px-3 py-2 align-top text-splash-navy/80">
                {v.submission_count}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
