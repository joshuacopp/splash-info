// Brief 121 — Daily Pending Approvals digest cron.
//
// Once-daily scheduled handler (12:00 UTC = 7 AM EDT — fires before damage
// worker's 13:00 UTC summary in Brief 65). Queries every form_submissions
// row with a non-empty `current_approver_emails`, groups by approver
// email + form, fires one POST per recipient to a single PA flow
// (`FORMS_APPROVAL_DIGEST_WEBHOOK_URL`) summarizing all forms with pending
// items for that approver.
//
// Design rationale:
//   - One PA flow for the entire forms feature regardless of how many
//     forms have workflows. Adding a new workflow automatically participates
//     — zero PA work per form.
//   - Daily digest, not per-event. v2 candidate flagged in the brief.
//   - Skip-on-empty: if a distinct approver email's pending count is 0,
//     no POST. (Should be impossible since we filter at query time, but
//     defensive against race conditions.)
//   - Fail-soft per recipient: a single 5xx from PA doesn't halt the rest.
//   - When `FORMS_APPROVAL_DIGEST_WEBHOOK_URL` is unbound, the cron still
//     runs and logs digest counts but skips the POST. Lets the operator
//     verify the data shape before binding the secret.

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

export interface DigestPayload {
  recipient_email: string;
  total_pending: number;
  by_form: DigestPerFormEntry[];
  dashboard_url: string;
}

export interface DigestResult {
  recipientsConsidered: number;
  recipientsFired: number;
  recipientsSkippedNoUrl: number;
  recipientsFailed: number;
  rowsScanned: number;
  errors: string[];
}

export async function runDailyApprovalDigest(env: Env): Promise<DigestResult> {
  const errors: string[] = [];
  const result: DigestResult = {
    recipientsConsidered: 0,
    recipientsFired: 0,
    recipientsSkippedNoUrl: 0,
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
  const webhookUrl = env.FORMS_APPROVAL_DIGEST_WEBHOOK_URL;

  for (const [email, formMap] of perRecipient.entries()) {
    const byForm = Array.from(formMap.values()).sort((a, b) =>
      b.count - a.count || a.form_title.localeCompare(b.form_title)
    );
    const totalPending = byForm.reduce((acc, f) => acc + f.count, 0);
    if (totalPending === 0) continue;

    const payload: DigestPayload = {
      recipient_email: email,
      total_pending: totalPending,
      by_form: byForm,
      dashboard_url: dashboardUrl
    };

    if (!webhookUrl) {
      result.recipientsSkippedNoUrl++;
      console.log(
        `[forms.approval-digest] would-fire (no webhook bound) recipient=${email} total=${totalPending} forms=${byForm.length}`
      );
      continue;
    }

    try {
      const fired = await fireDigestWebhook(webhookUrl, payload);
      if (fired) {
        result.recipientsFired++;
      } else {
        result.recipientsFailed++;
      }
    } catch (err) {
      result.recipientsFailed++;
      errors.push(`POST for ${email} threw: ${String(err)}`);
      console.error("[forms.approval-digest] POST threw", email, err);
    }
  }

  console.log("[forms.approval-digest] complete", {
    rowsScanned: result.rowsScanned,
    recipientsConsidered: result.recipientsConsidered,
    recipientsFired: result.recipientsFired,
    recipientsSkippedNoUrl: result.recipientsSkippedNoUrl,
    recipientsFailed: result.recipientsFailed,
    errorCount: errors.length
  });
  if (errors.length > 0) {
    console.warn("[forms.approval-digest] errors", errors);
  }
  return result;
}

/**
 * Fail-soft fire of one digest POST. Returns true on a 2xx response, false
 * on non-2xx / abort / network error. 15s timeout matches Brief 65 /
 * Brief 101 posture.
 */
async function fireDigestWebhook(
  webhookUrl: string,
  payload: DigestPayload
): Promise<boolean> {
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000)
    });
    if (!res.ok) {
      console.error(
        `[forms.approval-digest] POST non-2xx for ${payload.recipient_email}: status ${res.status}`
      );
      return false;
    }
    return true;
  } catch (err) {
    console.error(
      `[forms.approval-digest] POST error for ${payload.recipient_email}:`,
      err
    );
    return false;
  }
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
