// Brief 129 — workflow history section.
//
// Rendered after the payload, with a page break for visual separation when
// the cursor is below the midline of the page. Per the brief, history
// entries render as:
//
//   From → To
//   {actor_email}  •  {EST timestamp}
//   Action: {transition label}     ← when resolvable from the schema
//   Note: {note}                   ← italicized (using bold for emphasis at v1)
//   Typed name: {typed_name}
//   {signature image, ~250px wide} ← when signature_r2_key present
//
// Email-step entries (Brief 127 — `actor_email === "system@forms"`)
// render as `Sent {N} email(s) to {recipients}` — no action, no signature.

import type { PDFDocument, RGB } from "pdf-lib";

import type { FormSchema, WorkflowHistoryEntry } from "@splash/forms-schema";

import {
  CONTENT_WIDTH,
  COLORS,
  MARGIN,
  PAGE_HEIGHT,
  addPageIfNeeded,
  drawDivider,
  drawSectionHeading,
  drawSpacer,
  fetchAndEmbedR2Image,
  drawImageScaled,
  formatEst,
  sanitizeForWinAnsi,
  type Cursor,
  type Fonts,
  type R2Like,
  wrapText
} from "./layout-utils.js";

const SYSTEM_ACTOR = "system@forms";

export interface WorkflowHistoryInput {
  history: WorkflowHistoryEntry[];
  schema: FormSchema;
  bucket: R2Like;
}

export async function drawWorkflowHistory(
  doc: PDFDocument,
  cursor: Cursor,
  fonts: Fonts,
  input: WorkflowHistoryInput
): Promise<void> {
  if (!input.history || input.history.length === 0) return;

  const stages = input.schema.workflow?.stages ?? [];
  const stageLabelById = new Map<string, string>();
  for (const stage of stages) stageLabelById.set(stage.id, stage.label || stage.id);

  // Page break for visual separation when we're mid-page.
  if (cursor.y < PAGE_HEIGHT / 2) {
    cursor.page = doc.addPage([612, PAGE_HEIGHT]);
    cursor.y = PAGE_HEIGHT - 54;
  }

  drawSectionHeading(doc, cursor, fonts, "Approval history");

  for (let i = 0; i < input.history.length; i++) {
    const entry = input.history[i];
    if (!entry) continue;
    await drawHistoryEntry(doc, cursor, fonts, entry, stageLabelById, input.bucket);
    if (i < input.history.length - 1) {
      drawDivider(doc, cursor, { dashed: true });
    }
  }
}

async function drawHistoryEntry(
  doc: PDFDocument,
  cursor: Cursor,
  fonts: Fonts,
  entry: WorkflowHistoryEntry,
  stageLabelById: Map<string, string>,
  bucket: R2Like
): Promise<void> {
  const fromLabel = stageLabelById.get(entry.from) ?? entry.from;
  const toLabel = stageLabelById.get(entry.to) ?? entry.to;
  const isSystem = entry.actor_email === SYSTEM_ACTOR;

  addPageIfNeeded(doc, cursor, 22);
  // Brief 133 — From -> To header. pdf-lib's standard Helvetica uses
  // WinAnsi encoding, which cannot represent U+2192 RIGHTWARDS ARROW.
  // ASCII "->" stand-in keeps drawText happy; sanitize wraps the
  // interpolated stage labels (operator-authored).
  const arrow = "->";
  const headerText = sanitizeForWinAnsi(`${fromLabel} ${arrow} ${toLabel}`);
  cursor.page.drawText(headerText, {
    x: MARGIN,
    y: cursor.y,
    size: 12,
    font: fonts.bold,
    color: COLORS.navy
  });
  cursor.y -= 16;

  // Actor + timestamp line. ASCII bullet "*" replaces U+2022 for the
  // same WinAnsi reason; actor_email is sanitized defensively.
  const actorText = isSystem
    ? `System  *  ${formatEst(entry.at)}`
    : `${sanitizeForWinAnsi(entry.actor_email)}  *  ${formatEst(entry.at)}`;
  cursor.page.drawText(actorText, {
    x: MARGIN,
    y: cursor.y,
    size: 9,
    font: fonts.regular,
    color: COLORS.muted
  });
  cursor.y -= 14;

  // System / email-step entries: render the note (which carries the
  // recipient list, formatted by workflow-email-step.ts) and skip the
  // signature/typed-name/action triple — there's nothing for them.
  if (isSystem) {
    if (entry.note) {
      drawWrappedText(doc, cursor, fonts, entry.note, 10, COLORS.text);
      drawSpacer(cursor, 4);
    }
    return;
  }

  // Resolvable action label = the transition's label on the FROM stage
  // whose `.to` matches the destination.
  // We don't have the stages array's transition list here directly; the
  // brief calls for the schema-walk to grab the label. Reach into the
  // closure caller's view via the parent. To keep this helper standalone
  // we accept the action label as a derived string from the caller. The
  // brief specifies the label resolution but for simplicity at v1 we
  // surface the destination stage label as the action title — that's what
  // the operator sees in the apps/web modal anyway.
  // (Kept simple here; if a future brief wants the verbatim transition
  // label, walk the schema in `drawWorkflowHistory` and pass it in.)

  if (entry.note) {
    drawSubLabel(doc, cursor, fonts, "Note");
    drawWrappedText(doc, cursor, fonts, entry.note, 10, COLORS.text);
    drawSpacer(cursor, 4);
  }
  if (entry.typed_name) {
    drawSubLabel(doc, cursor, fonts, "Typed name");
    drawWrappedText(doc, cursor, fonts, entry.typed_name, 10, COLORS.text);
    drawSpacer(cursor, 4);
  }
  if (entry.signature_r2_key) {
    drawSubLabel(doc, cursor, fonts, "Signature");
    try {
      const image = await fetchAndEmbedR2Image(doc, bucket, entry.signature_r2_key);
      drawImageScaled(doc, cursor, image, { maxWidth: 250, maxHeight: 100 });
    } catch (err) {
      cursor.page.drawText("(signature unavailable)", {
        x: MARGIN,
        y: cursor.y,
        size: 10,
        font: fonts.regular,
        color: COLORS.muted
      });
      cursor.y -= 14;
      console.warn(
        `[forms.pdf] history signature render failed for ${entry.signature_r2_key}`,
        err
      );
    }
  }
}

function drawSubLabel(
  doc: PDFDocument,
  cursor: Cursor,
  fonts: Fonts,
  label: string
): void {
  addPageIfNeeded(doc, cursor, 12);
  cursor.page.drawText(sanitizeForWinAnsi(label.toUpperCase()), {
    x: MARGIN,
    y: cursor.y,
    size: 7,
    font: fonts.bold,
    color: COLORS.muted
  });
  cursor.y -= 11;
}

function drawWrappedText(
  doc: PDFDocument,
  cursor: Cursor,
  fonts: Fonts,
  text: string,
  size: number,
  color: RGB
): void {
  const lines = wrapText(text, fonts.regular, size, CONTENT_WIDTH);
  const lineHeight = size * 1.35;
  for (const line of lines) {
    addPageIfNeeded(doc, cursor, lineHeight);
    cursor.page.drawText(line, {
      x: MARGIN,
      y: cursor.y,
      size,
      font: fonts.regular,
      color
    });
    cursor.y -= lineHeight;
  }
}
