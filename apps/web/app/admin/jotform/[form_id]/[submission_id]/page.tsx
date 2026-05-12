// Brief 109 — JotForm submission detail
// (/admin/jotform/[form_id]/[submission_id]).
//
// Server component. Any authenticated session; the worker enforces
// anti-leak 404 for out-of-scope rows (Brief 107) so a null collapse from
// getSubmission() always routes to notFound() — caller can't distinguish
// "doesn't exist" from "exists but not yours".
//
// Brief 112 rewrote the payload renderer: dispatched on
// `answers[KEY].type` (signatures inline as images, file uploads as a
// thumbnail grid, fullname / datetime / phone / checkbox preferring
// `prettyFormat`); sorted by `answers[KEY].order` (JotForm builder
// display order, not alphabetical); empty answers filtered out so
// optional-heavy forms (time-card-edit PTO Day 2-5) don't spam empty
// rows. Metadata timestamps use `formatEst()` matching the list page.

import Link from "next/link";
import { notFound } from "next/navigation";

import { getMe } from "../../../../_lib/me";
import NoAccessCard from "../../_components/NoAccessCard";
import { formatEst } from "../../_lib/format-est";
import { getSubmission } from "../../_lib/worker-fetch";
import {
  hasContent,
  orderKey,
  renderAnswerValue,
  type AnswerEntry
} from "./_lib/answer-renderer";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ form_id: string; submission_id: string }>;
}

export default async function JotformSubmissionDetailPage({
  params
}: PageProps) {
  const { form_id, submission_id } = await params;

  const session = await getMe().catch(() => null);
  if (!session) {
    return (
      <NoAccessCard
        reason="signin"
        returnPath={`/admin/jotform/${encodeURIComponent(form_id)}/${encodeURIComponent(submission_id)}`}
      />
    );
  }

  let detail: Awaited<ReturnType<typeof getSubmission>>;
  let fetchError: string | null = null;
  try {
    detail = await getSubmission(form_id, submission_id);
  } catch (err) {
    detail = null;
    fetchError = err instanceof Error ? err.message : "unknown error";
  }

  if (detail === null && fetchError === null) {
    notFound();
  }

  if (fetchError) {
    return (
      <section className="mx-auto w-full max-w-[820px] px-5 py-9">
        <BackLink formId={form_id} />
        <h1 className="mb-3 text-2xl font-bold text-splash-navy">
          JotForm submission
        </h1>
        <p className="text-racecar-red">
          Failed to load submission: {fetchError}
        </p>
      </section>
    );
  }

  const row = detail!.row;
  const submittedAt = formatEst(row.jotform_created_at);
  const updatedAt = formatEst(row.jotform_updated_at);

  const answers = (row.answers ?? {}) as Record<string, AnswerEntry>;
  const entries = Object.entries(answers)
    .filter(([, entry]) => entry != null && hasContent(entry))
    .map(([key, entry]) => ({ key, entry, order: orderKey(entry, key) }))
    .sort((a, b) => a.order - b.order);

  return (
    <section className="mx-auto w-full max-w-[820px] px-5 py-9">
      <BackLink formId={form_id} />

      <div className="mb-5">
        <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-sudsy-blue">
          JotForm
        </p>
        <h1 className="text-2xl font-bold text-splash-navy">Submission</h1>
        <p className="mt-1 text-sm text-splash-navy/70">
          {row.jotform_created_at ? (
            <span title={submittedAt.absolute}>
              {submittedAt.absolute}
              {submittedAt.relative ? ` · ${submittedAt.relative}` : ""}
            </span>
          ) : (
            <span className="text-splash-navy/50">— no timestamp —</span>
          )}
        </p>
      </div>

      <section className="mb-6 rounded-md border border-gray-light bg-white">
        <h2 className="border-b border-gray-light px-5 py-3 text-lg font-semibold text-splash-navy">
          Metadata
        </h2>
        <dl className="divide-y divide-gray-light">
          {[
            {
              label: "Submission ID",
              value: <code className="text-xs">{row.id}</code>
            },
            {
              label: "Site",
              value: row.site ?? em()
            },
            {
              label: "Site number",
              value: row.site_number ? (
                <code className="text-xs">{row.site_number}</code>
              ) : (
                em()
              )
            },
            {
              label: "Site email",
              value: row.site_email ?? em()
            },
            {
              label: "Submitted at",
              value: row.jotform_created_at ? (
                <span title={submittedAt.absolute}>{submittedAt.absolute}</span>
              ) : (
                em()
              )
            },
            {
              label: "Updated at",
              value: row.jotform_updated_at ? (
                <span title={updatedAt.absolute}>{updatedAt.absolute}</span>
              ) : (
                em()
              )
            },
            {
              label: "JotForm status",
              value: row.jotform_status ?? em()
            }
          ].map((f) => (
            <div
              key={f.label}
              className="grid grid-cols-1 gap-1 px-5 py-3 sm:grid-cols-[180px_1fr] sm:gap-4"
            >
              <dt className="text-xs font-semibold uppercase tracking-wide text-splash-navy/60">
                {f.label}
              </dt>
              <dd className="text-sm text-splash-navy">{f.value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="mb-6 rounded-md border border-gray-light bg-white">
        <h2 className="border-b border-gray-light px-5 py-3 text-lg font-semibold text-splash-navy">
          Answers
          <span className="ml-2 text-sm font-normal text-splash-navy/60">
            ({entries.length} field
            {entries.length === 1 ? "" : "s"})
          </span>
        </h2>
        {entries.length === 0 ? (
          <p className="px-5 py-4 italic text-splash-navy/60">
            No answers recorded for this submission.
          </p>
        ) : (
          <dl className="divide-y divide-gray-light">
            {entries.map(({ key, entry }) => (
              <div
                key={key}
                className="grid grid-cols-1 gap-1 px-5 py-3 sm:grid-cols-[200px_1fr] sm:gap-4"
              >
                <dt className="text-xs font-semibold uppercase tracking-wide text-splash-navy/60">
                  {entry.text || entry.name || `Field ${key}`}
                </dt>
                <dd className="text-sm text-splash-navy">
                  {renderAnswerValue(entry)}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </section>

      <details className="rounded-md border border-gray-light bg-white">
        <summary className="cursor-pointer px-5 py-3 text-sm font-semibold text-splash-navy/80">
          Raw JSON (debug)
        </summary>
        <pre className="overflow-x-auto rounded-b-md bg-gray-light/40 px-5 py-3 text-xs text-splash-navy/80">
          {stableStringify(row)}
        </pre>
      </details>
    </section>
  );
}

function BackLink({ formId }: { formId: string }) {
  return (
    <div className="mb-2 text-sm">
      <Link
        href={`/admin/jotform/${encodeURIComponent(formId)}`}
        className="text-splash-blue hover:underline"
      >
        ← All submissions
      </Link>
    </div>
  );
}

function em(): React.ReactNode {
  return <span className="text-splash-navy/40">—</span>;
}

function stableStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
