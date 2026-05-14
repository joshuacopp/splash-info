// Brief 129 — main body of the completed-form PDF.
//
// Iterates `schema.fields` in schema order. Per-field-type rendering rules
// match the brief's Phase 1d:
//   - exclude_from_pdf:true → skip entirely (also skips heading fields with
//     the flag set).
//   - image → skip (display-only, no payload value).
//   - heading → render as bold section heading via drawFieldHeading.
//   - text-family (short_text, long_text, name, email, phone, date, time,
//     hidden) → label + wrapped value.
//   - dropdown / radio → label + option label resolution (fall back to raw
//     value).
//   - multi → label + comma-joined values.
//   - location → label + resolved location_pretty when available, else slug.
//   - lookup → label + value + "(resolved from {key field label})".
//   - file → label + each entry's filename + inline thumbnails for image
//     MIMEs (max 3 per file field). Non-image MIMEs render filename + size.
//   - signature → label + the signature image embedded inline ~300px wide.
//
// Empty/null values: render placeholder dash for required fields, skip
// entirely for optional. (Operator can flip required to see "—" cells for
// debugging.)

import type { PDFDocument } from "pdf-lib";

import type {
  Field,
  FormSchema,
  LocationField,
  LookupField,
  SubmissionPayload
} from "@splash/forms-schema";

import {
  CONTENT_WIDTH,
  COLORS,
  MARGIN,
  addPageIfNeeded,
  drawFieldHeading,
  drawLabelValue,
  drawSectionHeading,
  drawSpacer,
  fetchAndEmbedR2Image,
  drawImageScaled,
  sanitizeForWinAnsi,
  truncateToWidth,
  type Cursor,
  type Fonts,
  type R2Like
} from "./layout-utils.js";

/**
 * Optional pretty-label resolver for location_code slugs. The generator
 * threads this through from its caller so the PDF can render the same
 * `location_pretty` the apps/web detail page does.
 */
export type LocationPrettyResolver = (slug: string) => string | undefined;

export interface PayloadInput {
  schema: FormSchema;
  payload: SubmissionPayload;
  bucket: R2Like;
  resolveLocationPretty?: LocationPrettyResolver;
}

export async function drawPayload(
  doc: PDFDocument,
  cursor: Cursor,
  fonts: Fonts,
  input: PayloadInput
): Promise<void> {
  drawSectionHeading(doc, cursor, fonts, "Form responses");

  const fieldLabelById = new Map<string, string>();
  for (const f of input.schema.fields) fieldLabelById.set(f.id, f.label);

  for (const field of input.schema.fields) {
    if (isExcluded(field)) continue;
    if (field.type === "image") continue;
    if (field.type === "heading") {
      drawFieldHeading(doc, cursor, fonts, field.text || field.label, field.level);
      continue;
    }
    const value = input.payload[field.key];
    if (isEmpty(value) && !field.required) continue;

    if (field.type === "signature") {
      await renderSignature(
        doc,
        cursor,
        fonts,
        field.label,
        value,
        input.bucket
      );
      continue;
    }
    if (field.type === "file") {
      await renderFile(doc, cursor, fonts, field.label, value, input.bucket);
      continue;
    }
    if (field.type === "lookup") {
      renderLookup(doc, cursor, fonts, field as LookupField, value, fieldLabelById);
      continue;
    }
    if (field.type === "location") {
      renderLocation(
        doc,
        cursor,
        fonts,
        field as LocationField,
        value,
        input.resolveLocationPretty
      );
      continue;
    }
    if (field.type === "dropdown" || field.type === "multi") {
      renderChoice(doc, cursor, fonts, field, value);
      continue;
    }

    // Default: text-family rendering.
    const text = stringifyScalar(value);
    drawLabelValue(doc, cursor, fonts, field.label, text);
  }
}

function isExcluded(field: Field): boolean {
  return Boolean((field as { exclude_from_pdf?: boolean }).exclude_from_pdf);
}

function isEmpty(value: unknown): boolean {
  if (value == null) return true;
  if (typeof value === "string") return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.r2_key === "string" && obj.r2_key.length > 0) return false;
    return Object.keys(obj).length === 0;
  }
  return false;
}

function stringifyScalar(v: unknown): string {
  if (v == null) return "-";
  if (typeof v === "string") return v || "-";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map((x) => stringifyScalar(x)).join(", ");
  if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    if (typeof obj.r2_key === "string") {
      if (typeof obj.original_filename === "string") return obj.original_filename;
      return String(obj.r2_key);
    }
    try {
      return JSON.stringify(v);
    } catch {
      return "-";
    }
  }
  return String(v);
}

