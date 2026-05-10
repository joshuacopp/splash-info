// Brief 97 — fire FORMS_SUBMISSION_WEBHOOK_URL after a successful submit.
//
// Posture mirrors damage-worker's CUSTOMER_CLAIM_WEBHOOK_URL (Brief 32 / 48):
//   - Worker-level secret. Single endpoint; Power Automate routes downstream
//     by `form.id` / `form.slug`. v1 doesn't accept per-form operator-typed
//     URLs (Decision 6 — explicit security deferral).
//   - Per-form opt-out via `forms.notify_webhook = false`.
//   - Files-by-URL in payload (NOT base64-when-small per Decision 6
//     confirmation): each file/signature entry carries a `download_url`
//     pointing at `/forms/admin/api/files/{r2_key}` (Brief 92 admin-gated
//     serve route). PA fetches via the URL when needed; saves us from the
//     >3MB base64 cap pain that hit damage-worker.
//   - 15s AbortController timeout. Fail-soft — submission is already
//     persisted by the time this fires; failure logs `[forms.webhook]`
//     prefix and does NOT roll back.
//   - Caller invokes via `ctx.waitUntil` so the worker stays alive long
//     enough to complete the POST after the response is returned to the
//     browser.

import type { FormMeta, FormVersion } from "@splash/forms-schema";
import type { Env } from "../index.js";
import type { SubmissionRow } from "../db/forms.js";

export interface WebhookFile {
  field_key: string;
  r2_key: string;
  mime: string;
  size_bytes: number;
  download_url: string;
}

export async function fireSubmissionWebhook(args: {
  env: Env;
  reqOrigin: string;
  form: FormMeta;
  version: FormVersion;
  submission: SubmissionRow;
  files: WebhookFile[];
}): Promise<void> {
  const { env, reqOrigin, form, version, submission, files } = args;

  if (!env.FORMS_SUBMISSION_WEBHOOK_URL) return;       // unbound → fail-soft skip
  if (!form.notifyWebhook) return;                      // per-form opt-out → skip

  const adminBase = inferAdminBase(reqOrigin);

  const payload = {
    form: {
      id: form.id,
      slug: form.slug,
      title: form.title,
      version_number: version.versionNumber
    },
    submission: {
      id: submission.id,
      submitted_at: submission.submittedAt,
      submitter_kind: submission.submitterKind,
      submitter_email: submission.submitterEmail,
      submitter_user_id: submission.submitterUserId,
      submitter_ip: submission.submitterIp,
      splash_admin_url: `${adminBase}/admin/forms/${form.id}/submissions/${submission.id}`
    },
    payload: submission.payload,
    files
  };

  try {
    const res = await fetch(env.FORMS_SUBMISSION_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) {
      console.warn(
        `[forms.webhook] non-2xx response: ${res.status}`,
        { formId: form.id, submissionId: submission.id }
      );
    }
  } catch (e) {
    console.warn("[forms.webhook] fire failed (fail-soft)", {
      formId: form.id,
      submissionId: submission.id,
      error: String(e)
    });
  }
}

function inferAdminBase(reqOrigin: string): string {
  // workers.dev / staging hostnames don't host the apps/web admin UI.
  // The webhook payload's `splash_admin_url` is consumed by Power
  // Automate templates that operators click from email — those links
  // need to land on the production apps/web origin to actually work.
  // Acceptable tradeoff for v1 (re-evaluate if we add a staging
  // PA flow that needs to link back to staging admin).
  if (reqOrigin.includes("workers.dev")) return "https://splashcarwashes.info";
  if (reqOrigin.includes("staging.splashcarwashes.info")) return reqOrigin;
  return reqOrigin;
}
