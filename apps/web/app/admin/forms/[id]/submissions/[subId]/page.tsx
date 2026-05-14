// Brief 96 — submission detail page (`/admin/forms/[id]/submissions/[subId]`).
//
// Server component. Renders status + splash_notes via the Brief 19
// <ActionForm> pattern (single Save button POSTs both fields to the
// last-write-wins PATCH endpoint), then renders the payload against the
// submission's specific version's schema, then a metadata key/value grid.

import Link from "next/link";
import { notFound } from "next/navigation";

import { getMe } from "../../../../../_lib/me";
import { getSubmissionAdmin } from "../../../_lib/worker-fetch";
import FormsAdminTabs from "../../../_components/FormsAdminTabs";
import NoAccessCard from "../../../_components/NoAccessCard";
import { ActionForm } from "../../../../_components/ActionForm";
import { SubmitButton } from "../../../../_components/SubmitButton";
import StatusPill from "../_components/StatusPill";
import PayloadRenderer from "./_components/PayloadRenderer";
import WorkflowSection from "./_components/WorkflowSection";
import { transitionAction, updateSubmissionAction } from "./actions";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string; subId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function em(): React.ReactNode {
  return <span className="text-splash-navy/40">—</span>;
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

export default async function SubmissionDetailPage({
  params,
  searchParams
}: PageProps) {
  const { id, subId } = await params;
  const sp = await searchParams;
  const fromApprovals = sp.from === "approvals";

  const session = await getMe().catch(() => null);
  if (!session) {
    return (
      <NoAccessCard
        reason="signin"
        returnPath={`/admin/forms/${encodeURIComponent(id)}/submissions/${encodeURIComponent(subId)}`}
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

  let submission: Awaited<ReturnType<typeof getSubmissionAdmin>>;
  let fetchError: string | null = null;
  try {
    submission = await getSubmissionAdmin(id, subId);
  } catch (err) {
    submission = null;
    fetchError = err instanceof Error ? err.message : String(err);
  }

  if (submission === null && fetchError === null) {
    notFound();
  }

  if (fetchError || !submission) {
    return (
      <section className="mx-auto w-full max-w-[820px] px-5 py-9">
        <FormsAdminTabs formId={id} />
        <p className="text-racecar-red">
          Failed to load submission: {fetchError ?? "unknown error"}
        </p>
      </section>
    );
  }

  const save = updateSubmissionAction.bind(null, id, subId);
  const transition = transitionAction.bind(null, id, subId);
  const workflow = submission.version.schema.workflow;
  const isAdminTier =
    session.role === "super_admin" ||
    session.dcRole === "admin" ||
    session.dcRole === "super_admin";

  return (
    <section className="mx-auto w-full max-w-[820px] px-5 py-9">
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        {fromApprovals && (
          <Link
            href="/admin/approvals"
            className="font-semibold text-splash-blue hover:underline"
          >
            ← Back to Pending Approvals
          </Link>
        )}
        <Link
          href={`/admin/forms/${encodeURIComponent(id)}/submissions`}
          className="text-splash-blue hover:underline"
        >
          ← All submissions
        </Link>
      </div>

      <FormsAdminTabs formId={id} />

      <div className="mb-5 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-sudsy-blue">
            Submission
          </p>
          <h1 className="text-2xl font-bold text-splash-navy">
            {submission.submitter_email ?? "Anonymous submission"}
          </h1>
          <p className="mt-1 text-sm text-splash-navy/70">
            {formatAbsolute(submission.submitted_at)} · v
            {submission.version.version_number}
          </p>
        </div>
        <StatusPill status={submission.status} />
      </div>

      <section className="mb-6 rounded-md border border-gray-light bg-white p-5">
        <h2 className="mb-2 text-lg font-semibold text-splash-navy">
          Status &amp; Splash Notes
        </h2>
        <p className="mb-3 text-xs text-splash-navy/60">
          Visible to all admin / super_admin users. Last-write-wins.
        </p>
        <ActionForm action={save} resetOnSuccess={false} className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-splash-navy/70">
              Status
            </label>
            <select
              name="status"
              defaultValue={submission.status}
              className="rounded-splash-sm border border-gray-light bg-white px-3 py-1.5 text-sm text-splash-navy"
            >
              <option value="new">New</option>
              <option value="in_progress">In progress</option>
              <option value="closed">Closed</option>
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-splash-navy/70">
              Splash Notes
            </label>
            <textarea
              name="splash_notes"
              defaultValue={submission.splash_notes ?? ""}
              rows={6}
              maxLength={10000}
              placeholder="Internal notes about this submission…"
              className="block w-full rounded-splash-md border border-gray-light bg-white px-3 py-2 text-sm text-splash-navy focus:border-splash-blue focus:outline-none focus:ring-1 focus:ring-splash-blue"
            />
          </div>
          <SubmitButton
            pendingText="Saving…"
            className="rounded-splash-md bg-splash-navy px-4 py-2 text-sm font-semibold text-white hover:bg-splash-blue-dark disabled:opacity-70"
          >
            Save
          </SubmitButton>
        </ActionForm>
      </section>

      {workflow && (
        <WorkflowSection
          submissionId={subId}
          workflow={workflow}
          currentStageId={
            submission.workflow_stage ?? workflow.default_stage
          }
          history={submission.workflow_history}
          currentApproverEmails={submission.current_approver_emails}
          callerEmail={session.email}
          isAdminTier={isAdminTier}
          transitionAction={transition}
        />
      )}

      <section className="mb-6">
        <h2 className="mb-2 text-lg font-semibold text-splash-navy">
          Form payload
          <span className="ml-2 text-sm font-normal text-splash-navy/60">
            (rendered against v{submission.version.version_number})
          </span>
        </h2>
        <PayloadRenderer
          schema={submission.version.schema}
          payload={submission.payload}
          files={submission.files}
          formId={id}
        />
      </section>

      <section className="mb-6 rounded-md border border-gray-light bg-white">
        <h2 className="border-b border-gray-light px-5 py-3 text-lg font-semibold text-splash-navy">
          Metadata
        </h2>
        <dl className="divide-y divide-gray-light">
          {[
            { label: "Submission ID", value: <code className="text-xs">{submission.id}</code> },
            { label: "Submitted at", value: formatAbsolute(submission.submitted_at) },
            { label: "Submitter kind", value: submission.submitter_kind },
            {
              label: "Submitter email",
              value: submission.submitter_email ?? em()
            },
            {
              label: "Submitter user ID",
              value: submission.submitter_user_id ? (
                <code className="text-xs">{submission.submitter_user_id}</code>
              ) : (
                em()
              )
            },
            {
              label: "Submitter IP",
              value: submission.submitter_ip ? (
                <code className="text-xs">{submission.submitter_ip}</code>
              ) : (
                em()
              )
            },
            {
              label: "Form version",
              value: `v${submission.version.version_number}`
            },
            {
              label: "Status updated at",
              value: submission.status_updated_at
                ? formatAbsolute(submission.status_updated_at)
                : em()
            },
            {
              label: "Status updated by",
              value: submission.status_updated_by ? (
                <code className="text-xs">{submission.status_updated_by}</code>
              ) : (
                em()
              )
            },
            {
              label: "Notes updated at",
              value: submission.splash_notes_updated_at
                ? formatAbsolute(submission.splash_notes_updated_at)
                : em()
            },
            {
              label: "Notes updated by",
              value: submission.splash_notes_updated_by ? (
                <code className="text-xs">{submission.splash_notes_updated_by}</code>
              ) : (
                em()
              )
            }
          ].map((f) => (
            <div
              key={f.label}
              className="grid grid-cols-1 gap-1 px-5 py-3 sm:grid-cols-[200px_1fr] sm:gap-4"
            >
              <dt className="text-xs font-semibold uppercase tracking-wide text-splash-navy/60">
                {f.label}
              </dt>
              <dd className="text-sm text-splash-navy">{f.value}</dd>
            </div>
          ))}
        </dl>
      </section>
    </section>
  );
}
