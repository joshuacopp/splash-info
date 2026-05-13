// Brief 118 — Admin submissions index for custom-built forms.
//
// Top-level viewer that lists every published + archived form with its
// running submission count, drill-through to Brief 96's per-form
// submissions surface at /admin/forms/[id]/submissions. Lands when the
// dashboard Submissions-group "Forms" tile is clicked (Brief 118
// retargeted that tile from /forms — Brief 99's fill-out index — to
// here, since the other Submissions-group tiles all point at viewers).
//
// Mirrors the Brief 109 JotForm index card grid. Admin-tier only;
// non-admins get a NoAccessCard. Forms-worker re-validates on every
// API call as defense in depth.
//
// Note: `/admin/forms/submissions` does not collide with the
// `/admin/forms/[id]` dynamic route (Brief 95 builder) — Next.js App
// Router resolves static segments before dynamic ones, same as the
// sibling `/admin/forms/new` route. The brief flagged this as a
// potential collision; in practice the static segment wins.

import Link from "next/link";
import { getMe } from "../../../_lib/me";
import { listFormsAdmin, type FormListItem } from "../_lib/worker-fetch";
import NoAccessCard from "../_components/NoAccessCard";

export const dynamic = "force-dynamic";

export default async function FormsSubmissionsIndexPage() {
  const session = await getMe().catch(() => null);
  if (!session) {
    return <NoAccessCard reason="signin" returnPath="/admin/forms/submissions" />;
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
    // No status filter on the admin list endpoint — we filter client-side
    // to published + archived (drafts have no public URL and can't accrue
    // submissions, so they don't belong on a submissions index).
    const res = await listFormsAdmin();
    if (res === null) {
      return <NoAccessCard reason="forbidden" />;
    }
    items = res.items
      .filter((f) => f.status === "published" || f.status === "archived")
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

      <div className="mb-6">
        <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-sudsy-blue">
          Custom Forms
        </p>
        <h1 className="text-2xl font-bold text-splash-navy">Form Submissions</h1>
        <p className="mt-1 text-sm text-splash-navy/70">
          View submissions to admin-built custom forms. Drill into any form
          to filter by date, edit status / notes, or export CSV.
        </p>
      </div>

      {fetchError && (
        <p className="mb-5 rounded-splash-md border border-racecar-red bg-white px-3 py-2 text-racecar-red">
          Failed to load forms: {fetchError}
        </p>
      )}

      {items && items.length === 0 && (
        <div className="rounded-splash-md border border-gray-light bg-white px-4 py-6 text-center italic text-splash-navy/60">
          No forms yet — create one in{" "}
          <Link href="/admin/forms" className="not-italic font-bold text-splash-blue hover:underline">
            Form Builder
          </Link>
          .
        </div>
      )}

      {items && items.length > 0 && (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((f) => (
            <FormSubmissionsCard key={f.id} form={f} />
          ))}
        </div>
      )}
    </section>
  );
}

function FormSubmissionsCard({ form }: { form: FormListItem }) {
  return (
    <Link
      href={`/admin/forms/${encodeURIComponent(form.id)}/submissions`}
      className="group flex flex-col overflow-hidden rounded-splash-lg border-[3px] border-splash-navy bg-white text-splash-navy shadow-splash-card transition-transform duration-150 hover:-translate-y-1 hover:shadow-splash-card-hover"
    >
      <div className="flex items-center gap-4 bg-gradient-to-br from-splash-blue to-splash-navy px-6 py-5">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-[0.6875rem] font-semibold uppercase tracking-[0.16em] text-sudsy-blue">
            Custom Form
          </span>
          <span className="truncate text-lg font-bold leading-tight text-white">
            {form.title || <span className="italic text-white/70">untitled</span>}
          </span>
        </div>
      </div>
      <div className="flex flex-1 flex-col justify-between gap-3.5 px-6 pb-5 pt-4">
        <div>
          <div className="mb-2">
            <StatusPill status={form.status} />
          </div>
          <p className="text-[0.9375rem] leading-relaxed text-splash-navy/80">
            <span className="font-semibold text-splash-navy">
              {form.submissionCount.toLocaleString()}
            </span>{" "}
            submission{form.submissionCount === 1 ? "" : "s"} on record.
          </p>
          <p className="mt-1 text-xs text-splash-navy/60">
            <code>{form.slug}</code>
          </p>
        </div>
        <span className="inline-flex items-center gap-1.5 self-start text-[0.8125rem] font-bold uppercase tracking-[0.08em] text-splash-blue">
          View submissions
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-3.5 w-3.5 transition-transform duration-200 group-hover:translate-x-1"
            aria-hidden="true"
          >
            <line x1="5" y1="12" x2="19" y2="12" />
            <polyline points="12 5 19 12 12 19" />
          </svg>
        </span>
      </div>
    </Link>
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
