// Brief 121 — Daily "waiting on you" digest cron.
//
// Once-daily scheduled handler (12:00 UTC). Queries every form_submissions row
// with a non-empty `current_approver_emails`, groups by approver email + form,
// and enqueues ONE email per approver summarising everything pending for them.
//
// DELIVERY IS THE Brief 127 outbound_emails QUEUE, not a per-feature webhook.
//
//   Brief 121 originally POSTed to `FORMS_APPROVAL_DIGEST_WEBHOOK_URL`, which
//   needed its own Power Automate flow. That secret was never bound, so for its
//   entire life this cron ran daily, computed the digest, logged "would-fire",
//   and sent nothing -- a feature that failed by looking like absence.
//
//   The queue already drains five workers' mail through one flow that neither
//   knows nor cares who enqueued, so this needs no new secret and no new flow.
//   It also inherits /admin/email-queue, so a failed digest is visible and
//   retryable, which the webhook path never was.
//
// SOURCE_ID CARRIES THE RUN DATE, and that is load-bearing.
//
//   The queue dedups on (source_worker, source_kind, source_id, recipient) with
//   ignore-duplicates. A constant source_id would send each person exactly ONE
//   digest ever, and every subsequent day would no-op in silence -- no error,
//   no row, nothing to notice. Dating it makes each day a distinct event, and
//   turns the dedup into a feature: a double cron fire is a real no-op rather
//   than a duplicate in someone's inbox. Same shape the workorders daily and
//   greeter weekly digests already use.
//
// Skip-on-empty: an approver with zero pending items gets no email.
// Fail-soft per recipient: one enqueue failure doesn't halt the rest.

import { enqueueOutboundEmail } from "@splash/db-supabase";
import { renderApprovalDigest } from "./approval-digest-render.js";
import type { Env } from "../index.js";

const DIGEST_LIMIT_ROWS = 5000;
const DASHBOARD_URL_DEFAULT = "https://splashcarwashes.info/admin/approvals";

interface DigestRow {
  id: string;
  form_id: string;
  workflow_stage: string | null;
  submitted_at: string;
  current_approver_emails: string[] | null;
  form: { id: string; title: string } | null;
}

interface DigestPerFormEntry {
  form_id: string;
  form_title: string;
  count: number;
  oldest_submitted_at: string;
}

export interface DigestResult {
  recipientsConsidered: number;
  recipientsFired: number;
  /** Already queued for this date — a second cron fire in the same day, which
   *  the dedup index makes harmless. Distinct from `recipientsFired` so the
   *  log tells you which happened. */
  recipientsDuplicate: number;
  recipientsFailed: number;
  rowsScanned: number;
  errors: string[];
}

