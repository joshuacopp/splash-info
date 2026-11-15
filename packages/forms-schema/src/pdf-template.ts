// PDF templates (2026-11-14, PLAN_FORMS_PDF_TEMPLATES.md) -- fill an uploaded
// PDF from a form, the way JotForm does: the admin uploads the blank document
// on the builder's Documents tab, drags boxes onto its pages and says what
// goes in each one; an email step attaches the filled copy.
//
// SELF-CONTAINED like digest.ts (no relative imports) so apps/web can import
// runtime values through `@splash/forms-schema/pdf-template`.
//
// COORDINATES are PDF points (1/72 inch) measured from the TOP-LEFT of the
// page, x right and y down -- the same way the builder draws them on screen,
// so the builder never converts. The filler flips y for pdf-lib, whose origin
// is bottom-left. Storing points (not pixels) makes the output independent of
// the admin's screen size and zoom.

import { z } from "zod";

/** Where a box's content comes from. */
export type PdfBoxSource =
  /** A form answer. Text for most fields; an image for signature / photo fields. */
  | { type: "field"; key: string }
  /** A tick (X) when the answer to `key` is `value` (or, for checkboxes, includes it). */
  | { type: "check"; key: string; value: string }
  /**
   * Something captured when someone acted on an approval step: who (`by`,
   * their email), when (`date`), their drawn `signature`, the `typed_name`
   * they entered, or their `note`. The latest action on that step wins.
   */
  | { type: "stage"; stage: string; part: "by" | "date" | "signature" | "typed_name" | "note" }
  | { type: "submitted_date" }
  | { type: "submission_id" }
  /** Fixed text, typed in the builder. */
  | { type: "text"; text: string };

export interface PdfBox {
  id: string;
  /** 0-based page index. */
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  source: PdfBoxSource;
  /** Points. Unset = fit to the box height (single line) / 10pt (wrapping). */
  font_size?: number;
  align?: "left" | "center" | "right";
  /** Wrap onto several lines inside the box instead of shrinking to one line. */
  multiline?: boolean;
  /** Wrapping text only: points from one line to the next. Set it to the gap
   *  between a paper form's ruled lines so the text sits on them. Unset =
   *  1.2 x the font size. */
  line_height?: number;
}

export interface PdfTemplatePage {
  w: number;
  h: number;
}

/** A row of public.form_pdf_templates as the admin API returns it. */
export interface PdfTemplate {
  id: string;
  form_id: string;
  name: string;
  pages: PdfTemplatePage[];
  boxes: PdfBox[];
  created_at: string;
  updated_at: string;
}

export const PDF_TEMPLATE_LIMITS = { bytes: 10 * 1024 * 1024, pages: 30, boxes: 300 } as const;

const sourceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("field"), key: z.string().min(1) }).strict(),
  z.object({ type: z.literal("check"), key: z.string().min(1), value: z.string() }).strict(),
  z
    .object({
      type: z.literal("stage"),
      stage: z.string().min(1),
      part: z.enum(["by", "date", "signature", "typed_name", "note"])
    })
    .strict(),
  z.object({ type: z.literal("submitted_date") }).strict(),
  z.object({ type: z.literal("submission_id") }).strict(),
  z.object({ type: z.literal("text"), text: z.string().max(500) }).strict()
]);

export const pdfBoxSchema = z
  .object({
    id: z.string().min(1).max(40),
    page: z.number().int().min(0),
    x: z.number().min(0),
    y: z.number().min(0),
    w: z.number().positive(),
    h: z.number().positive(),
    source: sourceSchema,
    font_size: z.number().min(4).max(72).optional(),
    align: z.enum(["left", "center", "right"]).optional(),
    multiline: z.boolean().optional(),
    line_height: z.number().min(4).max(100).optional()
  })
  .strict();

export const pdfBoxesSchema = z.array(pdfBoxSchema).max(PDF_TEMPLATE_LIMITS.boxes);

/** Does this source draw an image, a tick, or text? */
export function boxKind(source: PdfBoxSource, fieldType?: string): "text" | "check" | "image" {
  if (source.type === "check") return "check";
  if (source.type === "stage" && source.part === "signature") return "image";
  if (source.type === "field" && (fieldType === "signature" || fieldType === "file")) return "image";
  return "text";
}
