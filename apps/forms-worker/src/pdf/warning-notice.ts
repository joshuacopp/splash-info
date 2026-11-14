// Employee Warning Notice + Notice of Negative Information -- one PDF, two
// documents, Splash-branded, filled from an Employee Warning Notice submission
// (scripts/gen-warning-notice.ts; coupled to its field keys).
//
// 1. EMPLOYEE WARNING NOTICE follows the paper form it replaces (Adams 9050),
//    section for section and in the same order, so managers and HR recognise
//    it: header box -> Violations (ticked boxes) -> Previous Warnings table ->
//    Company Statement -> Employee Statement -> Action Taken -> sign-off
//    (employee, supervisor, refused + witness) -> the paper's medical-record
//    footnote. Added: the written-statement notice CT requires on every
//    documented disciplinary action (CGS 31-128e) -- harmless elsewhere.
// 2. NOTICE OF NEGATIVE INFORMATION is the Splash notice from the Personnel
//    Records Access and Notification Policy, worded as HR wrote it, filled
//    from the write-up: what was added and when, the employee's rights, who
//    issued it, how it was delivered, and the employee's acknowledgement (the
//    same signature as the warning) or "refused to sign".
//
// Stands alone from generate.ts: it is not the generic completed-form PDF, it
// is the document itself. Attached by an email step with
// `attach_warning_notice: true` (workflow-email-step.ts).

import { PDFDocument, type PDFPage } from "pdf-lib";
import type { SubmissionPayload } from "@splash/forms-schema";
import { isEmployeeValue } from "@splash/forms-schema";

import { drawHeader } from "./layout-header.js";
import {
  COLORS,
  CONTENT_WIDTH,
  MARGIN,
  PAGE_HEIGHT,
  PAGE_WIDTH,
  addPageIfNeeded,
  drawFooters,
  drawSectionHeading,
  fetchAndEmbedR2Image,
  loadFonts,
  sanitizeForWinAnsi,
  wrapText,
  type Cursor,
  type Fonts,
  type R2Like
} from "./layout-utils.js";

export const VIOLATIONS: ReadonlyArray<readonly [string, string]> = [
  ["attendance", "Attendance"],
  ["carelessness", "Carelessness"],
  ["conduct", "Conduct"],
  ["insubordination", "Insubordination"],
  ["personal_work", "Personal work"],
  ["refusal_overtime", "Refusal to work overtime"],
  ["safety", "Safety"],
  ["tardiness", "Tardiness"],
  ["unauthorized_absence", "Unauthorized absence"],
  ["work_quality", "Work quality"],
  ["willful_damage", "Willful damage to company property"],
  ["other", "Other"]
];

const RIGHTS_PARAGRAPHS = [
  "You may request a copy of your personnel record by submitting a written request to your immediate Manager. A request made in response to this notice does not count toward your two-requests-per-year limit.",
  "If you disagree with this information, you may discuss it with Human Resources. If an agreement is not reached, you may submit a written statement explaining your position, which will become a permanent part of your personnel record.",
  "The Company prohibits retaliation for exercising these rights."
];

const STATEMENT_NOTICE =
  "If you disagree with this warning, you may submit a written statement explaining your position. It will be kept with this notice in your personnel record.";

// Matches the refusal_attest tick in scripts/gen-warning-notice.ts. A refusal
// is recorded by the supervisor; a witness only when another supervisor was
// present (often nobody else is on site).
const REFUSAL_ATTESTATION =
  "The supervisor confirms they gave the employee this Warning Notice and the Notice of Negative Information, went over them with the employee, and the employee refused to sign.";

const MEDICAL_FOOTNOTE =
  "* If this Employee Warning Notice, after completion, contains information on the medical condition or history of an employee, it must be maintained in a separate medical file and treated as confidential in accordance with applicable law and regulations.";

// --- payload readers ------------------------------------------------------------------

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** "2026-11-14" -> "11/14/2026"; anything else as given. */
function fmtDate(v: unknown): string {
  const s = str(v);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? `${m[2]}/${m[3]}/${m[1]}` : s;
}

function employeeName(p: SubmissionPayload): string {
  const v = p.employee;
  if (isEmployeeValue(v)) return v.name;
  return str(v);
}

function r2KeyOf(v: unknown): string | null {
  if (!v || typeof v !== "object") return null;
  const k = (v as Record<string, unknown>).r2_key;
  return typeof k === "string" && k ? k : null;
}

