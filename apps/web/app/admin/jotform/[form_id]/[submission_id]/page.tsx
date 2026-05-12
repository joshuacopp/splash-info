// Brief 109 — JotForm submission detail
// (/admin/jotform/[form_id]/[submission_id]).
//
// Server component. Any authenticated session; the worker enforces
// anti-leak 404 for out-of-scope rows (Brief 107) so a null collapse from
// getSubmission() always routes to notFound() — caller can't distinguish
// "doesn't exist" from "exists but not yours". The payload renderer is
// generic over `row.answers`: keys rendered alphabetically; values vary
// per-form (rewash vs salt-log vs retention vs time-card-edit) so the v1
// UX is intentionally schema-agnostic.

import Link from "next/link";
import { notFound } from "next/navigation";

import { getMe } from "../../../../_lib/me";
import NoAccessCard from "../../_components/NoAccessCard";
import {
  getSubmission,
  type JotformSubmissionRow
} from "../../_lib/worker-fetch";

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
    // Worker collapses 401/403/404 to null. The anti-leak 404 for
    // out-of-scope rows is intentional — we render the same notFound()
    // chrome whether the row doesn't exist or the caller can't see it.
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
  const sortedAnswerKeys = Object.keys(row.answers).sort();

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
            <>
              {formatAbsolute(row.jotform_created_at)} ·{" "}
              {formatRelative(row.jotform_created_at)}
            </>
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
              value: row.jotform_created_at
                ? formatAbsolute(row.jotform_created_at)
                : em()
            },
            {
              label: "Updated at",
              value: row.jotform_updated_at
                ? formatAbsolute(row.jotform_updated_at)
                : em()
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
            ({sortedAnswerKeys.length} field
            {sortedAnswerKeys.length === 1 ? "" : "s"}, alphabetical)
          </span>
        </h2>
        {sortedAnswerKeys.length === 0 ? (
          <p className="px-5 py-4 italic text-splash-navy/60">
            No answers recorded for this submission.
          </p>
        ) : (
          <dl className="divide-y divide-gray-light">
            {sortedAnswerKeys.map((key) => (
              <div
                key={key}
                className="grid grid-cols-1 gap-1 px-5 py-3 sm:grid-cols-[200px_1fr] sm:gap-4"
              >
                <dt className="text-xs font-semibold uppercase tracking-wide text-splash-navy/60">
                  {key}
                </dt>
                <dd className="text-sm text-splash-navy">
                  <AnswerValue value={row.answers[key]} />
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

function AnswerValue({ value }: { value: unknown }) {
  if (value == null || value === "") return em();
  if (typeof value === "string") {
    return (
      <span className="whitespace-pre-wrap break-words">{value}</span>
    );
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return <span>{String(value)}</span>;
  }
  // Objects / arrays — common for JotForm rich-payload entries which are
  // typically `{answer, prettyFormat?, type, name, text}`. Try to surface
  // a friendly form first (prefer prettyFormat, then answer.text/value),
  // then fall back to a JSON pre-block.
  if (typeof value === "object") {
    const v = value as Record<string, unknown>;
    if (typeof v.prettyFormat === "string" && v.prettyFormat) {
      return (
        <span className="whitespace-pre-wrap break-words">
          {v.prettyFormat}
        </span>
      );
    }
    if (typeof v.answer === "string" && v.answer) {
      return (
        <span className="whitespace-pre-wrap break-words">{v.answer}</span>
      );
    }
    if (typeof v.answer === "number" || typeof v.answer === "boolean") {
      return <span>{String(v.answer)}</span>;
    }
    return (
      <pre className="overflow-x-auto rounded-splash-sm bg-gray-light/40 p-2 text-xs text-splash-navy/80">
        {stableStringify(value)}
      </pre>
    );
  }
  return <span>{String(value)}</span>;
}

function em(): React.ReactNode {
  return <span className="text-splash-navy/40">—</span>;
}

function formatAbsolute(iso: string): string {
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

function formatRelative(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const ms = Date.now() - d.getTime();
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day} day${day === 1 ? "" : "s"} ago`;
  return formatAbsolute(iso);
}

function stableStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