export async function runDailyApprovalDigest(env: Env): Promise<DigestResult> {
  const errors: string[] = [];
  const result: DigestResult = {
    recipientsConsidered: 0,
    recipientsFired: 0,
    recipientsDuplicate: 0,
    recipientsFailed: 0,
    rowsScanned: 0,
    errors
  };

  // Pull every pending row in one shot (DIGEST_LIMIT_ROWS cap — at typical
  // approver-list sizes this comfortably covers thousands of submissions
  // for hundreds of approvers).
  const pgUrl = new URL("/rest/v1/form_submissions", env.SUPABASE_URL);
  pgUrl.searchParams.set(
    "select",
    [
      "id",
      "form_id",
      "workflow_stage",
      "submitted_at",
      "current_approver_emails",
      "form:forms!inner(id,title)"
    ].join(",")
  );
  pgUrl.searchParams.set("workflow_stage", "not.is.null");
  pgUrl.searchParams.set("current_approver_emails", "neq.{}");
  // Drop submissions on ARCHIVED forms. An archived form takes no new
  // submissions, so anything still in flight on one is almost always
  // abandoned -- and unlike real work it never ages out, so it would appear in
  // the same inbox every morning forever, getting older. A digest whose first
  // line is stale is a digest people stop opening.
  //
  // Filters the PARENT rows only because the embed above is `forms!inner`; on
  // a left embed PostgREST would null the embedded object and keep the row.
  // Alias-prefixed embedded filters are the established pattern here -- see
  // listForms' `submissions.location_code` in db/admin-forms.ts.
  //
  // neq.archived rather than eq.published so a form in any other state keeps
  // nagging its approvers: the intent is "stop chasing retired forms", not
  // "only chase published ones".
  pgUrl.searchParams.set("form.status", "neq.archived");
  pgUrl.searchParams.set("order", "submitted_at.asc");
  pgUrl.searchParams.set("limit", String(DIGEST_LIMIT_ROWS));

  let rows: DigestRow[] = [];
  try {
    const resp = await fetch(pgUrl.toString(), {
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
      }
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      errors.push(`Supabase query failed: ${resp.status} ${errText}`);
      console.error("[forms.approval-digest] supabase fetch failed", resp.status);
      return result;
    }
    rows = (await resp.json().catch(() => [])) as DigestRow[];
  } catch (err) {
    errors.push(`Supabase query threw: ${String(err)}`);
    console.error("[forms.approval-digest] supabase fetch threw", err);
    return result;
  }

  result.rowsScanned = rows.length;

  // Group rows by approver email.
  //
  // Inner Map keyed by form_id so multiple submissions against the same
  // form roll up to one by_form entry with the oldest submitted_at.
  type FormBucket = {
    form_id: string;
    form_title: string;
    count: number;
    oldest_submitted_at: string;
  };
  const perRecipient = new Map<string, Map<string, FormBucket>>();

  for (const r of rows) {
    if (!r.workflow_stage || !r.form) continue;
    const emails = r.current_approver_emails ?? [];
    if (emails.length === 0) continue;

    for (const rawEmail of emails) {
      if (typeof rawEmail !== "string") continue;
      const email = rawEmail.trim().toLowerCase();
      if (!email || !email.includes("@")) continue;

      let formMap = perRecipient.get(email);
      if (!formMap) {
        formMap = new Map();
        perRecipient.set(email, formMap);
      }
      const existing = formMap.get(r.form_id);
      if (existing) {
        existing.count++;
        if (r.submitted_at < existing.oldest_submitted_at) {
          existing.oldest_submitted_at = r.submitted_at;
        }
      } else {
        formMap.set(r.form_id, {
          form_id: r.form_id,
          form_title: r.form.title,
          count: 1,
          oldest_submitted_at: r.submitted_at
        });
      }
    }
  }

  result.recipientsConsidered = perRecipient.size;
  const dashboardUrl = computeDashboardUrl(env);
  // UTC date of THIS run. See the header: this is what makes each day a
  // distinct event to the queue's dedup index.
  const runDate = new Date().toISOString().slice(0, 10);

  for (const [email, formMap] of perRecipient.entries()) {
    const byForm = Array.from(formMap.values()).sort((a, b) =>
      b.count - a.count || a.form_title.localeCompare(b.form_title)
    );
    const totalPending = byForm.reduce((acc, f) => acc + f.count, 0);
    if (totalPending === 0) continue;

    try {
      const rendered = renderApprovalDigest({
        byForm,
        totalPending,
        dashboardUrl
      });
      const res = await enqueueOutboundEmail(env, {
        source_worker: "forms",
        source_kind: "forms-approval-digest",
        source_id: runDate,
        recipient: email,
        subject: rendered.subject,
        body_html: rendered.html,
        body_text: rendered.plainText,
        attachments: []
      });
      if (res.was_duplicate) {
        result.recipientsDuplicate++;
      } else {
        result.recipientsFired++;
      }
    } catch (err) {
      result.recipientsFailed++;
      errors.push(`enqueue for ${email} threw: ${String(err)}`);
      console.error("[forms.approval-digest] enqueue threw", email, err);
    }
  }

  console.log("[forms.approval-digest] complete", {
    rowsScanned: result.rowsScanned,
    recipientsConsidered: result.recipientsConsidered,
    recipientsFired: result.recipientsFired,
    recipientsDuplicate: result.recipientsDuplicate,
    recipientsFailed: result.recipientsFailed,
    errorCount: errors.length
  });
  if (errors.length > 0) {
    console.warn("[forms.approval-digest] errors", errors);
  }
  return result;
}

/**
 * Production dashboard URL the digest emails link to. Cron runs on
 * `splash-forms` which doesn't know its own hostname at runtime, so we
 * hardcode the production apps/web origin here (matches Brief 97's
 * `inferAdminBase` posture for the per-submission webhook fire). Future
 * env-driven override is trivial if needed.
 */
function computeDashboardUrl(_env: Env): string {
  return DASHBOARD_URL_DEFAULT;
}
