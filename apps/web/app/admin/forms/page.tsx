// Brief 95 — Forms admin list page (/admin/forms).
//
// Server component. Top-of-page super_admin/admin gate via getMe(); the page
// never renders the "Create form" button or the table for non-admins (worker
// re-validates on every API call as defense in depth).
//
// Filters: status (all|draft|published|archived), search (substring on title
// or slug). Both URL-driven via plain GET form (no client JS).

import Link from "next/link";
import { getMe } from "../../_lib/me";
import { listFormsAdmin, type FormListItem } from "./_lib/worker-fetch";
import FormsAdminTabs from "./_components/FormsAdminTabs";
import NoAccessCard from "./_components/NoAccessCard";
import CopyLinkButton from "./_components/CopyLinkButton";
import ArchiveButton from "./_components/ArchiveButton";

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function readStringParam(raw: string | string[] | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;
  if (raw === "") return undefined;
  return raw;
}

export default async function FormsListPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const status = readStringParam(sp.status);
  const search = readStringParam(sp.search);
  const audience = readStringParam(sp.audience);

  const session = await getMe().catch(() => null);
  if (!session) {
    return <NoAccessCard reason="signin" returnPath="/admin/forms" />;
  }

  const allowed =
    session.role === "super_admin" ||
    session.dcRole === "admin" ||
    session.dcRole === "super_admin";

  if (!allowed) {
    return <NoAccessCard reason="forbidden" />;
  }

  let items: FormListItem[] | null = null;
  let fetchError: string | null = null;
  try {
    const res = await listFormsAdmin({
      status: status && status !== "all" ? status : undefined,
      search,
      audience: audience && audience !== "all" ? audience : undefined
    });
    if (res === null) {
      return <NoAccessCard reason="forbidden" />;
    }
    items = res.items;
  } catch (err) {
    fetchError = err instanceof Error ? err.message : String(err);
  }

  return (
    <section className="mx-auto w-full max-w-[1100px] px-5 py-9">
      <div className="mb-2 text-sm">
        <Link href="/admin/dashboard" className="text-splash-blue hover:underline">
          ← Dashboard
        </Link>
      </div>

      <FormsAdminTabs />

      <div className="mb-5">
        <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-sudsy-blue">
          Internal Tools
        </p>
        <h1 className="text-2xl font-bold text-splash-navy">Forms</h1>
        <p className="mt-1 text-sm text-splash-navy/70">
          Build, publish, and review admin-built forms.
        </p>
      </div>

      <form
        method="get"
        className="mb-5 flex flex-wrap items-end justify-between gap-3"
      >
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-splash-navy/70">
              Status
            </label>
            <select
              name="status"
              defaultValue={status ?? "all"}
              className="rounded-splash-sm border border-gray-light bg-white px-3 py-1.5 text-sm text-splash-navy"
            >
              <option value="all">All</option>
              <option value="draft">Draft</option>
              <option value="published">Published</option>
              <option value="archived">Archived</option>
            </select>
          </div>
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
          <button
            type="submit"
            className="inline-flex items-center rounded-splash-sm border border-splash-blue bg-white px-4 py-1.5 text-sm font-bold text-splash-blue hover:bg-splash-blue/5"
          >
            Filter
          </button>
        </div>
        <Link
          href="/admin/forms/new"
          className="inline-flex items-center gap-1.5 rounded-splash-sm bg-splash-blue px-4 py-1.5 text-sm font-bold text-white shadow-splash-btn hover:bg-splash-blue-dark"
        >
          + Create form
        </Link>
      </form>

      {fetchError && (
        <p className="mb-5 rounded-splash-md border border-racecar-red bg-white px-3 py-2 text-racecar-red">
          Failed to load forms: {fetchError}
        </p>
      )}

      {items && <FormsTable items={items} />}
    </section>
  );
}

function FormsTable({ items }: { items: FormListItem[] }) {
  if (items.length === 0) {
    return (
      <div className="rounded-splash-md border border-gray-light bg-white px-4 py-6 text-center italic text-splash-navy/60">
        No forms match these filters. Click + Create form to build one.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-splash-md border border-gray-light">
      <table className="w-full border-collapse text-sm">
        <thead className="bg-sudsy-blue-soft/40 text-left text-xs uppercase tracking-wide text-splash-navy/70">
          <tr>
            <th className="px-3 py-2 font-semibold">Title</th>
            <th className="px-3 py-2 font-semibold">Slug</th>
            <th className="px-3 py-2 font-semibold">Status</th>
            <th className="px-3 py-2 font-semibold">Audience</th>
            <th className="px-3 py-2 font-semibold">Versions</th>
            <th className="px-3 py-2 font-semibold">Submissions</th>
            <th className="px-3 py-2 font-semibold">Last edited</th>
            <th className="px-3 py-2 font-semibold">Public link</th>
            <th className="px-3 py-2 font-semibold">Actions</th>
          </tr>
        </thead>
        <tbody>
          {items.map((f) => (
            <tr key={f.id} className="border-t border-gray-light hover:bg-sudsy-blue-soft/20">
              <td className="px-3 py-2 align-top">
                <Link
                  href={`/admin/forms/${encodeURIComponent(f.id)}`}
                  className="font-semibold text-splash-blue hover:underline"
                >
                  {f.title || <span className="italic text-splash-navy/50">untitled</span>}
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
              <td className="px-3 py-2 align-top text-splash-navy/80">{f.versionCount}</td>
              <td className="px-3 py-2 align-top text-splash-navy/80">{f.submissionCount}</td>
              <td className="px-3 py-2 align-top text-splash-navy/70">
                <span title={f.lastEditedAt}>
                  {new Date(f.lastEditedAt).toLocaleString()}
                </span>
              </td>
              <td className="px-3 py-2 align-top">
                {f.status === "published" ? (
                  <CopyLinkButton slug={f.slug} />
                ) : (
                  <span className="text-xs text-splash-navy/40">—</span>
                )}
              </td>
              <td className="px-3 py-2 align-top">
                {f.status === "draft" ? (
                  <span className="text-xs text-splash-navy/40">—</span>
                ) : (
                  <ArchiveButton formId={f.id} status={f.status} />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StatusPill({ status }: { status: "draft" | "published" | "archived" }) {
  const cls =
    status === "published"
      ? "bg-splash-success/15 text-splash-success"
      : status === "draft"
        ? "bg-amber-100 text-amber-800"
        : "bg-gray-light text-splash-navy/70";
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-bold ${cls}`}
    >
      {status}
    </span>
  );
}
