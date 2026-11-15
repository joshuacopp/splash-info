// Fill an uploaded PDF template from a submission (PLAN_FORMS_PDF_TEMPLATES.md).
//
// Draws each box's content onto the template's pages with pdf-lib -- text,
// a tick, or an image -- rather than filling AcroForm fields, so it works on
// any PDF, including a Word document saved as PDF or a scanned paper form.
//
// Boxes are stored top-left-origin in PDF points (pdf-template.ts); pdf-lib's
// origin is bottom-left, so y is flipped here and only here.
//
// FAIL-SOFT PER BOX: a box whose value is missing is left blank, and an image
// that cannot be loaded is skipped with a log line. One bad box never stops
// the document -- a payroll email with one blank box beats no document.

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import {
  boxKind,
  type Field,
  type PdfBox,
  type PdfBoxSource,
  type WorkflowHistoryEntry
} from "@splash/forms-schema";
import { fetchAndEmbedR2Image, sanitizeForWinAnsi, wrapText, type R2Like } from "../pdf/layout-utils.js";

export interface FillContext {
  fields: Field[];
  payload: Record<string, unknown>;
  history: WorkflowHistoryEntry[];
  submissionId: string;
  submittedAt: string;
}

const INK = rgb(0.05, 0.05, 0.1);

// --- values ------------------------------------------------------------------------

function fieldOf(ctx: FillContext, key: string): Field | undefined {
  return ctx.fields.find((f) => f.key === key);
}

function optionsOf(f: Field | undefined): { label: string; value: string }[] {
  const o = (f as { options?: { label: string; value: string }[] } | undefined)?.options;
  return Array.isArray(o) ? o : [];
}

/** 2026-11-14 -> 11/14/2026; anything else unchanged. */
function usDate(s: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? `${m[2]}/${m[3]}/${m[1]}` : s;
}

/** An ISO instant as an Eastern calendar date, 11/14/2026. */
function easternDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "2-digit",
    day: "2-digit",
    year: "numeric"
  }).format(d);
}

/** One-line text for a form answer, as a person would write it on paper. */
export function answerText(ctx: FillContext, key: string): string {
  const f = fieldOf(ctx, key);
  const v = ctx.payload[key];
  if (v == null || v === "") return "";
  const opts = optionsOf(f);
  const label = (x: string) => opts.find((o) => o.value === x)?.label ?? x;
  if (Array.isArray(v)) return v.map((x) => (typeof x === "string" ? label(x) : "")).filter(Boolean).join(", ");
  if (typeof v === "string") {
    if (opts.length) return label(v);
    if (f?.type === "date") return usDate(v);
    return v;
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "object") {
    const name = (v as { name?: unknown }).name; // employee picker
    if (typeof name === "string") return name;
  }
  return "";
}

/** The latest human action on an approval step (system advances skipped). */
function stageEntry(ctx: FillContext, stage: string): WorkflowHistoryEntry | undefined {
  for (let i = ctx.history.length - 1; i >= 0; i--) {
    const h = ctx.history[i]!;
    if (h.from === stage && h.actor_email !== "system@forms") return h;
  }
  return undefined;
}

export function sourceText(ctx: FillContext, s: PdfBoxSource): string {
  switch (s.type) {
    case "field":
      return answerText(ctx, s.key);
    case "text":
      return s.text;
    case "submitted_date":
      return easternDate(ctx.submittedAt);
    case "submission_id":
      return ctx.submissionId.slice(0, 8).toUpperCase();
    case "stage": {
      const e = stageEntry(ctx, s.stage);
      if (!e) return "";
      if (s.part === "by") return e.typed_name?.trim() || e.actor_email;
      if (s.part === "date") return easternDate(e.at);
      if (s.part === "typed_name") return e.typed_name ?? "";
      if (s.part === "note") return e.note ?? "";
      return "";
    }
    case "check":
      return "";
  }
}

function isChecked(ctx: FillContext, s: Extract<PdfBoxSource, { type: "check" }>): boolean {
  const v = ctx.payload[s.key];
  if (Array.isArray(v)) return v.includes(s.value);
  return typeof v === "string" && v === s.value;
}

function imageKey(ctx: FillContext, s: PdfBoxSource): string | null {
  if (s.type === "stage" && s.part === "signature") return stageEntry(ctx, s.stage)?.signature_r2_key ?? null;
  if (s.type === "field") {
    const v = ctx.payload[s.key];
    const first = Array.isArray(v) ? v[0] : v;
    const k = (first as { r2_key?: unknown } | null)?.r2_key;
    return typeof k === "string" ? k : null;
  }
  return null;
}

