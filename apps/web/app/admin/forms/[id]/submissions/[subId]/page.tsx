// Brief 96 — submission detail page (`/admin/forms/[id]/submissions/[subId]`).
//
// Server component. Renders status + splash_notes via the Brief 19
// <ActionForm> pattern (single Save button POSTs both fields to the
// last-write-wins PATCH endpoint), then renders the payload against the
// submission's specific version's schema, then a metadata key/value grid.

import Link from "next/link";
import { notFound } from "next/navigation";

import { getMe } from "../../../../../_lib/me";
import {
  getSubmissionAdmin,
  listSubmissionComments
} from "../../../_lib/worker-fetch";
import DiscussionSection from "./_components/DiscussionSection";
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
  // NO admin-tier gate here (Brief 173).
  //
  // Authority is decided by the WORKER, which allows admin tier or anyone on
  // the resolved approver list for this submission's current stage. Re-deriving
  // that rule here would be a second implementation of "who may act", and the
  // two would drift apart the moment resolveApproverEmails changes -- leaving
  // someone able to open a ticket they cannot action, or the reverse.
  //
  // So the page asks and renders the answer: a caller with no right to this
  // submission gets null back and falls into the forbidden card below, exactly
  // as before. The previous gate additionally rejected every non-admin BEFORE
  // asking, which is why a queue worker could see a ticket listed and never
  // open it.
  let detail: Awaited<ReturnType<typeof getSubmissionAdmin>>;
  let fetchError: string | null = null;
  try {
    detail = await getSubmissionAdmin(id, subId);
  } catch (err) {
    detail = null;
    fetchError = err instanceof Error ? err.message : String(err);
  }
  const submission = detail?.submission ?? null;
  // Comes from the worker, which decides it with the SAME gate the PATCH
  // applies. Do not substitute a role check here -- admin tier is NOT the set
  // of people who may edit (the form_submissions grant with locations also
  // qualifies), and re-deriving it hid this card from location admins once
  // already.
  const canEdit = detail?.canEdit === true;

  if (submission === null && fetchError === null) {
    notFound();
  }

  // Brief 174 — the thread. Fetched separately and fail-soft: the worker
  // applies its own authority rule, and a caller who may read the submission
  // but not join the discussion gets [] rather than an error. Losing the
  // thread must never cost the whole detail page.
  const thread = submission
    ? await listSubmissionComments(id, subId)
    : { ok: false as const, comments: [] };

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

      {/* ADMIN-ONLY, AND NOW HIDDEN RATHER THAN MERELY UNUSABLE.
          handlePatchSubmission gates on submissionGate -- admin tier or the
          form_submissions grant scoped to your own locations -- so a queue
          worker reaching this page via Brief 173's approver path cannot save
          either field. Showing them a form whose Save button always fails is
          worse than showing nothing: they fill it in, lose the text, and
          reasonably conclude the page is broken.
          CRD's note-taking is served by the Discussion thread below, which
          they CAN post to. */}
      {canEdit && (
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
      )}

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

      <DiscussionSection
        formId={id}
        subId={subId}
        comments={thread.comments}
        canDiscuss={thread.ok}
      />
    </section>
  );
}
