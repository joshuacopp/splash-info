// Checklist tables + corrective actions, for compliance checklists whose paper
// original is a table of Item / Yes / No / Notes.
//
// This is the second of two compact renderers for repetitive questions, and
// they answer different shapes. layout-rating-grid.ts handles a bare run of
// rated items and packs them several per line. This one handles items that
// each carry their OWN notes box, which cannot be packed into columns and
// which the source documents print as a real table.
//
// DETECTED FROM THE SCHEMA, not keyed to a form id. A checklist row is a
// two-option single-choice field optionally followed immediately by a text
// field keyed `{thatKey}_notes`. A run of those becomes a table. That
// convention is the generator's to honour -- see scripts/gen-safety-center.ts,
// which emits exactly that pairing.
//
// The notes field must be ADJACENT and suffixed, not merely present somewhere:
// matching loosely would sweep an unrelated text field into a row and print it
// as the note for a question it has nothing to do with.

import type { PDFDocument } from "pdf-lib";
import type { DropdownOption, Field, FormSchema } from "@splash/forms-schema";

import {
  COLORS,
  CONTENT_WIDTH,
  MARGIN,
  addPageIfNeeded,
  drawSectionHeading,
  drawSpacer,
  drawTable,
  sanitizeForWinAnsi,
  truncateToWidth,
  type Cursor,
  type Fonts
} from "./layout-utils.js";
import { deriveActionItemRows } from "../submit/action-items.js";

/** Below this a table is heavier than the rows it holds. */
const MIN_RUN = 3;
/** Short enough to head a column. "3 - Above Standard" is not. */
const MAX_OPTION_LABEL = 8;

type ChoiceField = Extract<Field, { options: DropdownOption[] }>;

export interface ChecklistRow {
  choice: ChoiceField;
  notes: Field | null;
}

export interface ChecklistRun {
  rows: ChecklistRow[];
  options: DropdownOption[];
  /** Index just past the last field this run consumed, notes included. */
  nextIndex: number;
}

function isSingleChoice(f: Field): f is ChoiceField {
  return f.type === "radio" || f.type === "dropdown";
}

function excluded(f: Field): boolean {
  return Boolean((f as { exclude_from_pdf?: boolean }).exclude_from_pdf);
}

function isNotesFor(f: Field | undefined, choiceKey: string): boolean {
  if (!f) return false;
  if (f.type !== "short_text" && f.type !== "long_text") return false;
  return f.key === `${choiceKey}_notes`;
}

/** Separators are control characters built from char codes, not written as
 *  escapes: an earlier pass put the literal bytes into this file. They are
 *  control characters rather than punctuation because an option whose label or
 *  value contained the separator could otherwise give two different option
 *  sets the same signature, welding unrelated questions into one table. */
const UNIT_SEP = String.fromCharCode(31);
const RECORD_SEP = String.fromCharCode(30);

function signatureOf(options: DropdownOption[]): string {
  return options.map((o) => `${o.value}${UNIT_SEP}${o.label}`).join(RECORD_SEP);
}

function tableEligible(options: DropdownOption[]): boolean {
  return (
    options.length === 2 && options.every((o) => o.label.length <= MAX_OPTION_LABEL)
  );
}

/**
 * The checklist run starting at `start`, or null.
 *
 * Requires at least one row to actually HAVE a notes field. Without that test a
 * plain Yes/No run would match here and lose its compact grid to a table with
 * an empty fourth column.
 */
export function collectChecklistRun(fields: Field[], start: number): ChecklistRun | null {
  const first = fields[start];
  if (!first || !isSingleChoice(first) || excluded(first)) return null;
  if (!tableEligible(first.options)) return null;

  const sig = signatureOf(first.options);
  const rows: ChecklistRow[] = [];
  let i = start;
  while (i < fields.length) {
    const f = fields[i];
    if (!f || !isSingleChoice(f) || excluded(f)) break;
    if (signatureOf(f.options) !== sig) break;
    const next = fields[i + 1];
    const notes = isNotesFor(next, f.key) && !excluded(next!) ? next! : null;
    rows.push({ choice: f, notes });
    i += notes ? 2 : 1;
  }
  if (rows.length < MIN_RUN) return null;
  if (!rows.some((r) => r.notes)) return null;
  return { rows, options: first.options, nextIndex: i };
}

/**
 * A table cell is one line by construction, and WinAnsi cannot encode a
 * newline -- pdf-lib throws on the first one rather than wrapping. A `long_text`
 * notes field can legitimately contain them, so collapse rather than trusting
 * the value's shape. Without this the whole PDF fails, and because generation
 * is fail-soft the only symptom is an email quietly arriving with no
 * attachment.
 */
function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function valueOf(payload: Record<string, unknown>, key: string): string {
  const v = payload[key];
  return typeof v === "string" ? oneLine(v) : "";
}