function violationsOf(p: SubmissionPayload): string[] {
  const v = p.violations;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** "Attendance, Tardiness, Other: left the site without notice" */
export function violationSummary(p: SubmissionPayload): string {
  const picked = violationsOf(p);
  return VIOLATIONS.filter(([v]) => picked.includes(v))
    .map(([v, label]) => (v === "other" && str(p.violation_other) ? `Other: ${str(p.violation_other)}` : label))
    .join(", ");
}

export function deliveryMethod(p: SubmissionPayload): string {
  // copy_delivery is the manager's explicit choice; older submissions (before
  // it existed) fall back to whether an email was given.
  if (str(p.copy_delivery) === "print") return "Hand delivered in a sealed envelope";
  const email = str(p.employee_email);
  return email ? `Email (${email})` : "Hand delivered in a sealed envelope";
}

// --- drawing helpers --------------------------------------------------------------------

function text(page: PDFPage, s: string, x: number, y: number, size: number, font: Fonts["regular"], color = COLORS.text) {
  page.drawText(sanitizeForWinAnsi(s), { x, y, size, font, color });
}

function smallLabel(page: PDFPage, fonts: Fonts, s: string, x: number, y: number) {
  text(page, s.toUpperCase(), x, y, 7, fonts.bold, COLORS.muted);
}

function checkbox(page: PDFPage, fonts: Fonts, x: number, y: number, ticked: boolean) {
  page.drawRectangle({ x, y: y - 2, width: 10, height: 10, borderColor: COLORS.navy, borderWidth: 0.9 });
  if (ticked) text(page, "X", x + 2, y, 9, fonts.bold, COLORS.navy);
}

/** Wrapped paragraph across the content width; flows onto new pages. */
function paragraph(doc: PDFDocument, cursor: Cursor, fonts: Fonts, s: string, size = 10, bold = false, color = COLORS.text) {
  const font = bold ? fonts.bold : fonts.regular;
  const lh = size * 1.35;
  for (const line of wrapText(sanitizeForWinAnsi(s), font, size, CONTENT_WIDTH)) {
    addPageIfNeeded(doc, cursor, lh);
    text(cursor.page, line, MARGIN, cursor.y, size, font, color);
    cursor.y -= lh;
  }
}

/** A boxed block of the writer's text, like the ruled boxes on the paper form. */
function textBox(doc: PDFDocument, cursor: Cursor, fonts: Fonts, body: string, minLines = 3) {
  const size = 10;
  const lh = size * 1.35;
  const lines = wrapText(sanitizeForWinAnsi(body || "-"), fonts.regular, size, CONTENT_WIDTH - 16);
  while (lines.length < minLines) lines.push("");
  // A box that fits on a page moves to the next page whole rather than
  // leaving a sliver (or an empty padding line) behind. Only a statement
  // longer than a page is split, in per-page segments.
  const whole = lines.length * lh + 14;
  if (whole < PAGE_HEIGHT - 2 * MARGIN - 40) addPageIfNeeded(doc, cursor, whole);
  let i = 0;
  while (i < lines.length) {
    addPageIfNeeded(doc, cursor, lh + 12);
    const room = Math.max(1, Math.floor((cursor.y - MARGIN - 12) / lh));
    const chunk = lines.slice(i, i + room);
    const h = chunk.length * lh + 10;
    cursor.page.drawRectangle({
      x: MARGIN,
      y: cursor.y - h + 6,
      width: CONTENT_WIDTH,
      height: h,
      borderColor: COLORS.subtle,
      borderWidth: 1
    });
    let y = cursor.y - 6;
    for (const line of chunk) {
      text(cursor.page, line, MARGIN + 8, y, size, fonts.regular);
      y -= lh;
    }
    cursor.y -= h + 4;
    i += chunk.length;
  }
  cursor.y -= 4;
}

/** A labelled signature line: the image above the rule, name / date beside. */
async function signatureLine(
  doc: PDFDocument,
  cursor: Cursor,
  fonts: Fonts,
  bucket: R2Like,
  opts: { label: string; r2Key: string | null; name?: string; date: string; note?: string }
) {
  const H = 46;
  addPageIfNeeded(doc, cursor, H + 24);
  const page = cursor.page;
  const lineY = cursor.y - H;
  const sigW = 300;
  if (opts.r2Key) {
    try {
      const img = await fetchAndEmbedR2Image(doc, bucket, opts.r2Key);
      const ratio = img.width / img.height;
      let h = H - 4;
      let w = h * ratio;
      if (w > sigW - 10) {
        w = sigW - 10;
        h = w / ratio;
      }
      page.drawImage(img, { x: MARGIN + 4, y: lineY + 2, width: w, height: h });
    } catch (err) {
      console.warn(`[forms.warning-notice] signature failed for ${opts.r2Key}`, err);
      text(page, "(signature unavailable)", MARGIN + 4, lineY + 8, 9, fonts.regular, COLORS.muted);
    }
  } else if (opts.note) {
    text(page, opts.note, MARGIN + 4, lineY + 8, 10, fonts.bold, COLORS.navy);
  }
  page.drawRectangle({ x: MARGIN, y: lineY, width: sigW, height: 0.8, color: COLORS.text });
  page.drawRectangle({ x: MARGIN + sigW + 30, y: lineY, width: CONTENT_WIDTH - sigW - 30, height: 0.8, color: COLORS.text });
  text(page, opts.date, MARGIN + sigW + 34, lineY + 6, 10, fonts.regular);
  const caption = opts.name ? `${opts.label} - ${opts.name}` : opts.label;
  smallLabel(page, fonts, caption, MARGIN, lineY - 10);
  smallLabel(page, fonts, "Date", MARGIN + sigW + 30, lineY - 10);
  cursor.y = lineY - 26;
}

// --- document 1: the warning notice ---------------------------------------------------------

async function drawWarning(doc: PDFDocument, fonts: Fonts, bucket: R2Like, p: SubmissionPayload, meta: Meta) {
  const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  const cursor = await drawHeader(doc, bucket, fonts, page, {
    formTitle: "Employee Warning Notice",
    submissionId: meta.id,
    subtitle: str(p.site_name) || undefined,
    submittedAt: meta.submittedAt
  });

  // Header box: Employee | Warning date / Employee no. | Department | Shift.
  const rowH = 28;
  const box = (x: number, y: number, w: number, label: string, value: string) => {
    cursor.page.drawRectangle({ x, y: y - rowH, width: w, height: rowH, borderColor: COLORS.navy, borderWidth: 0.8 });
    smallLabel(cursor.page, fonts, label, x + 5, y - 9);
    const v = wrapText(sanitizeForWinAnsi(value || ""), fonts.regular, 10.5, w - 10)[0] ?? "";
    text(cursor.page, v, x + 5, y - 22, 10.5, fonts.regular);
  };
  const W = CONTENT_WIDTH;
  let y = cursor.y;
  box(MARGIN, y, W * 0.75, "Employee", employeeName(p));
  box(MARGIN + W * 0.75, y, W * 0.25, "Warning date", fmtDate(p.warning_date));
  y -= rowH;
  box(MARGIN, y, W * 0.3, "Employee no.", str(p.employee_number));
  // Department is the site name, as on the paper / JotForm process (operator,
  // 2026-11-14). A typed `department` wins, for a future 011 / 101 write-up.
  box(MARGIN + W * 0.3, y, W * 0.45, "Department", str(p.department) || str(p.site_name));
  box(MARGIN + W * 0.75, y, W * 0.25, "Shift", str(p.shift));
  cursor.y = y - rowH - 18;

  // Violations: three columns of four, read down, as on the paper form.
  drawSectionHeading(doc, cursor, fonts, "Violations");
  // A row is as tall as its longest label: "Willful damage to company
  // property" and a typed "Other" both wrap, and a fixed row height ran them
  // into the row below.
  const picked = violationsOf(p);
  const colW = W / 3;
  const cells = VIOLATIONS.map(([v, label], i) => {
    const shown = v === "other" && str(p.violation_other) ? `Other: ${str(p.violation_other)}` : label;
    return {
      col: Math.floor(i / 4),
      row: i % 4,
      ticked: picked.includes(v),
      lines: wrapText(sanitizeForWinAnsi(shown), fonts.regular, 9.5, colW - 22).slice(0, 3)
    };
  });
  const rowHeights = [0, 1, 2, 3].map(
    (r) => Math.max(...cells.filter((c) => c.row === r).map((c) => c.lines.length)) * 11 + 7
  );
  addPageIfNeeded(doc, cursor, rowHeights.reduce((a, b) => a + b, 0));
  const top = cursor.y;
  for (const c of cells) {
    const x = MARGIN + c.col * colW;
    const yy = top - rowHeights.slice(0, c.row).reduce((a, b) => a + b, 0);
    checkbox(cursor.page, fonts, x, yy, c.ticked);
    c.lines.forEach((line, k) => text(cursor.page, line, x + 16, yy - k * 11, 9.5, fonts.regular));
  }
  cursor.y = top - rowHeights.reduce((a, b) => a + b, 0) - 8;

  // Previous warnings.
  drawSectionHeading(doc, cursor, fonts, "Previous Warnings");
  const count = Number(str(p.prior_count)) || 0;
  const cols = [
    { h: "Warning #", w: 70 },
    { h: "Date", w: 120 },
    { h: "Oral", w: 80 },
    { h: "Written", w: 80 },
    { h: "Signed", w: W - 350 }
  ];
  addPageIfNeeded(doc, cursor, 18 * 4 + 10);
  let x = MARGIN;
  cursor.page.drawRectangle({ x: MARGIN, y: cursor.y - 5, width: W, height: 17, color: COLORS.navy });
  for (const c of cols) {
    text(cursor.page, c.h.toUpperCase(), x + 6, cursor.y, 8, fonts.bold, COLORS.white);
    x += c.w;
  }
  cursor.y -= 18;
  for (const n of [1, 2, 3]) {
    const has = n <= count;
    const type = has ? str(p[`prior${n}_type`]) : "";
    const signed = has ? str(p[`prior${n}_signed`]) : "";
    const cells = [
      String(n),
      has ? fmtDate(p[`prior${n}_date`]) : "",
      type === "oral" ? "X" : "",
      type === "written" ? "X" : "",
      signed ? signed.charAt(0).toUpperCase() + signed.slice(1) : ""
    ];
    cursor.page.drawRectangle({ x: MARGIN, y: cursor.y - 5, width: W, height: 18, borderColor: COLORS.subtle, borderWidth: 0.8 });
    x = MARGIN;
    cells.forEach((c, i) => {
      text(cursor.page, c, x + 6, cursor.y, 10, i === 2 || i === 3 ? fonts.bold : fonts.regular);
      x += cols[i]!.w;
    });
    cursor.y -= 18;
  }
  if (count === 0) {
    cursor.y -= 2;
    text(cursor.page, "No previous warnings.", MARGIN, cursor.y, 9, fonts.regular, COLORS.muted);
    cursor.y -= 12;
  }
  cursor.y -= 10;

  // Company statement, signed by the supervisor.
  drawSectionHeading(doc, cursor, fonts, "Company Statement");
  textBox(doc, cursor, fonts, str(p.company_statement), 4);
  const supervisor = [str(p.supervisor_name), str(p.supervisor_title)].filter(Boolean).join(", ");
  await signatureLine(doc, cursor, fonts, bucket, {
    label: "Signed",
    name: supervisor,
    r2Key: r2KeyOf(p.supervisor_signature),
    date: fmtDate(p.warning_date)
  });

  // Employee statement.
  drawSectionHeading(doc, cursor, fonts, "Employee Statement");
  const resp = str(p.employee_response);
  addPageIfNeeded(doc, cursor, 40);
  checkbox(cursor.page, fonts, MARGIN, cursor.y, resp === "agree");
  text(cursor.page, "I agree with Company Statement.", MARGIN + 16, cursor.y, 10, fonts.regular);
  cursor.y -= 16;
  checkbox(cursor.page, fonts, MARGIN, cursor.y, resp === "disagree");
  text(cursor.page, "I disagree with Company Statement.", MARGIN + 16, cursor.y, 10, fonts.regular);
  cursor.y -= 18;
  addPageIfNeeded(doc, cursor, 60); // keep the label with its box
  smallLabel(cursor.page, fonts, "Reasons", MARGIN, cursor.y);
  cursor.y -= 10;
  textBox(
    doc,
    cursor,
    fonts,
    resp === "refused"
      ? ["Employee refused to sign.", str(p.refusal_notes) && `Employee said: ${str(p.refusal_notes)}`].filter(Boolean).join("\n")
      : str(p.employee_reasons),
    2
  );

  // Action taken.
  drawSectionHeading(doc, cursor, fonts, "Action Taken");
  textBox(doc, cursor, fonts, str(p.action_taken), 2);

  // Sign-off.
  addPageIfNeeded(doc, cursor, 200);
  paragraph(doc, cursor, fonts, "I have read this Warning Notice and understand it.", 10, true);
  cursor.y -= 4;
  await signatureLine(doc, cursor, fonts, bucket, {
    label: "Employee's signature",
    name: employeeName(p),
    r2Key: resp === "refused" ? null : r2KeyOf(p.employee_signature),
    note: resp === "refused" ? "REFUSED TO SIGN" : undefined,
    date: resp === "refused" ? "" : fmtDate(p.warning_date)
  });
  await signatureLine(doc, cursor, fonts, bucket, {
    label: "Supervisor",
    name: supervisor,
    r2Key: r2KeyOf(p.supervisor_signature),
    date: fmtDate(p.warning_date)
  });
  addPageIfNeeded(doc, cursor, 20);
  checkbox(cursor.page, fonts, MARGIN, cursor.y, resp === "refused");
  text(cursor.page, "This form was refused by Employee", MARGIN + 16, cursor.y, 10, fonts.regular);
  cursor.y -= 16;
  if (resp === "refused") await drawRefusal(doc, cursor, fonts, bucket, p, fmtDate(p.warning_date));

  cursor.y -= 4;
  paragraph(doc, cursor, fonts, STATEMENT_NOTICE, 9, true, COLORS.navy);
  cursor.y -= 4;
  paragraph(doc, cursor, fonts, MEDICAL_FOOTNOTE, 8, false, COLORS.muted);
}

// --- document 2: notice of negative information ----------------------------------------------

async function drawNotice(doc: PDFDocument, fonts: Fonts, bucket: R2Like, p: SubmissionPayload, meta: Meta) {
  const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  const cursor = await drawHeader(doc, bucket, fonts, page, {
    formTitle: "Notice of Negative Information",
    submissionId: meta.id,
    subtitle: str(p.site_name) || undefined,
    submittedAt: meta.submittedAt
  });
  const resp = str(p.employee_response);
  const date = fmtDate(p.warning_date);

  const field = (label: string, value: string) => {
    addPageIfNeeded(doc, cursor, 30);
    smallLabel(cursor.page, fonts, label, MARGIN, cursor.y);
    cursor.y -= 13;
    paragraph(doc, cursor, fonts, value || "-", 11);
    cursor.y -= 6;
  };

  field("Employee name", employeeName(p));
  field("Due date (10 business days of documentation)", `Delivered with the warning notice on ${date}`);
  cursor.y -= 2;
  paragraph(doc, cursor, fonts, "This notice is to inform you that the following information was added to your personnel record:", 10.5, true);
  cursor.y -= 8;
  field("Description of document / information", `Employee Warning Notice - ${violationSummary(p) || "see notice"}`);
  field("Date added to record", date);

  drawSectionHeading(doc, cursor, fonts, "Employee Rights");
  for (const para of RIGHTS_PARAGRAPHS) {
    paragraph(doc, cursor, fonts, para, 10.5);
    cursor.y -= 6;
  }
  cursor.y -= 6;

  field("Issued by (name / title)", [str(p.supervisor_name), str(p.supervisor_title)].filter(Boolean).join(", "));
  field("Method of delivery", deliveryMethod(p));
  field("Employee refused to sign", resp === "refused" ? "Y" : "N");

  await signatureLine(doc, cursor, fonts, bucket, {
    label: "Employee acknowledgment of receipt",
    name: employeeName(p),
    r2Key: resp === "refused" ? null : r2KeyOf(p.employee_signature),
    note: resp === "refused" ? "REFUSED TO SIGN" : undefined,
    date
  });
  if (resp === "refused") await drawRefusal(doc, cursor, fonts, bucket, p, date);
}

// The supervisor's attestation, then the witness line only when one was given.
async function drawRefusal(doc: PDFDocument, cursor: Cursor, fonts: Fonts, bucket: R2Like, p: SubmissionPayload, date: string) {
  paragraph(doc, cursor, fonts, REFUSAL_ATTESTATION, 9.5);
  cursor.y -= 6;
  const witnessName = str(p.witness_name);
  const witnessSig = r2KeyOf(p.witness_signature);
  if (witnessName || witnessSig) {
    await signatureLine(doc, cursor, fonts, bucket, { label: "Witness (supervisor)", name: witnessName, r2Key: witnessSig, date });
  } else {
    paragraph(doc, cursor, fonts, "No witness present.", 9.5, false, COLORS.muted);
    cursor.y -= 4;
  }
}

// --- entry point --------------------------------------------------------------------------

interface Meta {
  id: string;
  submittedAt: string;
}

export async function buildWarningNoticePdf(
  bucket: R2Like,
  payload: SubmissionPayload,
  meta: Meta
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle("Employee Warning Notice");
  doc.setAuthor("Splash Car Wash");
  const fonts = await loadFonts(doc);
  await drawWarning(doc, fonts, bucket, payload, meta);
  await drawNotice(doc, fonts, bucket, payload, meta);
  drawFooters(doc, fonts, "Splash Car Wash - Confidential personnel record");
  return doc.save();
}