// --- drawing -------------------------------------------------------------------------

function drawTextBox(page: PDFPage, font: PDFFont, box: PdfBox, raw: string) {
  const text = sanitizeForWinAnsi(raw).trim();
  if (!text) return;
  const ph = page.getHeight();
  const pad = 2;
  const innerW = Math.max(1, box.w - pad * 2);

  if (box.multiline) {
    let size = box.font_size ?? 10;
    const fixedLineH = box.line_height; // ruled lines: keep the spacing, shrink only the type
    const lh = () => fixedLineH ?? size * 1.2;
    let lines = wrapText(text, font, size, innerW);
    // Shrink until it fits the box height (down to 6pt), then clip.
    while (size > 6 && lines.length * lh() > box.h) {
      size -= 0.5;
      lines = wrapText(text, font, size, innerW);
    }
    const lineH = lh();
    const maxLines = Math.max(1, Math.floor(box.h / lineH));
    lines.slice(0, maxLines).forEach((line, i) => {
      const y = ph - box.y - (i + 1) * lineH + size * 0.25;
      page.drawText(line, { x: alignX(box, font, line, size, pad), y, size, font, color: INK });
    });
    return;
  }

  // Single line: the set size (or one that fills the box height), shrunk to fit the width.
  let size = box.font_size ?? Math.min(12, Math.max(6, box.h * 0.72));
  while (size > 5 && font.widthOfTextAtSize(text, size) > innerW) size -= 0.5;
  const y = ph - box.y - box.h + (box.h - size) / 2 + size * 0.22;
  page.drawText(text, { x: alignX(box, font, text, size, pad), y, size, font, color: INK });
}

function alignX(box: PdfBox, font: PDFFont, text: string, size: number, pad: number): number {
  const w = font.widthOfTextAtSize(text, size);
  if (box.align === "center") return box.x + (box.w - w) / 2;
  if (box.align === "right") return box.x + box.w - pad - w;
  return box.x + pad;
}

function drawTick(page: PDFPage, box: PdfBox) {
  // An X inset from the box edges: reads as "ticked" on any paper form.
  const ph = page.getHeight();
  const inset = Math.min(box.w, box.h) * 0.18;
  const x0 = box.x + inset;
  const x1 = box.x + box.w - inset;
  const yTop = ph - box.y - inset;
  const yBot = ph - box.y - box.h + inset;
  const thickness = Math.max(1, Math.min(box.w, box.h) * 0.1);
  page.drawLine({ start: { x: x0, y: yTop }, end: { x: x1, y: yBot }, thickness, color: INK });
  page.drawLine({ start: { x: x0, y: yBot }, end: { x: x1, y: yTop }, thickness, color: INK });
}

async function drawImageBox(doc: PDFDocument, page: PDFPage, bucket: R2Like, box: PdfBox, key: string) {
  const img = await fetchAndEmbedR2Image(doc, bucket, key);
  const scale = Math.min(box.w / img.width, box.h / img.height);
  const w = img.width * scale;
  const h = img.height * scale;
  const x = box.align === "center" ? box.x + (box.w - w) / 2 : box.align === "right" ? box.x + box.w - w : box.x;
  // Sit the image on the box's bottom edge -- a signature belongs on the line.
  page.drawImage(img, { x, y: page.getHeight() - box.y - box.h, width: w, height: h });
}

export async function fillPdfTemplate(
  templateBytes: Uint8Array,
  boxes: PdfBox[],
  ctx: FillContext,
  bucket: R2Like
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(templateBytes, { ignoreEncryption: true });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = doc.getPages();
  for (const box of boxes) {
    const page = pages[box.page];
    if (!page) continue;
    try {
      const kind = boxKind(box.source, box.source.type === "field" ? fieldOf(ctx, box.source.key)?.type : undefined);
      if (kind === "check") {
        if (box.source.type === "check" && isChecked(ctx, box.source)) drawTick(page, box);
      } else if (kind === "image") {
        const key = imageKey(ctx, box.source);
        if (key) await drawImageBox(doc, page, bucket, box, key);
      } else {
        drawTextBox(page, font, box, sourceText(ctx, box.source));
      }
    } catch (err) {
      console.warn(`[forms.pdf-template] box ${box.id} skipped`, err);
    }
  }
  return doc.save();
}

/** Page sizes of an uploaded PDF, in points. Throws on a PDF pdf-lib cannot read. */
export async function readPageSizes(bytes: Uint8Array): Promise<{ w: number; h: number }[]> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  return doc.getPages().map((p) => ({ w: p.getWidth(), h: p.getHeight() }));
}