export function drawChecklistTable(
  doc: PDFDocument,
  cursor: Cursor,
  fonts: Fonts,
  run: ChecklistRun,
  payload: Record<string, unknown>
): void {
  const [optA, optB] = run.options as [DropdownOption, DropdownOption];
  const anyNotes = run.rows.some((r) => r.notes);
  // Notes only earns a column when the run actually has them; otherwise the
  // Item column takes the width back rather than printing a blank strip.
  const itemW = anyNotes ? 232 : 416;
  const markW = 44;
  const notesW = CONTENT_WIDTH - itemW - markW * 2;

  const columns = [
    { header: "Item", width: itemW },
    { header: optA.label, width: markW },
    { header: optB.label, width: markW },
    ...(anyNotes ? [{ header: "Notes", width: notesW }] : [])
  ];

  const body = run.rows.map((r) => {
    const v = valueOf(payload, r.choice.key);
    const cells = [
      oneLine(r.choice.label),
      v === optA.value ? "X" : "",
      v === optB.value ? "X" : ""
    ];
    if (anyNotes) cells.push(r.notes ? valueOf(payload, r.notes.key) : "");
    return cells;
  });

  drawTable(doc, cursor, fonts, columns, body, { fontSize: 9, rowHeight: 17 });
  drawSpacer(cursor, 8);
}

/**
 * Corrective actions, from the ticks in the payload.
 *
 * Built via `deriveActionItemRows`, the SAME function that writes the
 * action_items rows, so the printed record and the site's worklist cannot
 * disagree. Reading the table back from the database instead would print an
 * empty table every time: the PDF is generated inside the email cascade, which
 * runs before the submission row is inserted and long before the action items
 * are written.
 */
export function drawCorrectiveActions(
  doc: PDFDocument,
  cursor: Cursor,
  fonts: Fonts,
  input: {
    schema: FormSchema;
    payload: Record<string, unknown>;
    submittedAt: Date;
    ownerLabel: string;
  }
): void {
  const derived = deriveActionItemRows({
    schema: input.schema,
    payload: input.payload,
    submittedAt: input.submittedAt
  });

  drawSectionHeading(doc, cursor, fonts, "Corrective action items");

  if (derived.length === 0) {
    addPageIfNeeded(doc, cursor, 16);
    cursor.page.drawText("No corrective actions identified.", {
      x: MARGIN,
      y: cursor.y,
      size: 10,
      font: fonts.regular,
      color: COLORS.muted
    });
    cursor.y -= 16;
  } else {
    drawTable(
      doc,
      cursor,
      fonts,
      // Deficiency gets the widest column and the table drops to 8pt, because
      // the longest item labels on a real checklist ("Waterproof Long Gloves
      // (Ninja Operations)") otherwise truncate -- and a compliance record
      // that abbreviates the deficiency is the one column that must not.
      [
        { header: "Deficiency identified", width: 190 },
        { header: "Action required", width: 150 },
        { header: "Owner", width: 60 },
        { header: "Due date", width: CONTENT_WIDTH - 400 }
      ],
      derived.map((r) => [
        oneLine(r.question_label),
        oneLine(r.description),
        input.ownerLabel,
        r.due_date
      ]),
      { fontSize: 8, rowHeight: 16 }
    );
    drawSpacer(cursor, 6);
  }

  const missed = unflaggedNegatives(input.schema, input.payload);
  if (missed.length > 0) {
    // The source checklist's own rule is "any No must be listed under
    // Corrective Action Items". A No with no item raised is the one way this
    // document can be quietly wrong, so it says so on its face rather than
    // leaving a reviewer to cross-check 21 rows by eye.
    addPageIfNeeded(doc, cursor, 26);
    const text =
      `Answered ${missed.length === 1 ? "No" : "No"} without a corrective action: ` +
      missed.join(", ");
    cursor.page.drawText(
      truncateToWidth(sanitizeForWinAnsi(text), fonts.regular, 8.5, CONTENT_WIDTH),
      { x: MARGIN, y: cursor.y, size: 8.5, font: fonts.regular, color: COLORS.amberBorder }
    );
    cursor.y -= 16;
  }
}

/**
 * Labels answered with the SECOND option of a two-option question that did not
 * raise an action item.
 *
 * Second-is-the-bad-one is the same convention layout-rating-grid.ts marks with
 * an X, and it holds for Yes/No, Pass/Fail and OK/Not OK alike. Restricted to
 * two-option fields that are action-item eligible, so an ordinary either/or
 * question is never scolded for being answered.
 */
function unflaggedNegatives(schema: FormSchema, payload: Record<string, unknown>): string[] {
  const raw = payload["_action_items"];
  const ticked = new Set(
    Array.isArray(raw) ? raw.filter((k): k is string => typeof k === "string") : []
  );
  const out: string[] = [];
  for (const f of schema.fields) {
    if (!isSingleChoice(f) || f.options.length !== 2) continue;
    if (!f.action_item_eligible) continue;
    const negative = f.options[1]!.value;
    if (valueOf(payload, f.key) !== negative) continue;
    if (ticked.has(f.key)) continue;
    out.push(f.label);
  }
  return out;
}

/**
 * Best available name for who owns the corrective actions.
 *
 * Action items belong to a SITE in this system -- the site works them, the RM
 * verifies them -- so the site is the honest answer, and the site name is the
 * readable form of it. Falls back to "Site" rather than inventing a person.
 */
export function ownerLabelFor(
  schema: FormSchema,
  payload: Record<string, unknown>
): string {
  for (const f of schema.fields) {
    if (f.type === "location") {
      const v = valueOf(payload, f.key);
      if (v) return v;
    }
    if (f.type === "lookup" && f.sourceColumn === "location_pretty") {
      const v = valueOf(payload, f.key);
      if (v) return v;
    }
  }
  return "Site";
}
