// Brief 129 — metadata grid for the completed-form PDF.
//
// Two-column grid beneath the navy header band:
//   - Submission ID (short uuid prefix)
//   - Submitted at (EST formatted)
//   - Submitter email (— for anonymous)
//   - Submitter kind (authenticated / anonymous)
//   - Form version (vN)
//   - Outcome (when reached) — single full-width row beneath the grid.

import type { PDFDocument } from "pdf-lib";

import type { SubmissionRowMeta } from "./generate.js";
import {
  drawKeyValueGrid,
  drawLabelValue,
  drawSectionHeading,
  drawSpacer,
  formatEst,
  shortId,
  type Cursor,
  type Fonts
} from "./layout-utils.js";

export interface MetadataInput {
  submission: SubmissionRowMeta;
  formVersionNumber: number | null;
  outcomeLabel: string | null;
  outcomeReachedAt: string | null;
}

export function drawMetadata(
  doc: PDFDocument,
  cursor: Cursor,
  fonts: Fonts,
  input: MetadataInput
): void {
  drawSectionHeading(doc, cursor, fonts, "Submission");

  const submitter =
    input.submission.submitterKind === "anonymous"
      ? "Anonymous"
      : input.submission.submitterEmail || "—";
  const version =
    input.formVersionNumber != null ? `v${input.formVersionNumber}` : "—";

  drawKeyValueGrid(doc, cursor, fonts, [
    ["Submission ID", shortId(input.submission.id)],
    ["Submitted", formatEst(input.submission.submittedAt)],
    ["Submitter", submitter],
    [
      "Submitter type",
      input.submission.submitterKind === "authenticated"
        ? "Authenticated"
        : "Anonymous"
    ],
    ["Form version", version],
    [
      "Outcome",
      input.outcomeLabel
        ? `${input.outcomeLabel}${input.outcomeReachedAt ? ` — ${formatEst(input.outcomeReachedAt)}` : ""}`
        : "—"
    ]
  ]);

  drawSpacer(cursor, 6);

  // Workflow stage label as its own field when there's no outcome yet —
  // operators reading the PDF can still see the in-flight status.
  if (!input.outcomeLabel && input.submission.workflowStageLabel) {
    drawLabelValue(
      doc,
      cursor,
      fonts,
      "Current status",
      input.submission.workflowStageLabel
    );
  }
}
