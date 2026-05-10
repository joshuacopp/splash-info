// Brief 96 — Form submissions list (`/admin/forms/[id]/submissions`).
//
// Server component. Mirrors `/admin/fleet` (Brief 83): DateRangePicker
// (last-30-days default) + status filter + submitter-kind filter + CSV
// export button. List columns are meta-only because schemas vary across
// versions (planning Decision 7) — payload values are rendered on the
// detail page against the submission's specific version's schema.

import Link from "next/link";

import { getMe } from "../../../../_lib/me";
import {
  getFormAdmin,
  listSubmissionsAdmin,
  getSubmissionsCsvUrl,
  type SubmissionListItem
} from "../../_lib/worker-fetch";
import FormsAdminTabs from "../../_components/FormsAdminTabs";
import NoAccessCard from "../../_components/NoAccessCard";
import { DateRangePicker } from "../../../../_components/DateRangePicker";
import { CsvExportButton } from "../../../../_components/CsvExportButton";
import StatusPill from "./_components/StatusPill";

export const dynamic = "force-dynamic";

const DEFAULT_WINDOW_DAYS = 30;

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function readStringParam(
  raw: string | string[] | undefined
): string | undefined {
  if (typeof raw !== "string" || raw === "") return undefined;
  return raw;
}

function ymdUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function defaultFromYmd(): string {
  const n = new Date();
  const today = new Date(
    Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate())
  );
  return ymdUtc(new Date(today.getTime() - DEFAULT_WINDOW_DAYS * 86_400_000));
}

function todayYmd(): string {
  const n = new Date();
  return ymdUtc(
    new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()))
  );
}

export default async function FormSubmissionsPage({
  params,
  searchParams
}: PageProps) {
  const { id } = await params;
  const sp = await searchParams;
  const from = readStringParam(sp.from);
  const to = readStringParam(sp.to);
  const status = readStringParam(sp.status);
  const submitterKind = readStringParam(sp.submitter_kind);

  const session = await getMe().catch(() => null);
  if (!session) {
    return (
      <NoAccessCard
        reason="signin"
        returnPath={`/admin/forms/${encodeURIComponent(id)}/submissions`}
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
      <section className="mx-auto w-full max-w-[1100px] px-5 py-9">
        <FormsAdminTabs formId={id} />
        <p className="text-racecar-red">Form not found.</p>
      </section>
    );
  }

  let listResp: Awaited<ReturnType<typeof listSubmissionsAdmin>> = null;
  let fetchError: string | null = null;
  try {
    listResp = await listSubmissionsAdmin(id, {
      from,
      to,
      status,
      submitter_kind: submitterKind
    });
  } catch (err) {
    fetchError = err instanceof Error ? err.message : String(err);
  }

  const fromDefault = defaultFromYmd();
  const toDefault = todayYmd();
  const csvUrl = getSubmissionsCsvUrl(id, { from, to });

  return (
    <section className="mx-auto w-full max-w-[1100px] px-5 py-9">
      <div className="mb-2 text-sm">
        <Link href="/admin/forms" className="text-splash-blue hover:underline">
          ← All forms
        </Link>
      </div>

      <FormsAdminTabs formId={id} />

      <div className="mb-5">
        <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-sudsy-blue">
          Submissions
        </p>
        <h1 className="text-2xl font-bold text-splash-navy">{form.form.title}</h1>
        <p className="mt-1 text-sm text-splash-navy/70">
          Slug <code className="text-xs">{form.form.slug}</code> · last 30 days
          by default
        </p>
      </div>

      <form
        method="get"
        className="mb-5 flex flex-wrap items-end justify-between gap-3"
      >
        <div className="flex flex-wrap items-end gap-3">
          <DateRangePicker
            defaultFromYmd={listResp?.from ?? fromDefault}
            defaultToYmd={listResp?.to ?? toDefault}
          />
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
              <option value="new">New</option>
              <option value="in_progress">In progress</option>
              <option value="closed">Closed</option>
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-splash-navy/70">
              Submitter
            </label>
            <select
              name="submitter_kind"
              defaultValue={submitterKind ?? "all"}
              className="rounded-splash-sm border border-gray-light bg-white px-3 py-1.5 text-sm text-splash-navy"
            >
              <option value="all">All</option>
              <option value="authenticated">Authenticated</option>
              <option value="anonymous">Anonymous</option>
            </select>
          </div>
          <button
            type="submit"
            className="inline-flex items-center rounded-splash-sm border border-splash-blue bg-white px-4 py-1.5 text-sm font-bold text-splash-blue hover:bg-splash-blue/5"
          >
            Filter
          </button>
        </div>
        <CsvExportButton href={csvUrl} />
      </form>

      {fetchError && (
        <p className="mb-5 rounded-splash-md border border-racecar-red bg-white px-3 py-2 text-racecar-red">
          Failed to load submissions: {fetchError}
        </p>
      )}

      {listResp && (
        <>
          {listResp.limit_hit && (
            <p className="mb-3 rounded-splash-sm border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              Showing the first {listResp.items.length} results. Narrow the
              date range or use the CSV export to see more.
            </p>
          )}

          <SubmissionsTable formId={id} items={listResp.items} />
        </>
      )}
    </section>
  );
}

function SubmissionsTable({
  formId,
  items
}: {
  formId: string;
  items: SubmissionListItem[];
}) {
  if (items.length === 0) {
    return (
      <div className="rounded-splash-md border border-gray-light bg-white px-4 py-6 text-center italic text-splash-navy/60">
        No submissions in the selected range.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-splash-md border border-gray-light">
      <table className="w-full border-collapse text-sm">
        <thead className="bg-sudsy-blue-soft/40 text-left text-xs uppercase tracking-wide text-splash-navy/70">
          <tr>
            <th className="px-3 py-2 font-semibold">Submitted</th>
            <th className="px-3 py-2 font-semibold">Status</th>
            <th className="px-3 py-2 font-semibold">Submitter</th>
            <th className="px-3 py-2 font-semibold">Splash Notes</th>
            <th className="px-3 py-2 font-semibold">Version</th>
            <th className="px-3 py-2 font-semibold"></th>
          </tr>
        </thead>
        <tbody>
          {items.map((s) => (
            <tr key={s.id} className="border-t border-gray-light hover:bg-sudsy-blue-soft/20">
              <td className="px-3 py-2 align-top text-splash-navy">
                <span title={s.submitted_at}>
                  {new Date(s.submitted_at).toLocaleString()}
                </span>
              </td>
              <td className="px-3 py-2 align-top">
                <StatusPill status={s.status} />
              </td>
              <td className="px-3 py-2 align-top text-splash-navy">
                {s.submitter_kind === "authenticated" ? (
                  s.submitter_email ?? <em className="text-splash-navy/50">—</em>
                ) : (
                  <em className="text-splash-navy/50">anonymous</em>
                )}
              </td>
              <td className="px-3 py-2 align-top text-splash-navy/80">
                {s.splash_notes_preview ? (
                  <>
                    {s.splash_notes_preview}
                    {s.splash_notes_truncated && "…"}
                  </>
                ) : (
                  <em className="text-splash-navy/40">—</em>
                )}
              </td>
              <td className="px-3 py-2 align-top text-splash-navy/80">
                {s.version_number != null ? `v${s.version_number}` : "—"}
              </td>
              <td className="px-3 py-2 align-top">
                <Link
                  href={`/admin/forms/${encodeURIComponent(formId)}/submissions/${encodeURIComponent(s.id)}`}
                  className="text-splash-blue hover:underline"
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
