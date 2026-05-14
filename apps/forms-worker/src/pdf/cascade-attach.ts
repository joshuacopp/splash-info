// Brief 129 — generate-or-reuse the completed-form PDF when an email
// step in the cascade has `attach_pdf: true`.
//
// Reuse semantics:
//   - PDF object lives at `form-submission-pdfs/{form_id}/{submission_id}.pdf`
//     in the FORMS_FILES R2 bucket.
//   - Reuse when an existing R2 object's `uploaded` timestamp is AFTER
//     the latest `workflow_history[*].at` timestamp (workflow state has
//     not changed since the PDF was generated).
//   - Otherwise regenerate. Second email step in the same cascade will
//     see the just-written object whose `uploaded` is now newer than
//     every history entry, so it reuses.
//
// Returns an `OutboundEmailAttachment` ready to push onto the enqueue
// payload's `attachments` array, OR `null` when generation failed (caller
// continues enqueuing without the attachment).
//
// 15s timeout on generation (AbortController) — typical generation < 2s,
// pathological cases (large file fields with many image thumbnails) get
// cut off so the transition handler doesn't block.

import type {
  FormSchema,
  SubmissionPayload,
  WorkflowHistoryEntry
} from "@splash/forms-schema";
import type { OutboundEmailAttachment } from "@splash/db-supabase";

import type { Env } from "../index.js";
import {
  generateCompletedFormPdf,
  type GenerateContext,
  type SubmissionRowMeta
} from "./generate.js";
import { filenameSafe, shortId } from "./layout-utils.js";

const GENERATION_TIMEOUT_MS = 15_000;

export interface CascadeAttachContext {
  formId: string;
  formSlug: string;
  formTitle: string;
  formVersionNumber: number | null;
  submission: SubmissionRowMeta;
  payload: SubmissionPayload;
  schema: FormSchema;
  /** Full workflow_history (existing + already-appended cascade entries)
   *  used for the latest-timestamp reuse check. */
  workflowHistory: WorkflowHistoryEntry[];
  outcomeLabel: string | null;
  outcomeReachedAt: string | null;
}

export interface AttachmentResult {
  /** Outbound_emails attachment entry ready to push onto the enqueue
   *  payload's `attachments` array. */
  attachment: OutboundEmailAttachment;
  /** True when the PDF was generated fresh on this call; false when an
   *  existing R2 object was reused. Useful for observability + tests. */
  wasGenerated: boolean;
}

/**
 * Read the existing PDF metadata from R2 if any. Returns null on miss /
 * any throw.
 */
async function readExistingPdfMeta(
  env: Env,
  r2Key: string
): Promise<{ size: number; uploaded: Date } | null> {
  try {
    const head = await env.FORMS_FILES.head(r2Key);
    if (!head) return null;
    return { size: head.size, uploaded: head.uploaded };
  } catch (err) {
    console.warn(`[forms.pdf] head failed for ${r2Key}`, err);
    return null;
  }
}

function latestHistoryAt(history: WorkflowHistoryEntry[]): number {
  let max = 0;
  for (const entry of history) {
    const t = Date.parse(entry.at);
    if (Number.isFinite(t) && t > max) max = t;
  }
  return max;
}

async function generateWithTimeout(
  env: Env,
  ctx: GenerateContext
): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      console.error(
        `[forms.pdf] generation timeout (>${GENERATION_TIMEOUT_MS}ms) for submission ${ctx.submission.id}`
      );
      resolve(null);
    }, GENERATION_TIMEOUT_MS);
    generateCompletedFormPdf(env.FORMS_FILES, ctx)
      .then((bytes) => {
        clearTimeout(timer);
        resolve(bytes);
      })
      .catch((err) => {
        clearTimeout(timer);
        console.error(
          `[forms.pdf] generation threw for submission ${ctx.submission.id}`,
          err
        );
        resolve(null);
      });
  });
}

/**
 * Idempotent generate-or-reuse. Caller passes the cumulative workflow
 * history (existing + cascade-appended entries) so the reuse check sees
 * the latest state.
 */
export async function generateOrReuseCompletedPdf(
  env: Env,
  ctx: CascadeAttachContext
): Promise<AttachmentResult | null> {
  const r2Key = `form-submission-pdfs/${ctx.formId}/${ctx.submission.id}.pdf`;

  const existing = await readExistingPdfMeta(env, r2Key);
  const latestHistory = latestHistoryAt(ctx.workflowHistory);
  if (existing && existing.uploaded.getTime() > latestHistory) {
    return {
      attachment: {
        filename: `${filenameSafe(ctx.formTitle)}-${shortId(ctx.submission.id)}.pdf`,
        r2_key: r2Key,
        mime: "application/pdf",
        size_bytes: existing.size,
        bucket: "FORMS_FILES"
      },
      wasGenerated: false
    };
  }

  const bytes = await generateWithTimeout(env, {
    submission: ctx.submission,
    payload: ctx.payload,
    schema: ctx.schema,
    formTitle: ctx.formTitle,
    formSlug: ctx.formSlug,
    formVersionNumber: ctx.formVersionNumber,
    workflowHistory: ctx.workflowHistory,
    outcomeLabel: ctx.outcomeLabel,
    outcomeReachedAt: ctx.outcomeReachedAt
  });
  if (!bytes) return null;

  try {
    await env.FORMS_FILES.put(r2Key, bytes, {
      httpMetadata: { contentType: "application/pdf" }
    });
  } catch (err) {
    console.error(`[forms.pdf] R2 write failed for ${r2Key}`, err);
    return null;
  }

  return {
    attachment: {
      filename: `${filenameSafe(ctx.formTitle)}-${shortId(ctx.submission.id)}.pdf`,
      r2_key: r2Key,
      mime: "application/pdf",
      size_bytes: bytes.byteLength,
      bucket: "FORMS_FILES"
    },
    wasGenerated: true
  };
}
