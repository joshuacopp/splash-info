// Brief 129 — public entry point for the completed-form PDF generator.
//
// Layout (top to bottom):
//   1. Navy header band: white-script logo + form title + submission id +
//      submitted-at timestamp (Splash brand, same as Brief 32 damage PDF).
//   2. Metadata grid: submission id / submitted at / submitter / submitter
//      kind / form version / outcome (when reached).
//   3. Form responses: every payload field in schema order, respecting
//      `field.exclude_from_pdf`.
//   4. Approval history (when workflow_history non-empty): one block per
//      transition with from/to, actor, note, typed name, signature image.
//   5. Footer on every page: branding line left + "Page N of M" right.
//
// pdf-lib used programmatically (no AcroForm template). Standard fonts
// only (Helvetica + HelveticaBold) — no custom font embedding overhead.
//
// Returns the PDF bytes as `Uint8Array`. Throws on irrecoverable failure
// (caller catches + fail-soft logs per Brief 32 pattern).

import { PDFDocument } from "pdf-lib";

import type {
  FormSchema,
  SubmissionPayload,
  WorkflowHistoryEntry
} from "@splash/forms-schema";

import { drawFooters } from "./layout-footer.js";
import { drawHeader } from "./layout-header.js";
import { drawMetadata } from "./layout-metadata.js";
import { drawPayload, type LocationPrettyResolver } from "./layout-payload.js";
import { drawWorkflowHistory } from "./layout-workflow-history.js";
import {
  PAGE_HEIGHT,
  PAGE_WIDTH,
  loadFonts,
  type R2Like
} from "./layout-utils.js";

export interface SubmissionRowMeta {
  id: string;
  submittedAt: string;
  submitterKind: "authenticated" | "anonymous";
  submitterEmail: string | null;
  /** Resolved label for the row's current workflow stage. Optional —
   *  when the workflow is mid-flight and there's no outcome yet, this
   *  surfaces as the "Current status" caption beneath the metadata
   *  grid. */
  workflowStageLabel?: string | null;
}

export interface GenerateContext {
  submission: SubmissionRowMeta;
  payload: SubmissionPayload;
  schema: FormSchema;
  formTitle: string;
  formSlug: string;
  formVersionNumber: number | null;
  workflowHistory: WorkflowHistoryEntry[];
  /** Outcome stage label, when the row has reached a terminal outcome. */
  outcomeLabel?: string | null;
  /** ISO 8601 timestamp at which the outcome was reached. */
  outcomeReachedAt?: string | null;
  /** Optional resolver for the `location` field type — maps a
   *  `pricing_simple.location_code` slug to its `location_pretty`. */
  resolveLocationPretty?: LocationPrettyResolver;
}

export async function generateCompletedFormPdf(
  bucket: R2Like,
  ctx: GenerateContext
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const fonts = await loadFonts(doc);

  // Page 1.
  const page1 = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  const cursor = await drawHeader(doc, bucket, fonts, page1, {
    formTitle: ctx.formTitle,
    submissionId: ctx.submission.id,
    submittedAt: ctx.submission.submittedAt
  });

  drawMetadata(doc, cursor, fonts, {
    submission: ctx.submission,
    formVersionNumber: ctx.formVersionNumber,
    outcomeLabel: ctx.outcomeLabel ?? null,
    outcomeReachedAt: ctx.outcomeReachedAt ?? null
  });

  await drawPayload(doc, cursor, fonts, {
    schema: ctx.schema,
    payload: ctx.payload,
    bucket,
    resolveLocationPretty: ctx.resolveLocationPretty
  });

  await drawWorkflowHistory(doc, cursor, fonts, {
    history: ctx.workflowHistory,
    schema: ctx.schema,
    bucket
  });

  // Footer on every page.
  drawFooters(doc, fonts);

  return doc.save();
}

export type { LocationPrettyResolver, R2Like };