function renderChoice(
  doc: PDFDocument,
  cursor: Cursor,
  fonts: Fonts,
  field: Field,
  value: unknown
): void {
  const options =
    field.type === "dropdown" || field.type === "multi"
      ? field.options
      : [];
  const labelFor = (raw: string) => {
    const match = options.find((o) => o.value === raw);
    return match ? match.label : raw;
  };

  if (Array.isArray(value)) {
    const text = value.map((v) => labelFor(String(v))).join(", ");
    drawLabelValue(doc, cursor, fonts, field.label, text || "-");
    return;
  }
  drawLabelValue(doc, cursor, fonts, field.label, labelFor(String(value ?? "")));
}

function renderLocation(
  doc: PDFDocument,
  cursor: Cursor,
  fonts: Fonts,
  field: LocationField,
  value: unknown,
  resolver: LocationPrettyResolver | undefined
): void {
  const slug = typeof value === "string" ? value : stringifyScalar(value);
  const pretty = resolver ? resolver(slug) : undefined;
  const display = pretty ? `${pretty} (${slug})` : slug;
  drawLabelValue(doc, cursor, fonts, field.label, display);
}

function renderLookup(
  doc: PDFDocument,
  cursor: Cursor,
  fonts: Fonts,
  field: LookupField,
  value: unknown,
  labelById: Map<string, string>
): void {
  const text = stringifyScalar(value);
  const keyLabel = labelById.get(field.keyFieldId);
  const annotated = keyLabel ? `${text} (resolved from ${keyLabel})` : text;
  drawLabelValue(doc, cursor, fonts, field.label, annotated);
}

async function renderSignature(
  doc: PDFDocument,
  cursor: Cursor,
  fonts: Fonts,
  label: string,
  value: unknown,
  bucket: R2Like
): Promise<void> {
  const r2Key = readR2Key(value);
  if (!r2Key) {
    drawLabelValue(doc, cursor, fonts, label, "(no signature)");
    return;
  }
  // Render label first, then the inline image.
  addPageIfNeeded(doc, cursor, 14);
  cursor.page.drawText(sanitizeForWinAnsi(label.toUpperCase()), {
    x: MARGIN,
    y: cursor.y,
    size: 7,
    font: fonts.bold,
    color: COLORS.muted
  });
  cursor.y -= 14;
  try {
    const image = await fetchAndEmbedR2Image(doc, bucket, r2Key);
    drawImageScaled(doc, cursor, image, { maxWidth: 300, maxHeight: 120 });
  } catch (err) {
    cursor.page.drawText("(signature unavailable)", {
      x: MARGIN,
      y: cursor.y,
      size: 10,
      font: fonts.regular,
      color: COLORS.muted
    });
    cursor.y -= 14;
    console.warn(`[forms.pdf] signature render failed for ${r2Key}`, err);
  }
  drawSpacer(cursor, 4);
}

async function renderFile(
  doc: PDFDocument,
  cursor: Cursor,
  fonts: Fonts,
  label: string,
  value: unknown,
  bucket: R2Like
): Promise<void> {
  const entries = Array.isArray(value) ? value : value != null ? [value] : [];
  if (entries.length === 0) {
    drawLabelValue(doc, cursor, fonts, label, "-");
    return;
  }
  addPageIfNeeded(doc, cursor, 14);
  cursor.page.drawText(sanitizeForWinAnsi(label.toUpperCase()), {
    x: MARGIN,
    y: cursor.y,
    size: 7,
    font: fonts.bold,
    color: COLORS.muted
  });
  cursor.y -= 14;

  let thumbnailsRendered = 0;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as Record<string, unknown>;
    const r2Key = typeof obj.r2_key === "string" ? obj.r2_key : null;
    const mime = typeof obj.mime === "string" ? obj.mime : "";
    const name =
      typeof obj.original_filename === "string"
        ? obj.original_filename
        : r2Key
          ? r2Key.split("/").pop() ?? r2Key
          : "(file)";
    const sizeBytes = typeof obj.size_bytes === "number" ? obj.size_bytes : null;

    const isImage = mime.startsWith("image/");
    const nameLine = sizeBytes
      ? `${name}  (${formatBytes(sizeBytes)})`
      : name;
    addPageIfNeeded(doc, cursor, 14);
    cursor.page.drawText(
      truncateToWidth(nameLine, fonts.regular, 11, CONTENT_WIDTH),
      {
        x: MARGIN,
        y: cursor.y,
        size: 11,
        font: fonts.regular,
        color: COLORS.text
      }
    );
    cursor.y -= 14;

    if (isImage && r2Key && thumbnailsRendered < 3) {
      try {
        const image = await fetchAndEmbedR2Image(doc, bucket, r2Key);
        drawImageScaled(doc, cursor, image, { maxWidth: 200, maxHeight: 180 });
        thumbnailsRendered++;
      } catch (err) {
        console.warn(
          `[forms.pdf] file thumbnail render failed for ${r2Key}`,
          err
        );
      }
    }
  }
  drawSpacer(cursor, 4);
}

function readR2Key(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj.r2_key !== "string" || obj.r2_key.length === 0) return null;
  return obj.r2_key;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
