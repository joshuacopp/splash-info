// Brief 128 — Email queue admin detail page.
//
// Renders full row metadata for a single `outbound_emails` row plus
// Retry / Abandon action buttons (admin-tier only; worker re-validates).
// Body is rendered as preformatted escaped text — React's auto-escape
// keeps HTML payloads safe by default.

import Link from "next/link";
import { notFound } from "next/navigation";
import { getMe } from "../../../_lib/me";
import { ActionForm } from "../../_components/ActionForm";
import {
  getEmailQueueAdmin,
  type EmailQueueAttachmentMeta,
  type EmailQueueDetail,
  type EmailQueueStatus
} from "../../forms/_lib/worker-fetch";
import NoAccessCard from "../../forms/_components/NoAccessCard";
import {
  abandonEmailQueueAction,
  retryEmailQueueAction
} from "../actions";
import { ConfirmSubmitButton } from "../_components/ConfirmSubmitButton";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function EmailQueueDetailPage({ params }: PageProps) {
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();

  const session = await getMe().catch(() => null);
  if (!session) {
    return (
      <NoAccessCard
        reason="signin"
        returnPath={`/admin/email-queue/${id}`}
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

  let detail: EmailQueueDetail | null = null;
  let fetchError: string | null = null;
  try {
    detail = await getEmailQueueAdmin(id);
  } catch (err) {
    fetchError = err instanceof Error ? err.message : String(err);
  }

  if (!detail && !fetchError) notFound();

  return (
    <section className="mx-auto w-full max-w-[960px] px-5 py-9">
      <div className="mb-2 text-sm">
        <Link
          href="/admin/email-queue"
          className="text-splash-blue hover:underline"
        >
          ← Email Queue
        </Link>
      </div>

      <div className="mb-5">
        <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-sudsy-blue">
          Infrastructure
        </p>
        <h1 className="text-2xl font-bold text-splash-navy">
          Email queue row
        </h1>
        <p className="mt-1 text-sm text-splash-navy/70">
          <code>{id}</code>
        </p>
      </div>

      {fetchError && (
        <p className="mb-5 rounded-splash-md border border-racecar-red bg-white px-3 py-2 text-racecar-red">
          Failed to load row: {fetchError}
        </p>
      )}

      {detail && (
        <>
          <MetadataGrid detail={detail} />
          <ActionsBlock id={detail.id} status={detail.status} />
          {detail.last_error && <LastErrorBlock error={detail.last_error} />}
          <SubjectBlock subject={detail.subject} />
          <BodyBlock detail={detail} />
          <AttachmentsBlock attachments={detail.attachments} />
        </>
      )}
    </section>
  );
}

function MetadataGrid({ detail }: { detail: EmailQueueDetail }) {
  const rows: { label: string; value: React.ReactNode }[] = [
    {
      label: "Status",
      value: <StatusPill status={detail.status} />
    },
    { label: "Source worker", value: <code>{detail.source_worker}</code> },
    { label: "Source kind", value: <code>{detail.source_kind}</code> },
    { label: "Source id", value: <code>{detail.source_id}</code> },
    { label: "Recipient", value: detail.recipient },
    {
      label: "CC",
      value: detail.cc.length
        ? detail.cc.join(", ")
        : <span className="text-splash-navy/50">—</span>
    },
    {
      label: "Reply-To",
      value:
        detail.reply_to ?? <span className="text-splash-navy/50">—</span>
    },
    { label: "Created", value: formatAbsolute(detail.created_at) },
    { label: "Scheduled for", value: formatAbsolute(detail.scheduled_for) },
    {
      label: "Claimed at",
      value:
        detail.claimed_at !== null
          ? formatAbsolute(detail.claimed_at)
          : <span className="text-splash-navy/50">—</span>
    },
    {
      label: "Claim id",
      value:
        detail.claim_id !== null
          ? <code className="text-xs">{detail.claim_id}</code>
          : <span className="text-splash-navy/50">—</span>
    },
    {
      label: "Sent at",
      value:
        detail.sent_at !== null
          ? formatAbsolute(detail.sent_at)
          : <span className="text-splash-navy/50">—</span>
    },
    { label: "Send attempts", value: String(detail.send_attempts) }
  ];

  return (
    <div className="mb-6 overflow-hidden rounded-splash-md border border-gray-light bg-white">
      <dl className="divide-y divide-gray-light text-sm">
        {rows.map((r) => (
          <div
            key={r.label}
            className="flex flex-wrap items-baseline gap-3 px-4 py-2.5"
          >
            <dt className="w-36 shrink-0 text-xs font-semibold uppercase tracking-wide text-splash-navy/70">
              {r.label}
            </dt>
            <dd className="min-w-0 flex-1 text-splash-navy break-all">
              {r.value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function ActionsBlock({
  id,
  status
}: {
  id: string;
  status: EmailQueueStatus;
}) {
  const canAbandon = status === "stuck";
  return (
    <div className="mb-6 rounded-splash-md border border-gray-light bg-white p-4">
      <h2 className="mb-2 text-base font-bold text-splash-navy">Actions</h2>
      <p className="mb-3 text-sm text-splash-navy/70">
        <strong>Retry now</strong> resets <code>claimed_at</code>,{" "}
        <code>claim_id</code>, <code>send_attempts</code>, and{" "}
        <code>last_error</code> so the row becomes eligible for the next
        PA poll. <strong>Abandon</strong> bumps <code>send_attempts</code>{" "}
        to 99 — the row stays in the table for audit but never sends.
        Abandon is enabled only for <em>stuck</em> rows.
      </p>
      <div className="flex flex-wrap gap-3">
        <ActionForm action={retryEmailQueueAction} resetOnSuccess={false}>
          <input type="hidden" name="id" value={id} />
          <button
            type="submit"
            className="inline-flex items-center gap-1.5 rounded-splash-sm bg-splash-blue px-4 py-2 text-sm font-bold text-white shadow-splash-btn transition-colors hover:bg-splash-blue-dark"
          >
            Retry now
          </button>
        </ActionForm>

        {canAbandon ? (
          <ActionForm
            action={abandonEmailQueueAction}
            resetOnSuccess={false}
          >
            <input type="hidden" name="id" value={id} />
            <input type="hidden" name="confirm" value="yes" />
            <ConfirmSubmitButton
              label="Abandon"
              confirmText="Abandon this email row? It will never send."
              className="inline-flex items-center gap-1.5 rounded-splash-sm bg-racecar-red px-4 py-2 text-sm font-bold text-white shadow-splash-btn transition-colors hover:bg-racecar-red/85"
            />
          </ActionForm>
        ) : (
          <button
            type="button"
            disabled
            title="Abandon is enabled only for stuck rows."
            className="inline-flex cursor-not-allowed items-center gap-1.5 rounded-splash-sm border border-gray-light bg-white px-4 py-2 text-sm font-bold text-splash-navy/40"
          >
            Abandon
          </button>
        )}
      </div>
    </div>
  );
}

function LastErrorBlock({ error }: { error: string }) {
  return (
    <div className="mb-6 rounded-splash-md border border-racecar-red/40 bg-racecar-red/5 p-4">
      <h2 className="mb-2 text-base font-bold text-racecar-red">
        Last error
      </h2>
      <pre className="overflow-x-auto whitespace-pre-wrap break-words text-sm text-racecar-red">
        {error}
      </pre>
    </div>
  );
}

function SubjectBlock({ subject }: { subject: string }) {
  return (
    <div className="mb-6 rounded-splash-md border border-gray-light bg-white p-4">
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-splash-navy/70">
        Subject
      </h2>
      <p className="text-base font-semibold text-splash-navy break-words">
        {subject}
      </p>
    </div>
  );
}

function BodyBlock({ detail }: { detail: EmailQueueDetail }) {
  const html = detail.body_html;
  const text = detail.body_text;
  return (
    <div className="mb-6 rounded-splash-md border border-gray-light bg-white p-4">
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-splash-navy/70">
        Body
      </h2>
      {text && (
        <>
          <p className="mb-1 text-[0.6875rem] font-semibold uppercase tracking-wide text-splash-navy/60">
            body_text
          </p>
          <pre className="mb-4 overflow-x-auto whitespace-pre-wrap break-words rounded-splash-sm bg-gray-light/40 p-3 text-sm text-splash-navy">
            {text}
          </pre>
        </>
      )}
      {html && (
        <>
          <p className="mb-1 text-[0.6875rem] font-semibold uppercase tracking-wide text-splash-navy/60">
            body_html (rendered as escaped source)
          </p>
          {/* React auto-escapes string children — the raw HTML markup is
              rendered as visible text, NOT executed. This is intentional:
              we never dangerouslySetInnerHTML user/operator-authored HTML
              into the admin viewer. */}
          <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-splash-sm bg-gray-light/40 p-3 text-sm text-splash-navy">
            {html}
          </pre>
        </>
      )}
      {!text && !html && (
        <p className="italic text-splash-navy/60">No body content.</p>
      )}
    </div>
  );
}

function AttachmentsBlock({
  attachments
}: {
  attachments: EmailQueueAttachmentMeta[];
}) {
  return (
    <div className="mb-6 rounded-splash-md border border-gray-light bg-white p-4">
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-splash-navy/70">
        Attachments ({attachments.length})
      </h2>
      {attachments.length === 0 ? (
        <p className="italic text-splash-navy/60">No attachments.</p>
      ) : (
        <ul className="divide-y divide-gray-light">
          {attachments.map((a, i) => (
            <li
              key={i}
              className="flex flex-wrap items-baseline justify-between gap-3 py-2 text-sm"
            >
              <span className="font-semibold text-splash-navy">
                {a.filename || <em className="text-splash-navy/60">unnamed</em>}
              </span>
              <span className="text-xs text-splash-navy/60">
                <code>{a.mime || "unknown"}</code> ·{" "}
                {formatBytes(a.size_bytes)} ·{" "}
                {a.has_r2_key
                  ? "R2-backed"
                  : a.has_base64
                    ? "inlined base64"
                    : "no payload"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: EmailQueueStatus }) {
  const cls =
    status === "sent"
      ? "bg-splash-success/15 text-splash-success"
      : status === "stuck"
        ? "bg-racecar-red/15 text-racecar-red"
        : status === "claimed"
          ? "bg-sudsy-blue/15 text-sudsy-blue"
          : "bg-gray-light text-splash-navy/70";
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-bold ${cls}`}
    >
      {status}
    </span>
  );
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

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}
