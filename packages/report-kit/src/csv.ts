// The one CSV writer. RFC 4180: CRLF line endings, fields quoted when they
// contain a quote, comma, CR or LF, quotes doubled. Starts with a UTF-8 BOM so
// Excel opens it as UTF-8 (names with accents otherwise come out garbled).
//
// FORMULA INJECTION: a text cell starting with = + - @ (or tab / CR) is run as
// a formula when the file is opened in Excel. Customer-typed fields (names,
// notes, addresses) reach these exports, so such TEXT cells get a leading
// apostrophe. Numbers are written as numbers and are never prefixed, so a
// negative amount stays -5, not '-5.

import { columnsFor, exportCell, type ReportDef } from "./define";

const NEEDS_QUOTES = /[",\r\n]/;
const FORMULA_START = /^[=+\-@\t\r]/;

export function csvField(v: string | number | boolean | null | undefined): string {
  if (v == null) return "";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  const s = FORMULA_START.test(v) ? `'${v}` : v;
  return NEEDS_QUOTES.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvLine(fields: ReadonlyArray<string | number | boolean | null | undefined>): string {
  return fields.map(csvField).join(",");
}

const BOM = "﻿";

/** Render a report's export columns as a CSV document. */
export function toCsv<Row>(def: ReportDef<Row>, rows: ReadonlyArray<Row>): string {
  const cols = columnsFor(def, "export");
  const lines = [csvLine(cols.map((c) => c.csvLabel ?? c.id))];
  for (const r of rows) lines.push(csvLine(cols.map((c) => exportCell(c, r))));
  return BOM + lines.join("\r\n") + "\r\n";
}

/** Standard download headers. */
export function csvResponseHeaders(filename: string): Record<string, string> {
  return {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${filename.replace(/"/g, "")}"`,
    "Cache-Control": "no-store"
  };
}
